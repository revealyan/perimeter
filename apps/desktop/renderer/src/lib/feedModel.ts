// Модель ленты в терминальной манере (BD2): блоки «ты» / «агент», группы шагов со сводкой,
// итог шага одной строкой, план из TodoWrite, идущие команды, агрегат изменений по файлам.
// Чистые функции над FeedItem — без React.
import type { FeedItem } from '../supervisor';
import { editPatch, editStats, shortPath, type Patch } from './toolFormat';
import { countOf } from './ru';
import { clip, splitLines } from './multiline';

const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Вызов ещё идёт: результата нет и сервер не пометил его законченным (после ресинка done=true). */
export function isRunning(it: FeedItem): boolean {
  return it.kind === 'tool-use' && it.data['done'] !== true && it.data['result'] === undefined && it.data['isError'] !== true;
}

// ─── блоки ──────────────────────────────────────────────────────────────────

export type FeedBlock =
  | { kind: 'user'; key: string; item: FeedItem }
  | { kind: 'agent'; key: string; items: FeedItem[]; turn?: FeedItem; startTs?: number }
  | { kind: 'event'; key: string; item: FeedItem };

/** Что открывает блок агента (служебные строки вне хода идут отдельными событиями). */
const AGENT_KINDS = new Set<FeedItem['kind']>(['text', 'thinking', 'tool-use', 'tool-result', 'subagent']);

/** Лента → блоки: реплика пользователя — свой блок; всё до следующей реплики — блок агента, итог хода — в его шапку. */
export function feedBlocks(items: FeedItem[]): FeedBlock[] {
  const out: FeedBlock[] = [];
  let agent: Extract<FeedBlock, { kind: 'agent' }> | null = null;
  let lastUserTs: number | undefined;
  for (const it of items) {
    if (it.kind === 'user') {
      agent = null;
      lastUserTs = it.ts;
      out.push({ kind: 'user', key: it.id, item: it });
      continue;
    }
    if (it.kind === 'turn') {
      if (agent) agent.turn = it;
      else out.push({ kind: 'agent', key: it.id, items: [], turn: it, ...(lastUserTs !== undefined ? { startTs: lastUserTs } : {}) });
      agent = null;
      continue;
    }
    if (!agent) {
      if (!AGENT_KINDS.has(it.kind)) {
        out.push({ kind: 'event', key: it.id, item: it });
        continue;
      }
      agent = { kind: 'agent', key: it.id, items: [], ...(lastUserTs !== undefined ? { startTs: lastUserTs } : {}) };
      out.push(agent);
    }
    agent.items.push(it);
  }
  return out;
}

export type Segment =
  | { kind: 'item'; key: string; item: FeedItem }
  | { kind: 'steps'; key: string; items: FeedItem[] };

/** Шаги — вызовы инструментов и их спутники (результат без вызова, субагент, ответ на разрешение). */
const STEP_KINDS = new Set<FeedItem['kind']>(['tool-use', 'tool-result', 'subagent', 'permission-log']);

/** Внутри блока агента подряд идущие шаги сворачиваются в одну группу со сводкой. */
export function segments(items: FeedItem[]): Segment[] {
  const out: Segment[] = [];
  let group: Extract<Segment, { kind: 'steps' }> | null = null;
  for (const it of items) {
    if (STEP_KINDS.has(it.kind)) {
      if (!group) {
        group = { kind: 'steps', key: it.id, items: [] };
        out.push(group);
      }
      group.items.push(it);
    } else {
      group = null;
      out.push({ kind: 'item', key: it.id, item: it });
    }
  }
  return out;
}

export interface StepsSummary {
  /** вызовов инструментов */
  count: number;
  /** разных файлов изменено */
  files: number;
  added: number;
  removed: number;
  running: number;
  errors: number;
  /** от первого до последнего шага (если у шагов есть время) */
  durationMs?: number;
}

export function stepsSummary(items: FeedItem[]): StepsSummary {
  const paths = new Set<string>();
  let count = 0, added = 0, removed = 0, running = 0, errors = 0;
  let first: number | undefined;
  let last: number | undefined;
  for (const it of items) {
    if (it.ts !== undefined) {
      first ??= it.ts;
      last = it.ts;
    }
    if (it.kind !== 'tool-use') continue;
    count++;
    if (isRunning(it)) running++;
    if (it.data['isError'] === true) { errors++; continue; }
    if (isRunning(it)) continue;
    const st = editStats(str(it.data['name']), it.data['input'], it.data['result']);
    if (st) {
      paths.add(st.path);
      added += st.added;
      removed += st.removed;
    }
  }
  const durationMs = first !== undefined && last !== undefined && last > first ? last - first : undefined;
  return { count, files: paths.size, added, removed, running, errors, ...(durationMs !== undefined ? { durationMs } : {}) };
}

