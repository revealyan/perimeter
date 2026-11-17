// Сайдбар «пульт» (BD2): сессии по статусу — кто ждёт тебя, кто работает, кто готов, кто остыл.
// Чистые функции без React.
import type { PermissionCard, SessionView } from '../supervisor';
import { toolHead } from './toolFormat';

export type GroupId = 'waiting' | 'working' | 'ready' | 'fresh' | 'cold';

export const GROUP_LABEL: Record<GroupId, string> = {
  waiting: 'Ждут тебя',
  working: 'Работают',
  ready: 'Готовы',
  fresh: 'Новые',
  cold: 'Остыли',
};
const ORDER: GroupId[] = ['waiting', 'working', 'ready', 'fresh', 'cold'];

export type SessionLike = Pick<SessionView, 'id' | 'name' | 'state' | 'archived' | 'lastActivity' | 'permissions' | 'items' | 'lastResult' | 'projectId' | 'parentSessionId'>;

/** Был ли у сессии хоть один ход (итог хода или ответ агента; после ресинка итогов в ленте нет). */
export function hasResult(s: Pick<SessionView, 'lastResult' | 'items'>): boolean {
  return s.lastResult !== undefined || s.items.some((it) => it.kind === 'turn' || it.kind === 'text' || it.kind === 'tool-use');
}

/** Группа сессии по состоянию. */
export function groupOf(s: SessionLike): GroupId {
  if (s.state === 'waiting_permission' || s.state === 'waiting_input' || s.permissions.length > 0) return 'waiting';
  if (s.state === 'working' || s.state === 'initializing' || s.state === 'creating') return 'working';
  if (s.state === 'dead' || s.state === 'error') return 'cold';
  return hasResult(s) ? 'ready' : 'fresh';
}

export interface SessionFilter {
  /** undefined — все проекты; null — «без проекта»; строка — id проекта */
  projectId?: string | null;
  query?: string;
}

export interface Grouped<T> {
  groups: Array<{ id: GroupId; label: string; sessions: T[] }>;
  archived: T[];
  /** сколько сессий прошло фильтр (без архива) */
  total: number;
}

/** Группы по статусу (только непустые, в фиксированном порядке), внутри — свежие сверху; архив отдельно. */
export function groupSessions<T extends SessionLike>(list: Iterable<T>, filter: SessionFilter = {}, knownProjects?: Set<string>): Grouped<T> {
  const q = (filter.query ?? '').trim().toLowerCase();
  const inProject = (s: T): boolean => {
    if (filter.projectId === undefined) return true;
    const pid = s.projectId && (!knownProjects || knownProjects.has(s.projectId)) ? s.projectId : null;
    return pid === filter.projectId;
  };
  const passed = [...list].filter((s) => inProject(s) && (q === '' || s.name.toLowerCase().includes(q)));
  const byRecent = (a: T, b: T) => b.lastActivity - a.lastActivity;
  const live = passed.filter((s) => !s.archived);
  const buckets = new Map<GroupId, T[]>();
  for (const s of live) {
    const g = groupOf(s);
    const arr = buckets.get(g) ?? [];
    arr.push(s);
    buckets.set(g, arr);
  }
  return {
    groups: ORDER.filter((g) => buckets.has(g)).map((g) => ({ id: g, label: GROUP_LABEL[g], sessions: buckets.get(g)!.sort(byRecent) })),
    archived: passed.filter((s) => s.archived).sort(byRecent),
    total: live.length,
  };
}

// ─── что ждёт ответа ────────────────────────────────────────────────────────

/** «Разрешить …?» — винительный падеж по инструменту. */
export const ASK_VERB: Record<string, string> = {
  Bash: 'команду', Edit: 'правку', MultiEdit: 'правку', Write: 'запись файла', NotebookEdit: 'правку ноутбука',
  Read: 'чтение', Glob: 'поиск файлов', Grep: 'поиск', WebFetch: 'загрузку страницы', WebSearch: 'веб-поиск',
  Task: 'запуск субагента', Agent: 'запуск субагента',
  'mcp__perimeter__delegate_to_agent': 'делегирование сабагенту',
};

export function askTitle(toolName: string): string {
  return `Разрешить ${ASK_VERB[toolName] ?? `«${toolHead(toolName, {}).verb}»`}?`;
}

export type WaitingInfo =
  | { kind: 'permission'; card: PermissionCard; title: string; target: string }
  | { kind: 'question'; card: PermissionCard; question: string; options: string[]; instant: boolean }
  | { kind: 'unknown'; text: string };

/**
 * Что ждёт сессия — для карточки «Ждут тебя»: команда (ответ «Разрешить» прямо в карточке)
 * или вопрос (один вопрос с одиночным выбором — варианты кнопками; иначе — открыть сессию).
 */
export function waitingInfo(s: Pick<SessionView, 'permissions' | 'needs'>): WaitingInfo {
  const card = s.permissions[0];
  if (!card) return { kind: 'unknown', text: s.needs ?? 'ждёт ответа' };
  if (card.questions?.length) {
    const q = card.questions[0]!;
    const instant = card.questions.length === 1 && q.multiSelect !== true;
    return {
      kind: 'question', card,
      question: card.questions.length > 1 ? `${q.question} (+${card.questions.length - 1})` : q.question,
      options: instant ? q.options.map((o) => o.label) : [],
      instant,
    };
  }
  return { kind: 'permission', card, title: askTitle(card.toolName), target: toolHead(card.toolName, card.input).target };
}

// ─── цвет проекта ───────────────────────────────────────────────────────────

/** Небольшая палитра меток проектов (читается на тёмном графите). */
export const PROJECT_PALETTE = ['#6fa8e8', '#e3a36f', '#c48fe0', '#9cc46a', '#d98aa8', '#4fc2b2', '#c9a96e'] as const;

/** Стабильный цвет проекта по имени (FNV-1a): тот же проект — тот же цвет в обеих средах. */
export function projectColor(name: string): string {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length]!;
}
