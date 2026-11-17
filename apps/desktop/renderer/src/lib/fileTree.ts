// Вкладка «Файлы»: пути относительно корня сессии, git-метки файлов и точки на папках,
// поиск по имени среди загруженного, ссылки «Открыть в VS Code», упоминание @путь. Чистые функции.
import type { FsEntry, GitFile } from './panelData';
import type { EnvId } from '../supervisor';

// ─── пути ───────────────────────────────────────────────────────────────────

/** Путь от корня: «a/b» + «c.ts» → «a/b/c.ts»; корень — пустая строка. */
export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentOf(rel: string): string {
  const k = rel.lastIndexOf('/');
  return k < 0 ? '' : rel.slice(0, k);
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Папки-предки: «a/b/c.ts» → [«a», «a/b»]. */
export function ancestors(rel: string): string[] {
  const parts = rel.split('/').filter(Boolean);
  const out: string[] = [];
  for (let k = 1; k < parts.length; k++) out.push(parts.slice(0, k).join('/'));
  return out;
}

/** Папки сначала, затем файлы; имена — по-человечески (file2 < file10), без учёта регистра. */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const da = a.kind === 'dir' ? 0 : 1;
    const db = b.kind === 'dir' ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
  });
}

/** Абсолютный путь файла на машине supervisor'а: разделитель — как у корня. */
export function toAbs(root: string, rel: string): string {
  if (!rel) return root;
  const win = root.includes('\\') && !root.includes('/');
  const sep = win ? '\\' : '/';
  const r = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root;
  return `${r}${sep}${win ? rel.replace(/\//g, '\\') : rel}`;
}

/** Один и тот же файл? Слэши любые; диск Windows — без учёта регистра. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
}

/** Хлебные крошки: «apps/desktop/x.ts» → [«apps», «desktop», «x.ts»]. */
export function crumbs(rel: string): string[] {
  return rel.split('/').filter(Boolean);
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1).replace('.', ',') : Math.round(kb)} КБ`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} МБ`;
}

// ─── git ────────────────────────────────────────────────────────────────────

export type GitTone = 'mod' | 'add' | 'new' | 'del' | 'ren' | 'conflict';
export interface GitMark { code: string; tone: GitTone; label: string }

/** Статус porcelain («M», « M», «MM», «A», «??», «R», «UU», «D») → метка для дерева. */
export function gitMark(status: string): GitMark | null {
  const s = status.trim();
  if (s === '') return null;
  if (s === '??') return { code: '??', tone: 'new', label: 'не в git' };
  if (s === '!!') return null;
  const xy = status.length >= 2 ? status.slice(0, 2) : s;
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return { code: 'U', tone: 'conflict', label: 'конфликт' };
  const c = [...xy].find((ch) => ch !== ' ' && ch !== '.') ?? s[0]!;
  switch (c) {
    case 'A': return { code: 'A', tone: 'add', label: 'добавлен' };
    case 'D': return { code: 'D', tone: 'del', label: 'удалён' };
    case 'R': return { code: 'R', tone: 'ren', label: 'переименован' };
    case 'C': return { code: 'C', tone: 'add', label: 'скопирован' };
    default: return { code: 'M', tone: 'mod', label: 'изменён' };
  }
}

/** Важность метки — для точки на папке (сильнейшая из вложенных). */
const TONE_RANK: Record<GitTone, number> = { conflict: 5, del: 4, mod: 3, ren: 2, add: 1, new: 0 };

export interface GitIndex {
  /** метки файлов по пути от корня */
  files: Map<string, GitMark>;
  /** папки с изменениями внутри → сильнейшая метка */
  dirs: Map<string, GitTone>;
  /** неотслеживаемые папки целиком («?? docs/») */
  untrackedDirs: string[];
  /** изменённые пути (для режима «Изменённые» и поиска), по алфавиту */
  paths: string[];
}

