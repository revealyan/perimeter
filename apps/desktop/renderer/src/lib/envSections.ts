// Сайдбар S1 «Среды секциями»: обе среды в одном списке. Сверху общий «Ждут тебя» (с меткой среды),
// ниже — секция на каждую среду (строки по статусу, без заголовков групп), внизу общий архив.
// Чистые функции без React.
import type { EnvId, ProjectInfo } from '../supervisor';
import { groupOf, type GroupId, type SessionLike } from './sessionGroups';

/** Порядок статусов внутри секции среды («ждут» — наверху, в общей группе). */
const SECTION_ORDER: GroupId[] = ['working', 'ready', 'fresh', 'cold'];

export interface EnvInput<T> {
  env: EnvId;
  sessions: Iterable<T>;
  /** имя проекта сессии в этой среде (проекты разных сред связаны по имени) */
  projectName: (s: T) => string | undefined;
}

export interface EnvFilter {
  /** undefined — все проекты; null — без проекта; строка — имя проекта (без учёта регистра) */
  project?: string | null;
  query?: string;
}

export interface Tagged<T> { env: EnvId; s: T }

export interface EnvSection<T> {
  env: EnvId;
  /** строки секции (без ждущих — они в общей группе; воркеры делегирования — под родителем в children) */
  rows: Array<{ s: T; group: GroupId }>;
  /** воркеры делегирования: id родителя → строки (родитель гарантированно есть в rows) */
  children: Map<string, T[]>;
  /** все живые сессии среды, прошедшие фильтр (вместе с ждущими) */
  total: number;
}

export interface EnvLayout<T> {
  waiting: Array<Tagged<T>>;
  sections: Array<EnvSection<T>>;
  archived: Array<Tagged<T>>;
  total: number;
}

const norm = (s: string) => s.trim().toLowerCase();

export function layoutEnvs<T extends SessionLike>(inputs: Array<EnvInput<T>>, filter: EnvFilter = {}): EnvLayout<T> {
  const q = norm(filter.query ?? '');
  const want = typeof filter.project === 'string' ? norm(filter.project) : filter.project;
  const byRecent = (a: { lastActivity: number }, b: { lastActivity: number }) => b.lastActivity - a.lastActivity;
  const waiting: Array<Tagged<T>> = [];
  const archived: Array<Tagged<T>> = [];
  const sections: Array<EnvSection<T>> = [];
  let total = 0;
  for (const inp of inputs) {
    const passed = [...inp.sessions].filter((s) => {
      if (q !== '' && !s.name.toLowerCase().includes(q)) return false;
      if (want === undefined) return true;
      const name = inp.projectName(s);
      return want === null ? name === undefined : name !== undefined && norm(name) === want;
    });
    const rows: Array<{ s: T; group: GroupId }> = [];
    const children = new Map<string, T[]>();
    // родитель должен быть виден как строка: воркер без видимого родителя (архив, фильтр) — обычной строкой, чтобы не потерялся
    const visibleIds = new Set(passed.filter((s) => !s.archived).map((s) => s.id));
    let envTotal = 0;
    for (const s of passed) {
      if (s.archived) { archived.push({ env: inp.env, s }); continue; }
      envTotal++;
      const g = groupOf(s);
      // ждущий воркер — карточкой в общий «Ждут тебя» (отвечать!), нестрогий — строкой под родителем
      if (g !== 'waiting' && s.parentSessionId !== undefined && visibleIds.has(s.parentSessionId)) {
        const list = children.get(s.parentSessionId) ?? [];
        list.push(s);
        children.set(s.parentSessionId, list);
        continue;
      }
      if (g === 'waiting') waiting.push({ env: inp.env, s });
      else rows.push({ s, group: g });
    }
    rows.sort((a, b) => SECTION_ORDER.indexOf(a.group) - SECTION_ORDER.indexOf(b.group) || byRecent(a.s, b.s));
    sections.push({ env: inp.env, rows, children, total: envTotal });
    total += envTotal;
  }
  waiting.sort((a, b) => byRecent(a.s, b.s));
  archived.sort((a, b) => byRecent(a.s, b.s));
  return { waiting, sections, archived, total };
}

/** Проекты обеих сред одним списком по имени (без учёта регистра): где какой есть. */
export function mergeProjects(lists: Array<{ env: EnvId; projects: ProjectInfo[] }>): Array<{ name: string; envs: EnvId[]; paths: Partial<Record<EnvId, string>> }> {
  const out = new Map<string, { name: string; envs: EnvId[]; paths: Partial<Record<EnvId, string>> }>();
  for (const { env, projects } of lists) {
    for (const p of projects) {
      const k = norm(p.name);
      let e = out.get(k);
      if (!e) {
        e = { name: p.name.trim(), envs: [], paths: {} };
        out.set(k, e);
      }
      if (!e.envs.includes(env)) e.envs.push(env);
      e.paths[env] ??= p.path;
    }
  }
  return [...out.values()];
}

// ─── группы по проектам внутри среды (как в Claude Code Desktop) ─────────────

export interface ProjectGroup<T> {
  /** id проекта; null — сессии без проекта (или проект удалён) */
  projectId: string | null;
  name: string | null;
  rows: Array<{ s: T; group: GroupId }>;
  /** последняя активность в группе (0 — сессий нет) */
  latest: number;
}

/**
 * Строки секции среды — группами по проектам: проекты со свежей активностью выше, внутри — свежие сверху.
 * includeEmpty — показать и проекты среды без сессий (у них «+», чтобы начать сессию); «без проекта» — последней.
 */
export function projectGroups<T extends SessionLike & { lastActivity: number }>(
  rows: Array<{ s: T; group: GroupId }>,
  projects: Array<Pick<ProjectInfo, 'id' | 'name'>>,
  opts: { includeEmpty?: boolean } = {},
): Array<ProjectGroup<T>> {
  const known = new Map(projects.map((p) => [p.id, p.name]));
  const groups = new Map<string, ProjectGroup<T>>();
  const keyOf = (pid: string | undefined) => (pid !== undefined && known.has(pid) ? pid : '');
  for (const r of rows) {
    const k = keyOf(r.s.projectId);
    let g = groups.get(k);
    if (!g) {
      g = { projectId: k === '' ? null : k, name: k === '' ? null : known.get(k)!, rows: [], latest: 0 };
      groups.set(k, g);
    }
    g.rows.push(r);
    g.latest = Math.max(g.latest, r.s.lastActivity);
  }
  if (opts.includeEmpty) {
    for (const p of projects) if (!groups.has(p.id)) groups.set(p.id, { projectId: p.id, name: p.name, rows: [], latest: 0 });
  }
  for (const g of groups.values()) g.rows.sort((a, b) => b.s.lastActivity - a.s.lastActivity);
  return [...groups.values()].sort((a, b) => {
    if ((a.projectId === null) !== (b.projectId === null)) return a.projectId === null ? 1 : -1; // «без проекта» — в конце
    if (b.latest !== a.latest) return b.latest - a.latest;
    return (a.name ?? '').localeCompare(b.name ?? '', 'ru');
  });
}
