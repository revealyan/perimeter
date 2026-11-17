// Проекты: именованные папки на VPS с дефолтами (профиль/модель/режим).
// Хранение: ~/.perimeter/projects.json. Проект = папка → транскрипты ложатся сами.
// Там же — корень хранилища проектов среды (куда новые проекты создаются по имени): выбор из UI переживает рестарт.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  profile?: string;
  model?: string;
  permissionMode?: string;
}

interface ProjectsFile {
  version: 1;
  projects: ProjectInfo[];
  /** корень хранилища, выбранный из UI (cmd:storage.set); нет — умолчание supervisor'а */
  root?: string;
}

/** Корень хранилища по умолчанию: PERIMETER_PROJECTS_ROOT, иначе ~/projects. */
export function defaultProjectsRoot(): string {
  const env = process.env['PERIMETER_PROJECTS_ROOT'];
  return env !== undefined && env.trim() !== '' ? env : join(homedir(), 'projects');
}

export class ProjectStore {
  private projects: ProjectInfo[] = [];
  private savedRoot: string | undefined;
  private readonly defaultRoot: string;

  constructor(private readonly file: string, opts: { defaultRoot?: string } = {}) {
    this.defaultRoot = opts.defaultRoot ?? defaultProjectsRoot();
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as ProjectsFile;
      if (raw.version === 1 && Array.isArray(raw.projects)) {
        // name — тоже обязателен: проект без имени не проходит схему event:hello
        this.projects = raw.projects.filter((p) => typeof p.id === 'string' && typeof p.path === 'string' && typeof p.name === 'string');
      }
      if (typeof raw.root === 'string' && raw.root !== '') this.savedRoot = raw.root;
    } catch { /* нет файла/битый — пусто */ }
  }

  private save(): void {
    const state: ProjectsFile = { version: 1, projects: this.projects, ...(this.savedRoot !== undefined ? { root: this.savedRoot } : {}) };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /** Корень хранилища проектов среды. */
  root(): string {
    return this.savedRoot ?? this.defaultRoot;
  }

  /** Запомнить корень (путь уже проверен и папка создана вызывающим). */
  setRoot(root: string): void {
    this.savedRoot = root;
    this.save();
  }

  list(): ProjectInfo[] {
    return this.projects.map((p) => ({ ...p }));
  }

  byPath(path: string): ProjectInfo | undefined {
    return this.projects.find((p) => p.path === path);
  }

  /** Проект с таким именем (без учёта регистра и крайних пробелов) — связь сред идёт по имени. */
  byName(name: string): ProjectInfo | undefined {
    const n = name.trim().toLowerCase();
    return this.projects.find((p) => p.name.trim().toLowerCase() === n);
  }

  get(id: string): ProjectInfo | undefined {
    return this.projects.find((p) => p.id === id);
  }

  create(input: { name: string; path: string; profile?: string; model?: string; permissionMode?: string }): ProjectInfo {
    const p: ProjectInfo = {
      id: randomUUID(),
      name: input.name,
      path: input.path,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    };
    this.projects.push(p);
    this.save();
    return { ...p };
  }

  rename(id: string, name: string): boolean {
    const p = this.get(id);
    if (!p) return false;
    p.name = name;
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== id);
    if (this.projects.length === before) return false;
    this.save();
    return true;
  }
}