/** Путь из porcelain: кавычки, обратные слэши, «./», переименование «a -> b». */
export function normGitPath(p: string): string {
  let s = p.trim();
  const arrow = s.indexOf(' -> ');
  if (arrow >= 0) s = s.slice(arrow + 4);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1);
  return s.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function gitIndex(list: GitFile[]): GitIndex {
  const files = new Map<string, GitMark>();
  const dirs = new Map<string, GitTone>();
  const untrackedDirs: string[] = [];
  const bump = (dir: string, tone: GitTone) => {
    const cur = dirs.get(dir);
    if (cur === undefined || TONE_RANK[tone] > TONE_RANK[cur]) dirs.set(dir, tone);
  };
  for (const f of list) {
    const m = gitMark(f.status);
    if (!m) continue;
    const raw = normGitPath(f.path);
    const isDir = raw.endsWith('/');
    const path = raw.replace(/\/+$/, '');
    if (!path) continue;
    if (isDir) {
      untrackedDirs.push(path);
      bump(path, m.tone);
    } else files.set(path, m);
    for (const a of ancestors(path)) bump(a, m.tone);
  }
  const paths = [...files.keys(), ...untrackedDirs.map((d) => `${d}/`)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return { files, dirs, untrackedDirs, paths };
}

/** Метка файла: своя или «??» неотслеживаемой папки, в которой он лежит. */
export function markFor(path: string, idx: GitIndex): GitMark | null {
  const own = idx.files.get(path);
  if (own) return own;
  for (const d of idx.untrackedDirs) if (path === d || path.startsWith(`${d}/`)) return { code: '??', tone: 'new', label: 'не в git' };
  return null;
}

/** Точка на папке: внутри есть изменения (или папка сама целиком новая / лежит в новой). */
export function dirTone(dir: string, idx: GitIndex): GitTone | null {
  const own = idx.dirs.get(dir);
  if (own) return own;
  for (const d of idx.untrackedDirs) if (dir.startsWith(`${d}/`)) return 'new';
  return null;
}

// ─── поиск ──────────────────────────────────────────────────────────────────

/** Буквы запроса идут в строке по порядку (fuzzy, как Ctrl+P). */
function subsequence(q: string, s: string): boolean {
  let k = 0;
  for (const ch of s) if (ch === q[k]) k++;
  return k === q.length;
}

/**
 * Поиск файла по имени среди известных путей: имя с начала → имя содержит → путь содержит → буквы по порядку.
 * Со слэшем в запросе сравниваем с полным путём. Регистр не важен.
 */
export function matchFiles(query: string, paths: Iterable<string>, limit = 60): string[] {
  const q = query.trim().toLowerCase().replace(/\\/g, '/');
  if (!q) return [];
  const seen = new Set<string>();
  const scored: Array<{ p: string; score: number }> = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    const lp = p.toLowerCase();
    const name = baseName(lp);
    let score = -1;
    if (q.includes('/')) {
      if (lp.includes(q)) score = 2;
      else if (subsequence(q, lp)) score = 0;
    } else if (name.startsWith(q)) score = 4;
    else if (name.includes(q)) score = 3;
    else if (lp.includes(q)) score = 2;
    else if (subsequence(q, name)) score = 1;
    else if (subsequence(q, lp)) score = 0;
    if (score >= 0) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.length - b.p.length || a.p.localeCompare(b.p));
  return scored.slice(0, limit).map((s) => s.p);
}

// ─── упоминание и редактор ──────────────────────────────────────────────────

/** «@путь» для сообщения агенту; путь с пробелами — в кавычках. */
export function mentionOf(rel: string): string {
  return /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
}

/** Вставка фрагмента в текст в позицию курсора: с пробелами по краям, где их нет. */
export function insertAt(text: string, pos: number, snippet: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(pos, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const trail = after.startsWith(' ') ? '' : ' ';
  const piece = `${lead}${snippet}${trail}`;
  return { text: `${before}${piece}${after}`, caret: before.length + piece.length };
}

export interface RemoteHost { host: string; user?: string; port?: number }

/**
 * Ссылка «Открыть в VS Code»: VPS — Remote SSH (`vscode://vscode-remote/ssh-remote+user@host/abs`),
 * этот компьютер — локальный файл (`vscode://file/C:/…`). null — VPS без данных о хосте.
 */
export function vscodeUrl(env: EnvId, absPath: string, remote: RemoteHost | null): string | null {
  const enc = (p: string) => encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (env === 'local') {
    const p = absPath.replace(/\\/g, '/');
    return `vscode://file/${enc(p.startsWith('/') ? p.slice(1) : p)}`;
  }
  if (!remote?.host) return null;
  const who = `${remote.user ? `${remote.user}@` : ''}${remote.host}${remote.port && remote.port !== 22 ? `:${remote.port}` : ''}`;
  const p = absPath.startsWith('/') ? absPath : `/${absPath}`;
  return `vscode://vscode-remote/ssh-remote+${who}${enc(p)}`;
}