// ─── итог шага одной строкой ────────────────────────────────────────────────

export interface StepResult {
  text: string;
  tone: 'ok' | 'err' | 'dim' | 'run';
  /** для правок: счётчики строк (показываются цветом) */
  added?: number;
  removed?: number;
}

/** Первая непустая строка текста ошибки/вывода. */
function firstText(v: unknown): string {
  if (typeof v === 'string') return splitLines(v)[0] ?? '';
  const o = asObj(v);
  if (o) {
    const e = str(o['stderr']) || str(o['stdout']) || str(o['error']) || str(o['message']);
    if (e) return splitLines(e)[0] ?? '';
  }
  if (Array.isArray(v)) {
    for (const b of v) {
      const t = str(asObj(b)?.['text']);
      if (t) return splitLines(t)[0] ?? '';
    }
  }
  return '';
}

/** Итог вызова для колонки «итог» строки шага: «8 файлов», «строки 1–12», «+2 −2», «выполняется». */
export function stepResult(name: string, input: unknown, result: unknown, isError: boolean, done: boolean): StepResult {
  if (isError) return { text: clip(firstText(result) || 'ошибка', 72), tone: 'err' };
  if (!done && result === undefined) return { text: 'выполняется', tone: 'run' };
  const r = asObj(result);
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const p = editPatch(name, input, result);
      if (p) return { text: '', tone: 'ok', added: p.added, removed: p.removed };
      break;
    }
    case 'Glob': {
      const n = num(r?.['numFiles']) ?? (Array.isArray(r?.['filenames']) ? (r!['filenames'] as unknown[]).length : undefined);
      if (n !== undefined) return { text: n === 0 ? 'ничего' : countOf(n, ['файл', 'файла', 'файлов']), tone: 'dim' };
      break;
    }
    case 'Grep': {
      const lines = num(r?.['numLines']);
      if (r?.['mode'] === 'content' && lines !== undefined) return { text: lines === 0 ? 'нет совпадений' : countOf(lines, ['совпадение', 'совпадения', 'совпадений']), tone: 'dim' };
      const n = num(r?.['numFiles']);
      if (n !== undefined) return { text: n === 0 ? 'нет совпадений' : countOf(n, ['файл', 'файла', 'файлов']), tone: 'dim' };
      break;
    }
    case 'Read': {
      if (r?.['type'] === 'image') return { text: 'картинка', tone: 'dim' };
      const f = asObj(r?.['file']);
      const start = num(f?.['startLine']);
      const n = num(f?.['numLines']);
      if (start !== undefined && n !== undefined) return { text: n <= 1 ? `строка ${start}` : `строки ${start}–${start + n - 1}`, tone: 'dim' };
      break;
    }
    case 'Bash': {
      if (r?.['interrupted'] === true) return { text: 'прервано', tone: 'err' };
      const out = splitLines(str(r?.['stdout'])).filter((l) => l.trim() !== '');
      const lastLine = out[out.length - 1]?.trim();
      return lastLine ? { text: clip(lastLine, 60), tone: 'dim' } : { text: 'готово', tone: 'ok' };
    }
    case 'Task':
    case 'Agent': {
      const n = num(r?.['totalToolUseCount']);
      return { text: n !== undefined ? `готово · ${countOf(n, ['шаг', 'шага', 'шагов'])}` : 'готово', tone: 'ok' };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(asObj(input)?.['todos']) ? (asObj(input)!['todos'] as unknown[]) : [];
      const doneN = todos.filter((t) => asObj(t)?.['status'] === 'completed').length;
      return { text: `${doneN}/${todos.length}`, tone: 'dim' };
    }
    case 'AskUserQuestion': {
      const a = asObj(r?.['answers']);
      if (a) return { text: clip(Object.values(a).map((v) => (Array.isArray(v) ? v.join(', ') : String(v))).join(' · '), 60), tone: 'ok' };
      break;
    }
    default:
      break;
  }
  return { text: 'готово', tone: 'ok' };
}

// ─── план и идущие команды (панель «Задачи») ────────────────────────────────

export type PlanStatus = 'pending' | 'in_progress' | 'completed';
export interface PlanItem { text: string; status: PlanStatus; active?: string }
export interface Plan { items: PlanItem[]; done: number; total: number; itemId: string }

