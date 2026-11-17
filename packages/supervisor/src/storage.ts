// Хранилище проектов (макеты P1–P3): корень среды, куда новые проекты создаются по имени; превью и создание
// проекта (пустая папка / клон git / готовая папка); обзор проектов для «Настройки → Проекты».
// git запускается через внедряемый GitRunner — тесты гоняют и подмену, и настоящий git на временных репозиториях.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Запуск git: args без «git»; cwd не обязателен (используем -C); input — stdin (например, `git apply -`). */
export type GitRunner = (args: string[], opts: { timeoutMs: number; cwd?: string; input?: string }) => Promise<GitResult>;

/**
 * Настоящий git. GIT_TERMINAL_PROMPT=0 — никаких запросов пароля (иначе клон по https без доступа висит до таймаута);
 * для ssh — BatchMode, если владелец не задал свой GIT_SSH_COMMAND.
 */
export const realGit: GitRunner = (args, opts) => new Promise((done) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (env['GIT_SSH_COMMAND'] === undefined) env['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
  if (opts.input === undefined) {
    execFile('git', args, {
      env, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      done({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (e && typeof e.code === 'string' ? `${e.code}: ${e.message}` : ''),
        timedOut: e?.killed === true,
      });
    });
    return;
  }
  // с stdin (git apply -): execFile не умеет, поэтому spawn и пишем в stdin сами
  const child = spawn('git', args, { env, windowsHide: true, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) });
  const timer = setTimeout(() => child.kill(), opts.timeoutMs);
  let out = '';
  let errs = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { errs += d.toString('utf8'); });
  child.on('error', (e) => {
    clearTimeout(timer);
    done({ code: null, stdout: out, stderr: errs || e.message, timedOut: false });
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    done({ code: code ?? null, stdout: out, stderr: errs, timedOut: signal !== null });
  });
  child.stdin.on('error', () => undefined); // EPIPE: git умер, не читая stdin — итог придёт в close
  child.stdin.end(opts.input);
});

/** Токены в URL (https://user:token@host) — в сообщениях и логах только «***». */
export function maskUrl(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1***@');
}

/** Похоже на адрес репозитория: https/http, ssh, git, file или scp-вид user@host:path. Без опций git («-…») и пробелов. */
export function validGitUrl(url: string): boolean {
  const u = url.trim();
  if (u === '' || u.startsWith('-') || /\s/.test(u)) return false;
  if (/^(https?|ssh|git|file):\/\//i.test(u)) return true;
  return /^[\w.-]+@[\w.-]+:[^\s]+$/.test(u);
}

/**
 * Один репозиторий в разных записях → одна строка: без учётных данных, порта ssh, «.git» и «/» на конце;
 * https://github.com/o/r.git, git@github.com:o/r и ssh://git@github.com/o/r — это github.com/o/r.
 */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    u = `${scp[1]!.toLowerCase()}/${scp[2]!}`;
  } else {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(u);
    if (m) {
      const scheme = m[1]!.toLowerCase();
      let rest = m[2]!;
      if (scheme === 'file') {
        u = `file:${rest.replace(/\\/g, '/')}`;
      } else {
        rest = rest.replace(/^[^/@]*@/, ''); // учётные данные
        const slash = rest.indexOf('/');
        const host = (slash < 0 ? rest : rest.slice(0, slash)).replace(/:\d+$/, '').toLowerCase();
        u = `${host}${slash < 0 ? '' : rest.slice(slash)}`;
      }
    }
  }
  u = u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return process.platform === 'win32' && u.startsWith('file:') ? u.toLowerCase() : u;
}

export function sameRemote(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

export interface GitInfo { origin: string | null; branch: string | null; head: string | null; changed: number }

export interface DirInfo {
  exists: boolean;
  isDir: boolean;
  empty: boolean;
  /** только если в самой папке есть .git (родительский репозиторий не считается) */
  git?: GitInfo;
}

/** Сведения о git-папке; ошибки git — не ошибки (origin/branch null). */
export async function gitInfo(path: string, git: GitRunner, timeoutMs: number): Promise<GitInfo> {
  const [o, b, h, s] = await Promise.all([
    git(['-C', path, 'remote', 'get-url', 'origin'], { timeoutMs }),
    git(['-C', path, 'symbolic-ref', '--short', 'HEAD'], { timeoutMs }),
    git(['-C', path, 'rev-parse', 'HEAD'], { timeoutMs }),
    git(['-C', path, 'status', '--porcelain'], { timeoutMs }),
  ]);
  const line = (r: GitResult) => (r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] ?? '' : '');
  return {
    origin: line(o) || null,
    branch: line(b) || null,
    // HEAD нужен сверке коммитов при переносе сессии между средами (база патча правок)
    head: line(h) || null,
    changed: s.code === 0 ? s.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length : 0,
  };
}

export async function inspectDir(path: string, git: GitRunner, timeoutMs = 10_000): Promise<DirInfo> {
  let st;
  try { st = statSync(path); } catch { return { exists: false, isDir: false, empty: true }; }
  if (!st.isDirectory()) return { exists: true, isDir: false, empty: false };
  let names: string[] = [];
  try { names = readdirSync(path); } catch { /* нет прав читать — считаем непустой */ names = ['?']; }
  const info: DirInfo = { exists: true, isDir: true, empty: names.length === 0 };
  if (existsSync(join(path, '.git'))) info.git = await gitInfo(path, git, timeoutMs);
  return info;
}

export type ProjectSource = 'empty' | 'git' | 'existing';
export type Plan = 'create' | 'clone' | 'connect' | 'conflict' | 'missing';

/** Что станет с папкой проекта для данного источника. */
export function planFor(source: ProjectSource, info: DirInfo, gitUrl?: string): { plan: Plan; reason?: string; sameOrigin?: boolean } {
  if (info.exists && !info.isDir) return { plan: source === 'existing' ? 'missing' : 'conflict', reason: 'по этому пути файл, а не папка' };
  if (source === 'existing') return info.exists ? { plan: 'connect' } : { plan: 'missing', reason: 'такой папки нет' };
  if (source === 'empty') return info.exists ? { plan: 'connect' } : { plan: 'create' };
  // git
  if (!info.exists || info.empty) return { plan: 'clone' };
  if (!info.git) return { plan: 'conflict', reason: 'папка уже есть и не пуста, но это не git-репозиторий' };
  if (!info.git.origin) return { plan: 'conflict', reason: 'в папке git-репозиторий без origin' };
  const same = gitUrl !== undefined && sameRemote(info.git.origin, gitUrl);
  return same
    ? { plan: 'connect', sameOrigin: true }
    : { plan: 'conflict', sameOrigin: false, reason: `в папке другой репозиторий: ${maskUrl(info.git.origin)}` };
}

/** Путь проекта: свой path или <корень>/<slug>. null — не из чего собрать. */
export function projectPath(root: string, slug: string | undefined, path: string | undefined): string | null {
  if (path !== undefined) return path;
  if (slug !== undefined) return join(root, slug);
  return null;
}

/** Путь внутри корня хранилища (на Windows — без учёта регистра). */
export function insideRoot(root: string, path: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(root), norm(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Свободное место на диске хранилища (если папка есть и statfs доступен). */
export function freeBytes(root: string): number | undefined {
  try {
    const s = statfsSync(root);
    const n = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  } catch {
    return undefined;
  }
}

/** Хвост вывода git для текста ошибки: последние строки, без токенов. */
export function gitTail(r: GitResult, max = 400): string {
  const t = maskUrl((r.stderr || r.stdout).trim());
  return t.length > max ? `…${t.slice(-max)}` : t;
}
