// «С сервера» в настройках подключения (владелец 2026-11-26: «видеть в настройках, что нужно взять с сервера —
// ключи ssh для гита»): публичные ключи пользователя службы (копировать в GitHub / на другие машины), создать ключ,
// проверить вход в GitHub. Только публичные части — приватный ключ сервер не покидает.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export interface SshKeyInfo {
  /** имя файла в ~/.ssh (без .pub) */
  file: string;
  type: string;
  comment: string;
  /** SHA256:… как у ssh-keygen -l */
  fingerprint: string;
  /** строка открытого ключа целиком — её копируют в GitHub */
  publicKey: string;
  /** приватная часть рядом есть (без неё ключ для входа бесполезен) */
  hasPrivate: boolean;
  /** ssh возьмёт его для github.com (IdentityFile из ssh -G) */
  github: boolean;
}

export interface RunResult { code: number | null; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** Запуск без shell и без исключений на ненулевой код (ssh -T у GitHub всегда выходит с 1). */
export const runCmd: Runner = (cmd, args, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === null ? String(err.message) : '') });
  });
});

/**
 * Ключи хоста GitHub — опубликованные (api.github.com/meta, сверено 26.11: ED25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU,
 * ECDSA SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM). Вслепую ключ хоста не принимаем (StrictHostKeyChecking=yes).
 */
export const GITHUB_HOST_KEYS = [
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
];

/** SHA256-отпечаток открытого ключа (base64 блоба) — как печатает ssh-keygen -l. */
export function fingerprintOf(blobB64: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(blobB64, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/** Строка .pub → части; не ключ — null. */
export function parsePub(line: string): { type: string; blob: string; comment: string } | null {
  const m = /^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/.exec(line.trim());
  return m ? { type: m[1]!, blob: m[2]!, comment: (m[3] ?? '').trim() } : null;
}

/** IdentityFile, которые ssh попробует для хоста (ssh -G), с раскрытым ~. */
export function identityFiles(sshG: string, home: string): string[] {
  return sshG.split(/\r?\n/).map((l) => /^identityfile\s+(.+)$/i.exec(l.trim())?.[1]).filter((x): x is string => !!x)
    .map((p) => p.replace(/^~(?=[/\\])/, home).replace(/^%d(?=[/\\])/, home));
}

const sshDir = (home: string) => join(home, '.ssh');

export async function listKeys(home = homedir(), run: Runner = runCmd): Promise<SshKeyInfo[]> {
  const dir = sshDir(home);
  if (!existsSync(dir)) return [];
  const g = await run('ssh', ['-G', 'github.com'], 5000);
  const ids = new Set(identityFiles(g.stdout, home).map((p) => p.replace(/\\/g, '/')));
  const out: SshKeyInfo[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.pub')).sort()) {
    const p = parsePub(readFileSync(join(dir, f), 'utf8').split(/\r?\n/)[0] ?? '');
    if (!p) continue;
    const file = f.slice(0, -4);
    const priv = join(dir, file);
    const hasPrivate = existsSync(priv);
    out.push({
      file, type: p.type, comment: p.comment, fingerprint: fingerprintOf(p.blob),
      publicKey: `${p.type} ${p.blob}${p.comment ? ` ${p.comment}` : ''}`,
      hasPrivate, github: hasPrivate && ids.has(priv.replace(/\\/g, '/')),
    });
  }
  // первым — тот, что пойдёт в GitHub
  return out.sort((a, b) => Number(b.github) - Number(a.github));
}

/**
 * Новый ключ ed25519 без пароля (агенту вводить пароль некому): ~/.ssh/id_ed25519, если его нет, — его ssh и возьмёт
 * для GitHub без настройки; иначе id_ed25519_perimeter (тогда для GitHub нужен IdentityFile — подсказывает окно).
 */
export async function createKey(home = homedir(), run: Runner = runCmd, host = hostname()): Promise<SshKeyInfo> {
  const dir = sshDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = existsSync(join(dir, 'id_ed25519')) ? 'id_ed25519_perimeter' : 'id_ed25519';
  if (existsSync(join(dir, name))) throw new Error(`ключ ${name} уже есть`);
  const r = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `perimeter@${host}`, '-f', join(dir, name)], 20_000);
  if (r.code !== 0) throw new Error(`ssh-keygen: ${(r.stderr || r.stdout).trim().slice(0, 300) || `код ${String(r.code)}`}`);
  const k = (await listKeys(home, run)).find((x) => x.file === name);
  if (!k) throw new Error('ключ создан, но не читается');
  return k;
}

/** Ответ ssh -T git@github.com → итог проверки. */
export function parseGithubAuth(out: string): { ok: boolean; login?: string; message: string } {
  const hi = /Hi ([^!\s]+)! You've successfully authenticated/.exec(out);
  if (hi) return { ok: true, login: hi[1]!, message: `GitHub пускает: вход как ${hi[1]!}` };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(out)) {
    return { ok: false, message: 'ключ хоста github.com в known_hosts не совпал с опубликованным GitHub — проверьте ~/.ssh/known_hosts (ssh-keygen -R github.com уберёт старую запись)' };
  }
  if (/Permission denied \(publickey\)/i.test(out)) return { ok: false, message: 'GitHub не знает этот ключ — добавьте открытый ключ в GitHub → Settings → SSH keys' };
  if (/Could not resolve|timed out|Connection refused|Network is unreachable/i.test(out)) return { ok: false, message: `нет связи с github.com: ${out.trim().split(/\r?\n/).pop() ?? ''}` };
  return { ok: false, message: out.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300) || 'GitHub не ответил' };
}

/**
 * Проверка входа в GitHub под пользователем службы. github.com нет в known_hosts — дописываем опубликованные ключи
 * хоста (иначе первый git push агента упрётся в вопрос «доверять ли хосту», ответить на который некому).
 */
export async function checkGithub(home = homedir(), run: Runner = runCmd): Promise<{ ok: boolean; login?: string; message: string; hostKeysAdded: boolean }> {
  const dir = sshDir(home);
  const kh = join(dir, 'known_hosts');
  let hostKeysAdded = false;
  const known = existsSync(kh) ? await run('ssh-keygen', ['-F', 'github.com', '-f', kh], 5000) : { code: 1, stdout: '', stderr: '' };
  if (known.code !== 0 || known.stdout.trim() === '') {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const prev = existsSync(kh) ? readFileSync(kh, 'utf8') : '';
    appendFileSync(kh, `${prev && !prev.endsWith('\n') ? '\n' : ''}${GITHUB_HOST_KEYS.join('\n')}\n`, { mode: 0o600 });
    try { chmodSync(kh, 0o600); } catch { /* Windows */ }
    hostKeysAdded = true;
  }
  const r = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', 'git@github.com'], 20_000);
  return { ...parseGithubAuth(`${r.stdout}\n${r.stderr}`), hostKeysAdded };
}