/**
 * План агента из ленты — как список задач в Claude Code Desktop. Два набора инструментов:
 * - TodoWrite (старые модели): каждый вызов — весь список целиком (input.todos: content/status/activeForm);
 * - TaskCreate/TaskUpdate/TaskList (с 23.11 у всех моделей, настройка аккаунта «список задач»): задачи по одной —
 *   создание (id — из результата), правка статуса/текста по taskId, «deleted» — убрать; TaskList — снимок целиком.
 * Вызовы проигрываются по порядку; последний снимок (TodoWrite/TaskList) заменяет накопленное.
 */
export function extractPlan(items: FeedItem[]): Plan | null {
  let list: Array<PlanItem & { key: string }> | null = null;
  let itemId = '';
  const find = (id: string) => list?.find((t) => t.key === id);
  for (const it of items) {
    if (it.kind !== 'tool-use') continue;
    const name = it.data['name'];
    const input = asObj(it.data['input']) ?? {};
    const result = it.data['result'];
    if (name === 'TodoWrite') {
      const todos = input['todos'];
      if (!Array.isArray(todos)) continue;
      list = todos.map((t, i) => {
        const o = asObj(t) ?? {};
        const active = str(o['activeForm']);
        return { key: `todo-${i}`, text: str(o['content']), status: planStatus(o['status']), ...(active ? { active } : {}) };
      });
      itemId = it.id;
    } else if (name === 'TaskCreate') {
      list ??= [];
      // id задачи — из результата; пока его нет (вызов идёт) — держим по id вызова
      const id = taskIdOf(result) ?? `call-${it.id}`;
      const active = str(input['activeForm']);
      if (!find(id)) list.push({ key: id, text: str(input['subject']) || str(asObj(asObj(result)?.['task'])?.['subject']), status: 'pending', ...(active ? { active } : {}) });
      itemId = it.id;
    } else if (name === 'TaskUpdate') {
      const t = find(str(input['taskId']));
      if (!t || !list) continue;
      const st = str(input['status']);
      if (st === 'deleted') list = list.filter((x) => x !== t);
      else {
        if (st) t.status = planStatus(st);
        if (str(input['subject'])) t.text = str(input['subject']);
        if (str(input['activeForm'])) t.active = str(input['activeForm']);
      }
      itemId = it.id;
    } else if (name === 'TaskList') {
      const tasks = asObj(result)?.['tasks'];
      if (!Array.isArray(tasks)) continue;
      type Keyed = PlanItem & { key: string };
      const prev = new Map<string, Keyed>((list ?? []).map((t): [string, Keyed] => [t.key, t]));
      list = tasks.map((t): Keyed => {
        const o = asObj(t) ?? {};
        const key = str(o['id']);
        const active = prev.get(key)?.active;
        return { key, text: str(o['subject']), status: planStatus(o['status']), ...(active ? { active } : {}) };
      });
      itemId = it.id;
    }
  }
  if (!list || list.length === 0) return null;
  const out = list.map(({ key: _k, ...t }) => t);
  return { items: out, done: out.filter((t) => t.status === 'completed').length, total: out.length, itemId };
}

const planStatus = (v: unknown): PlanStatus => (v === 'completed' || v === 'in_progress' ? v : 'pending');

/** id созданной задачи: структурный результат ({ task: { id } }) или текст «Task #3 created…». */
function taskIdOf(result: unknown): string | undefined {
  const id = asObj(asObj(result)?.['task'])?.['id'];
  if (typeof id === 'string' && id) return id;
  if (typeof id === 'number') return String(id);
  const text = typeof result === 'string' ? result : Array.isArray(result) ? result.map((b) => str(asObj(b)?.['text'])).join(' ') : '';
  return /#(\d+)/.exec(text)?.[1];
}

export interface RunningCmd { itemId: string; command: string; description?: string; startedAt?: number }

/** Идущие команды: вызовы Bash без результата (ещё выполняются). */
export function runningCommands(items: FeedItem[]): RunningCmd[] {
  const out: RunningCmd[] = [];
  for (const it of items) {
    if (it.data['name'] !== 'Bash' || !isRunning(it)) continue;
    const i = asObj(it.data['input']) ?? {};
    const description = str(i['description']);
    out.push({ itemId: it.id, command: str(i['command']), ...(description ? { description } : {}), ...(it.ts !== undefined ? { startedAt: it.ts } : {}) });
  }
  return out;
}

// ─── изменения по файлам (панель «Изменения») ───────────────────────────────

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** правок этого файла по порядку */
  patches: Patch[];
  /** id вызовов — чтобы прокрутить ленту к правке */
  itemIds: string[];
  /** файл создан записью целиком (Write без прошлого содержимого) */
  created: boolean;
}

