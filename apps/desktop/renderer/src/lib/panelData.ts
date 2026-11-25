// Разбор ack-данных команд панелей (файлы, git, терминал, порты) — чистые функции.
// Сервер может быть старее клиента: на незнакомую команду он отвечает пустым ack —
// тогда разбор даёт null, и UI пишет «сервер не поддерживает …», а не падает.

export interface FsEntry { name: string; kind: 'file' | 'dir' | 'link'; size: number; mtimeMs: number }
/** truncated — папка большая, отдано начало (total — всего записей) */
export interface FsList { root: string; path: string; entries: FsEntry[]; truncated: boolean; total: number }
export interface FsRead {
  path: string; size: number; truncated: boolean; binary: boolean; content: string;
  /** в какой кодировке прочитан (supervisor определяет: utf-8, windows-1251…); старый supervisor — нет поля */
  encoding?: string;
}
export interface GitFile { path: string; status: string }
export interface GitStatus { root: string; branch: string | null; files: GitFile[] }
export interface PortInfo { port: number; host: string; process?: string }
export type TermMode = 'pty' | 'pipe';
/** cwd — относительно корня сессии ('' — корень) */
export interface TermInfo { termId: string; mode: TermMode; shell: string; cwd: string; alive: boolean; exitCode?: number | null; scrollback?: string }

const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** ack cmd:fs.list → { root, path, entries } */
export function parseFsList(d: unknown): FsList | null {
  const o = asObj(d);
  if (!o || !Array.isArray(o['entries'])) return null;
  const entries: FsEntry[] = [];
  for (const raw of o['entries'] as unknown[]) {
    const e = asObj(raw);
    const name = str(e?.['name']);
    if (!e || name === '' || name === '.' || name === '..') continue;
    const k = e['kind'];
    entries.push({ name, kind: k === 'dir' || k === 'link' ? k : 'file', size: num(e['size']), mtimeMs: num(e['mtimeMs']) });
  }
  return { root: str(o['root']), path: str(o['path']), entries, truncated: o['truncated'] === true, total: num(o['total'], entries.length) };
}

/** ack cmd:fs.read → { path, size, truncated, binary, content } */
export function parseFsRead(d: unknown): FsRead | null {
  const o = asObj(d);
  if (!o || (typeof o['content'] !== 'string' && o['binary'] !== true)) return null;
  const content = str(o['content']);
  return {
    path: str(o['path']),
    size: num(o['size'], content.length),
    truncated: o['truncated'] === true,
    binary: o['binary'] === true,
    content,
    ...(typeof o['encoding'] === 'string' && o['encoding'] ? { encoding: o['encoding'] } : {}),
  };
}

/** Подпись кодировки в шапке просмотра: обычный UTF-8 не подписываем. */
export function encodingLabel(enc: string | undefined): string | null {
  switch (enc) {
    case undefined: case 'utf-8': return null;
    case 'utf-8-bom': return 'UTF-8 с BOM';
    case 'utf-16le': return 'UTF-16 LE';
    case 'utf-16be': return 'UTF-16 BE';
    case 'windows-1251': return 'Windows-1251 (кириллица)';
    case 'windows-1252': return 'Windows-1252';
    default: return enc;
  }
}

/** ack cmd:git.status → { root, branch, files: [{ path, status }] } */
export function parseGitStatus(d: unknown): GitStatus | null {
  const o = asObj(d);
  if (!o || !Array.isArray(o['files'])) return null;
  const files: GitFile[] = [];
  for (const raw of o['files'] as unknown[]) {
    const f = asObj(raw);
    const path = str(f?.['path']);
    if (path) files.push({ path, status: str(f?.['status']) });
  }
  const branch = o['branch'];
  return { root: str(o['root']), branch: typeof branch === 'string' && branch !== '' ? branch : null, files };
}

/** ack cmd:net.ports → { ports: [{ port, host, process? }] } */
export function parseNetPorts(d: unknown): PortInfo[] | null {
  const o = asObj(d);
  if (!o || !Array.isArray(o['ports'])) return null;
  const out: PortInfo[] = [];
  for (const raw of o['ports'] as unknown[]) {
    const p = asObj(raw);
    const port = num(p?.['port'], -1);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const proc = str(p?.['process']);
    out.push({ port, host: str(p?.['host']), ...(proc ? { process: proc } : {}) });
  }
  return out;
}

function termFrom(o: Record<string, unknown> | null): TermInfo | null {
  const termId = str(o?.['termId']);
  if (!o || termId === '') return null;
  const sb = o['scrollback'];
  return {
    termId,
    mode: o['mode'] === 'pipe' ? 'pipe' : 'pty',
    shell: str(o['shell']),
    cwd: str(o['cwd']),
    alive: o['alive'] !== false,
    ...(typeof o['exitCode'] === 'number' || o['exitCode'] === null ? { exitCode: o['exitCode'] as number | null } : {}),
    ...(typeof sb === 'string' ? { scrollback: sb } : {}),
  };
}

/** ack cmd:term.open / cmd:term.attach → { termId, mode, shell, cwd, scrollback? } */
export function parseTermInfo(d: unknown): TermInfo | null {
  return termFrom(asObj(d));
}

/** ack cmd:term.list → { terms: [{ termId, shell, cwd, mode, alive }] } */
export function parseTermList(d: unknown): TermInfo[] | null {
  const o = asObj(d);
  if (!o || !Array.isArray(o['terms'])) return null;
  return (o['terms'] as unknown[]).map((t) => termFrom(asObj(t))).filter((t): t is TermInfo => t !== null);
}

/** Человеческий текст ошибки команды панели (CmdError: code + message). */
export function panelErrorText(e: unknown): string {
  const code = str(asObj(e)?.['code']);
  const msg = e instanceof Error ? e.message : str(asObj(e)?.['message'], String(e));
  switch (code) {
    case 'OFFLINE': return 'нет связи с supervisor';
    case 'TIMEOUT': return 'supervisor не ответил — возможно, его версия не знает эту команду';
    case 'OUTSIDE_ROOT': return 'путь вне папки сессии';
    case 'SESSION_NOT_FOUND': return 'сессия не найдена на сервере';
    case 'NOT_FOUND':
    case 'ENOENT': return 'не найдено';
    case 'SCHEMA': return `сервер отверг команду: ${msg}`;
    default: return msg || code || 'ошибка';
  }
}
