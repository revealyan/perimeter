// Модель вкладки «Файлы» одной сессии: ленивое дерево (fs.list по раскрытию), git-статус,
// открытый файл (fs.read). Живёт вне React — переключение вкладок панели не теряет загруженное;
// раскрытые папки, выбранный файл и режим «Все / Изменённые» — в localStorage по сессии.
import type { SupervisorClient } from './supervisor';
import { panelErrorText, type FsEntry, type FsRead, type GitStatus } from './lib/panelData';
import { ancestors, gitIndex, sortEntries, type GitIndex } from './lib/fileTree';

/** more — сколько записей не отдано (папка больше лимита сервера) */
export interface DirState { status: 'loading' | 'ok' | 'error'; entries: FsEntry[]; error?: string; more?: number }
export interface FileState { path: string; status: 'loading' | 'ok' | 'error'; data?: FsRead; error?: string }
export interface GitState { status: 'idle' | 'loading' | 'ok' | 'error'; data?: GitStatus; idx?: GitIndex; error?: string; code?: string }
export type FilesMode = 'all' | 'changed';

/** Сколько читать за раз: больше — файл помечается «показано начало». */
export const READ_MAX_BYTES = 1_000_000;

const storeKey = (sid: string) => `perimeter:files:${sid}`;

export class FilesModel {
  root: string | null = null;
  dirs = new Map<string, DirState>();
  expanded = new Set<string>();
  git: GitState = { status: 'idle' };
  selected: string | null = null;
  file: FileState | null = null;
  mode: FilesMode = 'all';
  /** растёт на каждое изменение (зависимость мемоизаций в UI) */
  version = 0;
  /** идёт обновление — повторные автообновления не плодим */
  private refreshing = false;
  private fileToken = 0;
  private listeners = new Set<() => void>();
  private started = false;

  constructor(private client: SupervisorClient, readonly sid: string) {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey(sid)) ?? 'null') as { selected?: unknown; expanded?: unknown; mode?: unknown } | null;
      if (raw && typeof raw.selected === 'string') this.selected = raw.selected;
      if (raw && Array.isArray(raw.expanded)) for (const d of raw.expanded) if (typeof d === 'string') this.expanded.add(d);
      if (raw?.mode === 'changed') this.mode = 'changed';
    } catch { /* битое — по умолчанию */ }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  private persist(): void {
    localStorage.setItem(storeKey(this.sid), JSON.stringify({ selected: this.selected, expanded: [...this.expanded], mode: this.mode }));
  }

  /** Первый показ: корень, раскрытые папки, git, выбранный файл. Повторный — тихое обновление. */
  start(): void {
    if (this.started) {
      void this.refresh();
      return;
    }
    this.started = true;
    void this.loadDir('');
    for (const d of this.expanded) void this.loadDir(d);
    void this.loadGit();
    if (this.selected) void this.loadFile(this.selected);
  }

  async loadDir(path: string, silent = false): Promise<void> {
    const prev = this.dirs.get(path);
    if (!silent || !prev) {
      this.dirs.set(path, { status: 'loading', entries: prev?.entries ?? [] });
      this.emit();
    }
    try {
      const r = await this.client.fsList(this.sid, path);
      if (path === '' && r.root) this.root = r.root;
      const more = r.truncated ? Math.max(0, r.total - r.entries.length) : 0;
      // служебная папка git в дереве не нужна (как в VS Code)
      const entries = sortEntries(r.entries.filter((e) => !(e.kind === 'dir' && e.name === '.git')));
      this.dirs.set(path, { status: 'ok', entries, ...(more > 0 ? { more } : {}) });
    } catch (e) {
      // раскрытая папка исчезла — не держим её раскрытой
      if (path !== '' && silent && this.expanded.has(path)) {
        this.expanded.delete(path);
        this.persist();
      }
      this.dirs.set(path, { status: 'error', entries: silent ? prev?.entries ?? [] : [], error: panelErrorText(e) });
    }
    this.emit();
  }

  async loadGit(silent = false): Promise<void> {
    if (!silent || this.git.status !== 'ok') {
      this.git = { ...this.git, status: 'loading' };
      this.emit();
    }
    try {
      const data = await this.client.gitStatus(this.sid);
      this.git = { status: 'ok', data, idx: gitIndex(data.files) };
    } catch (e) {
      const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : '';
      this.git = { status: 'error', error: panelErrorText(e), code };
    }
    this.emit();
  }

  async loadFile(path: string, silent = false): Promise<void> {
    const token = ++this.fileToken;
    const prev = this.file?.path === path ? this.file : null;
    if (!silent || !prev) {
      this.file = { path, status: 'loading', ...(prev?.data ? { data: prev.data } : {}) };
      this.emit();
    }
    try {
      const data = await this.client.fsRead(this.sid, path, READ_MAX_BYTES);
      if (token !== this.fileToken) return;
      this.file = { path, status: 'ok', data };
    } catch (e) {
      if (token !== this.fileToken) return;
      this.file = { path, status: 'error', error: panelErrorText(e) };
    }
    this.emit();
  }

  toggle(dir: string): void {
    if (this.expanded.has(dir)) this.expanded.delete(dir);
    else {
      this.expanded.add(dir);
      const st = this.dirs.get(dir);
      if (!st || st.status === 'error') void this.loadDir(dir);
    }
    this.persist();
    this.emit();
  }

  /** Выбор файла (из дерева или поиска): раскрываем предков, читаем файл. */
  select(path: string | null): void {
    this.selected = path;
    if (path) {
      for (const a of ancestors(path)) {
        if (!this.expanded.has(a)) {
          this.expanded.add(a);
          if (!this.dirs.has(a)) void this.loadDir(a);
        }
      }
      void this.loadFile(path);
    } else {
      this.fileToken++;
      this.file = null;
    }
    this.persist();
    this.emit();
  }

  setMode(mode: FilesMode): void {
    this.mode = mode;
    this.persist();
    this.emit();
  }

  /** Обновить всё загруженное, не сбрасывая показанное (кнопка, конец хода, правка агента). */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const dirs = ['', ...[...this.expanded].filter((d) => this.dirs.has(d))];
      await Promise.all([
        ...dirs.map((d) => this.loadDir(d, true)),
        this.loadGit(true),
        ...(this.selected ? [this.loadFile(this.selected, true)] : []),
      ]);
    } finally {
      this.refreshing = false;
    }
  }

  /** Известные пути файлов (для поиска): всё загруженное + изменённое по git. */
  knownFiles(): string[] {
    const out: string[] = [];
    for (const [dir, st] of this.dirs) for (const e of st.entries) if (e.kind !== 'dir') out.push(dir ? `${dir}/${e.name}` : e.name);
    for (const p of this.git.idx?.files.keys() ?? []) out.push(p);
    return out;
  }
}

const models = new WeakMap<SupervisorClient, Map<string, FilesModel>>();

export function filesModel(client: SupervisorClient, sid: string): FilesModel {
  let byEnv = models.get(client);
  if (!byEnv) {
    byEnv = new Map();
    models.set(client, byEnv);
  }
  const key = `${client.environment}|${sid}`;
  let m = byEnv.get(key);
  if (!m) {
    m = new FilesModel(client, sid);
    byEnv.set(key, m);
  }
  return m;
}