/** Правки сессии по файлам (порядок — по первой правке); ошибочные и ещё не применённые — мимо. */
export function fileChanges(items: FeedItem[]): FileChange[] {
  const map = new Map<string, FileChange>();
  for (const it of items) {
    if (it.kind !== 'tool-use' || it.data['isError'] === true || isRunning(it)) continue;
    const name = str(it.data['name']);
    const p = editPatch(name, it.data['input'], it.data['result']);
    if (!p || p.path === '') continue;
    let fc = map.get(p.path);
    if (!fc) {
      fc = { path: p.path, added: 0, removed: 0, patches: [], itemIds: [], created: name === 'Write' && asObj(it.data['result'])?.['type'] === 'create' };
      map.set(p.path, fc);
    }
    fc.added += p.added;
    fc.removed += p.removed;
    fc.patches.push(p);
    fc.itemIds.push(it.id);
  }
  return [...map.values()];
}

/** Все правки файла одним дифом: хунки правок подряд, в порядке применения. */
export function mergePatches(path: string, patches: Patch[]): Patch {
  return {
    path,
    hunks: patches.flatMap((p) => p.hunks),
    added: patches.reduce((n, p) => n + p.added, 0),
    removed: patches.reduce((n, p) => n + p.removed, 0),
  };
}

/** «строки 7–8» — где в новом файле правка (по добавленным строкам, иначе по удалённым в старом). */
export function changedRange(p: Patch): string {
  const nos: number[] = [];
  for (const h of p.hunks) for (const l of h.lines) if (l.sign === '+' && l.newNo !== undefined) nos.push(l.newNo);
  if (nos.length === 0) for (const h of p.hunks) for (const l of h.lines) if (l.sign === '-' && l.oldNo !== undefined) nos.push(l.oldNo);
  if (nos.length === 0) return '';
  const lo = Math.min(...nos);
  const hi = Math.max(...nos);
  return lo === hi ? `строка ${lo}` : `строки ${lo}–${hi}`;
}

export function changesTotal(changes: FileChange[]): { files: number; added: number; removed: number } {
  return {
    files: changes.length,
    added: changes.reduce((n, c) => n + c.added, 0),
    removed: changes.reduce((n, c) => n + c.removed, 0),
  };
}

// ─── сессия целиком ─────────────────────────────────────────────────────────

/** Стоимость сессии: из последнего итога хода (total_cost_usd в потоке накопительный). */
export function sessionCost(s: { lastResult?: { costUsd?: number }; items: FeedItem[] }): number | undefined {
  if (s.lastResult?.costUsd !== undefined) return s.lastResult.costUsd;
  for (let k = s.items.length - 1; k >= 0; k--) {
    const it = s.items[k]!;
    if (it.kind === 'turn' && typeof it.data['costUsd'] === 'number') return it.data['costUsd'];
  }
  return undefined;
}

/** Последнее действие работающей сессии — для строки в сайдбаре. */
export function lastAction(items: FeedItem[], printing: string | null): string {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'user') break;
    if (it.kind === 'tool-use') {
      const i = asObj(it.data['input']) ?? {};
      const name = str(it.data['name']);
      const file = str(i['file_path']);
      const target = str(i['command']) || (file ? shortPath(file, 2) : '') || str(i['pattern']) || str(i['description']) || str(i['url']) || str(i['query']) || name;
      return splitLines(target)[0] ?? name;
    }
    if (it.kind === 'text') break;
  }
  return printing ? 'пишет ответ…' : 'думает…';
}

// ─── делегирование: привязка карточек к воркерам ─────────────────────────────

/**
 * Карточки delegate_to_agent ↔ воркеры сессии (по порядку появления, и завершённые тоже —
 * врезка ленты воркера нужна прежде всего после финиша): ключ — id tool-use-карточки,
 * значение — id сессии воркера. Ограничение среза: параллельные вызовы в одном ходе могут
 * перепутать блоки — кнопки адресуют воркера напрямую (по его id), так что перепутывание
 * влияет только на показанный статус/врезку, не на действия.
 */
export function bindDelegateWorkers(items: FeedItem[], workers: Array<{ id: string }>): Map<string, string> {
  const cards: string[] = [];
  for (const it of items) {
    if (it.kind !== 'tool-use') continue;
    if (it.data['name'] !== 'mcp__perimeter__delegate_to_agent') continue;
    const id = String(it.data['id'] ?? '');
    if (id !== '') cards.push(id);
  }
  const map = new Map<string, string>();
  const ids = workers.map((w) => w.id);
  cards.forEach((cardId, i) => { if (ids[i] !== undefined) map.set(cardId, ids[i]!); });
  return map;
}
