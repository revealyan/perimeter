// Панель git: статус папки сессии через `git status --porcelain=v1 -z --branch` (execFile, без шелла).
// Porcelain всегда даёт пути от корня репозитория — переводим их в пути от папки сессии
// (префикс берём из `git rev-parse --show-prefix`, статус ограничиваем pathspec'ом `.`).

import { execFile } from 'node:child_process';
import path from 'node:path';
import { PanelError } from './errors.js';
import { realRootOf } from './paths.js';

export interface GitFile {
  /** путь относительно папки сессии, разделитель '/' (у неотслеживаемой папки — с '/' на конце) */
  path: string;
  /** статус как в porcelain без пробелов: 'M', 'A', 'D', 'R', 'MM', '??', '!!' … */
  status: string;
  /** сырой двухсимвольный код XY (X — индекс, Y — рабочее дерево) */
  xy: string;
  /** у переименования/копирования — исходный путь (тоже от папки сессии; может начинаться с '../') */
  from?: string;
}

export interface GitStatus {
  /** ветка; null — папка не в git-репозитории; 'HEAD' — detached HEAD */
  branch: string | null;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitFile[];
  /** список обрезан по GIT_FILES_LIMIT */
  truncated?: boolean;
}

export const GIT_TIMEOUT_MS = 5000;
export const GIT_FILES_LIMIT = 5000;

/** Разбор строки ветки без префикса '## '. */
function parseBranch(s: string): Pick<GitStatus, 'branch' | 'detached' | 'upstream' | 'ahead' | 'behind'> {
  for (const p of ['No commits yet on ', 'Initial commit on ']) {
    if (s.startsWith(p)) return { branch: s.slice(p.length) };
  }
  if (s.startsWith('HEAD (no branch)')) return { branch: 'HEAD', detached: true };
  const out: ReturnType<typeof parseBranch> = { branch: null };
  let head = s;
  const track = / \[([^\]]*)\]$/.exec(s);
  if (track) {
    head = s.slice(0, track.index);
    const ahead = /ahead (\d+)/.exec(track[1]!);
    const behind = /behind (\d+)/.exec(track[1]!);
    if (ahead) out.ahead = Number(ahead[1]);
    if (behind) out.behind = Number(behind[1]);
  }
  const dots = head.indexOf('...');
  if (dots >= 0) {
    out.branch = head.slice(0, dots);
    out.upstream = head.slice(dots + 3);
  } else {
    out.branch = head;
  }
  return out;
}

/** Путь от корня репозитория → путь от папки сессии (prefix — вывод --show-prefix, напр. 'packages/x/'). */
function relToPrefix(p: string, prefix: string): string {
  if (!prefix) return p;
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  const trailing = p.endsWith('/') ? '/' : '';
  return path.posix.relative(prefix.replace(/\/$/, ''), p.replace(/\/$/, '')) + trailing;
}

/**
 * Разбор вывода `git status --porcelain=v1 -z --branch`. Записи разделены NUL; у R/C за записью
 * идёт ещё одно поле — исходный путь. Пути в -z не экранируются (пробелы, юникод — как есть).
 */
export function parsePorcelainZ(out: string, prefix = '', limit = GIT_FILES_LIMIT): GitStatus {
  const tokens = out.split('\0');
  let i = 0;
  let head: ReturnType<typeof parseBranch> = { branch: null };
  if (tokens[0]?.startsWith('## ')) {
    head = parseBranch(tokens[0].slice(3));
    i = 1;
  }
  const files: GitFile[] = [];
  let truncated = false;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.length < 4) continue; // хвостовой пустой токен после последнего NUL
    const xy = t.slice(0, 2);
    const p = t.slice(3);
    const renamed = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    const from = renamed ? tokens[++i] : undefined;
    if (files.length >= limit) { truncated = true; continue; }
    files.push({
      path: relToPrefix(p, prefix),
      status: xy === '??' || xy === '!!' ? xy : xy.replace(/ /g, ''),
      xy,
      ...(from !== undefined && from !== '' ? { from: relToPrefix(from, prefix) } : {}),
    });
  }
  return { ...head, files, ...(truncated ? { truncated } : {}) };
}

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; missing: boolean }

function runGit(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile('git', args, {
      timeout: Math.max(1, timeoutMs),
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      // английские сообщения (различаем «не репозиторий»), без локов индекса и без запросов пароля
      env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        timedOut: !!e && e.killed === true,
        missing: !!e && e.code === 'ENOENT',
      });
    });
  });
}

/** Статус git папки сессии. Не репозиторий → { branch: null, files: [] } (не ошибка). */
export async function gitStatus(root: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitStatus & { root: string }> {
  const realRoot = await realRootOf(root);
  const deadline = Date.now() + timeoutMs;
  const fail = (r: RunResult): never => {
    if (r.missing) throw new PanelError('GIT_UNAVAILABLE', 'git не найден в PATH supervisor\'а');
    if (r.timedOut) throw new PanelError('GIT_TIMEOUT', `git не ответил за ${timeoutMs} мс`);
    throw new PanelError('GIT_FAILED', (r.stderr.trim() || `git завершился с кодом ${r.code}`).slice(0, 500));
  };

  const pre = await runGit(['--no-optional-locks', '-C', realRoot, 'rev-parse', '--show-prefix'], deadline - Date.now());
  if (pre.code !== 0) {
    if (!pre.missing && !pre.timedOut && /not a git repository|must be run in a work tree/i.test(pre.stderr)) {
      return { root, branch: null, files: [] };
    }
    return fail(pre);
  }
  const prefix = pre.stdout.trim().replace(/\\/g, '/');

  const st = await runGit(
    ['--no-optional-locks', '-C', realRoot, 'status', '--porcelain=v1', '-z', '--branch', '--', '.'],
    deadline - Date.now(),
  );
  if (st.code !== 0) return fail(st);
  return { root, ...parsePorcelainZ(st.stdout, prefix) };
}
