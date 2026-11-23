import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../supervisor';
import {
  bindDelegateWorkers, changedRange, changesTotal, extractPlan, feedBlocks, fileChanges, lastAction, mergePatches, runningCommands, segments,
  sessionCost, stepResult, stepsSummary,
} from './feedModel';

let n = 0;
const it_ = (kind: FeedItem['kind'], data: Record<string, unknown> = {}, ts?: number): FeedItem => ({ id: `x${++n}`, kind, data, ...(ts !== undefined ? { ts } : {}) });
const tool = (name: string, input: unknown, result?: unknown, extra: Record<string, unknown> = {}, ts?: number) =>
  it_('tool-use', { id: `t${n}`, name, input, result, isError: false, done: result !== undefined, ...extra }, ts);

const EDIT_RESULT = {
  structuredPatch: [{ oldStart: 7, newStart: 7, lines: ["-  const a = 1;", "+  const b = 2;", '   return;'] }],
};

describe('лента: блоки «ты» / «агент»', () => {
  it('реплика — свой блок; ответ до следующей реплики — один блок агента с итогом хода в шапке', () => {
    const items = [
      it_('user', { text: 'почини' }, 1000),
      it_('text', { text: 'смотрю' }),
      tool('Read', { file_path: '/a.ts' }, { file: { startLine: 1, numLines: 12 } }),
      it_('turn', { durationMs: 18000, costUsd: 0.09 }),
      it_('user', { text: 'ещё' }, 5000),
      it_('text', { text: 'ок' }),
    ];
    const b = feedBlocks(items);
    expect(b.map((x) => x.kind)).toEqual(['user', 'agent', 'user', 'agent']);
    const a = b[1] as Extract<typeof b[number], { kind: 'agent' }>;
    expect(a.items).toHaveLength(2);
    expect(a.turn?.data['durationMs']).toBe(18000);
    expect(a.startTs).toBe(1000);
    expect((b[3] as typeof a).turn).toBeUndefined();
  });
  it('служебная строка до первого ответа — отдельное событие, а не пустой блок агента', () => {
    const b = feedBlocks([it_('state', { text: 'сессия готова' }), it_('user', { text: 'hi' }), it_('error', { code: 'X' })]);
    expect(b.map((x) => x.kind)).toEqual(['event', 'user', 'event']);
  });
  it('подряд идущие шаги — одна группа; текст её разрывает', () => {
    const s = segments([
      it_('text', { text: 'a' }),
      tool('Glob', { pattern: '*' }, { numFiles: 8 }),
      it_('permission-log', { behavior: 'allow' }),
      tool('Bash', { command: 'ls' }, { stdout: 'x' }),
      it_('text', { text: 'b' }),
      tool('Read', { file_path: '/a' }, {}),
    ]);
    expect(s.map((x) => (x.kind === 'steps' ? `steps${x.items.length}` : 'item'))).toEqual(['item', 'steps3', 'item', 'steps1']);
  });
});

describe('лента: сводка шагов и итог шага', () => {
  it('сводка: шаги, файлы, строки, длительность', () => {
    const s = stepsSummary([
      tool('Glob', { pattern: '*' }, { numFiles: 8 }, {}, 1000),
      tool('Edit', { file_path: '/r.tsx', old_string: 'a', new_string: 'b' }, EDIT_RESULT, {}, 5000),
      tool('Write', { file_path: '/notes.md', content: '1\n2\n3\n4\n5' }, { type: 'create', structuredPatch: [] }, {}, 19000),
      tool('Bash', { command: 'false' }, 'exit 1', { isError: true }),
    ]);
    expect(s).toEqual({ count: 4, files: 2, added: 6, removed: 1, running: 0, errors: 1, durationMs: 18000 });
  });
  it('итог: файлы, строки, совпадения, правка, ошибка, выполняется', () => {
    expect(stepResult('Glob', {}, { numFiles: 8 }, false, true).text).toBe('8 файлов');
    expect(stepResult('Read', {}, { file: { startLine: 1, numLines: 12 } }, false, true).text).toBe('строки 1–12');
    expect(stepResult('Grep', {}, { mode: 'content', numLines: 2 }, false, true).text).toBe('2 совпадения');
    expect(stepResult('Edit', { file_path: '/r' }, EDIT_RESULT, false, true)).toMatchObject({ added: 1, removed: 1, tone: 'ok' });
    expect(stepResult('Bash', {}, { stdout: 'a\n Tests  39 passed (39)\n\n' }, false, true).text).toBe('Tests  39 passed (39)');
    expect(stepResult('Bash', {}, 'Exit code 1\nboom', true, true)).toEqual({ text: 'Exit code 1', tone: 'err' });
    expect(stepResult('Bash', {}, undefined, false, false)).toEqual({ text: 'выполняется', tone: 'run' });
    expect(stepResult('TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }] }, {}, false, true).text).toBe('1/2');
  });
});

describe('панель «Задачи»', () => {
  it('план — из последнего TodoWrite', () => {
    const items = [
      tool('TodoWrite', { todos: [{ content: 'старое', status: 'pending' }] }, {}),
      tool('TodoWrite', { todos: [
        { content: 'Найти разбор', status: 'completed', activeForm: 'Ищу' },
        { content: 'Поправить', status: 'completed' },
        { content: 'Пересобрать', status: 'in_progress', activeForm: 'Пересобираю' },
        { content: 'Странный', status: 'weird' },
      ] }, {}),
    ];
    const p = extractPlan(items)!;
    expect(p.total).toBe(4);
    expect(p.done).toBe(2);
    expect(p.items[2]).toEqual({ text: 'Пересобрать', status: 'in_progress', active: 'Пересобираю' });
    expect(p.items[3]!.status).toBe('pending');
    expect(p.itemId).toBe(items[1]!.id);
  });
  it('список задач TaskCreate/TaskUpdate: id из результата, статусы и правки по taskId, deleted убирает', () => {
    const items = [
      tool('TaskCreate', { subject: 'Разобрать баг', description: '…', activeForm: 'Разбираю баг' }, { task: { id: '1', subject: 'Разобрать баг' } }),
      tool('TaskCreate', { subject: 'Починить' }, 'Task #2 created successfully: Починить'),
      tool('TaskCreate', { subject: 'Лишняя' }, { task: { id: '3', subject: 'Лишняя' } }),
      tool('TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true, taskId: '1', updatedFields: ['status'] }),
      tool('TaskUpdate', { taskId: '3', status: 'deleted' }, { success: true, taskId: '3', updatedFields: [] }),
      tool('TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'] }),
      tool('TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Починить разбор' }, { success: true, taskId: '2', updatedFields: ['status', 'subject'] }),
    ];
    const p = extractPlan(items)!;
    expect(p.items).toEqual([
      { text: 'Разобрать баг', status: 'completed', active: 'Разбираю баг' },
      { text: 'Починить разбор', status: 'in_progress' },
    ]);
    expect([p.done, p.total]).toEqual([1, 2]);
    expect(p.itemId).toBe(items[6]!.id);
  });
  it('TaskCreate ещё идёт (без результата) — задача уже в списке; TaskList — снимок целиком', () => {
    const pending = extractPlan([tool('TaskCreate', { subject: 'Думаю' })])!;
    expect(pending.items).toEqual([{ text: 'Думаю', status: 'pending' }]);
    const snap = extractPlan([
      tool('TaskCreate', { subject: 'А', activeForm: 'Делаю А' }, { task: { id: '1', subject: 'А' } }),
      tool('TaskList', {}, { tasks: [{ id: '1', subject: 'А', status: 'in_progress', blockedBy: [] }, { id: '2', subject: 'Б', status: 'pending', blockedBy: [] }] }),
    ])!;
    expect(snap.items).toEqual([{ text: 'А', status: 'in_progress', active: 'Делаю А' }, { text: 'Б', status: 'pending' }]);
  });
  it('плана нет — null', () => {
    expect(extractPlan([it_('text', { text: 'a' })])).toBeNull();
  });
  it('идущие команды — Bash без результата; после ресинка (done) — не идут', () => {
    const run = tool('Bash', { command: 'npm run build', description: 'сборка' }, undefined, {}, 4000);
    const items = [run, tool('Bash', { command: 'ls' }, { stdout: '' }), tool('Bash', { command: 'old' }, undefined, { done: true }), tool('Read', { file_path: '/a' })];
    expect(runningCommands(items)).toEqual([{ itemId: run.id, command: 'npm run build', description: 'сборка', startedAt: 4000 }]);
  });
});

describe('панель «Изменения»', () => {
  it('несколько правок одного файла — один пункт с суммой и правками по порядку', () => {
    const e1 = tool('Edit', { file_path: '/r.tsx', old_string: 'a', new_string: 'b' }, EDIT_RESULT);
    const e2 = tool('Edit', { file_path: '/r.tsx', old_string: 'x\ny', new_string: 'z' }, {});
    const items = [
      e1,
      tool('Write', { file_path: '/n.md', content: 'x' }, { type: 'create', structuredPatch: [] }),
      e2,
      tool('Edit', { file_path: '/bad', old_string: 'a', new_string: 'b' }, 'нет файла', { isError: true }),
      tool('Edit', { file_path: '/pending', old_string: 'a', new_string: 'b' }),
    ];
    const ch = fileChanges(items);
    expect(ch.map((c) => c.path)).toEqual(['/r.tsx', '/n.md']);
    expect(ch[0]).toMatchObject({ added: 2, removed: 3, itemIds: [e1.id, e2.id], created: false });
    expect(ch[1]!.created).toBe(true);
    const merged = mergePatches('/r.tsx', ch[0]!.patches);
    expect(merged.hunks).toHaveLength(2);
    expect(merged.hunks[0]!.oldStart).toBe(7);
    expect([merged.added, merged.removed]).toEqual([2, 3]);
    expect(changesTotal(ch)).toEqual({ files: 2, added: 3, removed: 3 });
  });
  it('диапазон правки — по новым строкам, без добавлений — по удалённым', () => {
    const p = fileChanges([tool('Edit', { file_path: '/r', old_string: 'a', new_string: 'b' }, {
      structuredPatch: [{ oldStart: 5, newStart: 5, lines: ['  x', '  y', '-a1', '-a2', '+b1', '+b2', '  z'] }],
    })])[0]!.patches[0]!;
    expect(changedRange(p)).toBe('строки 7–8');
    const del = fileChanges([tool('Edit', { file_path: '/r', old_string: 'a', new_string: '' }, {
      structuredPatch: [{ oldStart: 3, newStart: 3, lines: ['-gone'] }],
    })])[0]!.patches[0]!;
    expect(changedRange(del)).toBe('строка 3');
  });
});

describe('сессия целиком', () => {
  it('стоимость — из lastResult, после ресинка — из последнего итога хода', () => {
    expect(sessionCost({ lastResult: { costUsd: 0.5 }, items: [] })).toBe(0.5);
    expect(sessionCost({ items: [it_('turn', { costUsd: 0.1 }), it_('turn', { costUsd: 0.2 })] })).toBe(0.2);
    expect(sessionCost({ items: [] })).toBeUndefined();
  });
  it('последнее действие работающей сессии: первая строка команды или короткий путь', () => {
    expect(lastAction([it_('user', {}), tool('Bash', { command: 'npm run build \\\n -w x' })], null)).toBe('npm run build \\');
    expect(lastAction([tool('Read', { file_path: '/opt/perimeter/apps/desktop/x.ts' })], null)).toBe('…/desktop/x.ts');
    expect(lastAction([it_('user', {})], 'печ')).toBe('пишет ответ…');
  });

describe('bindDelegateWorkers', () => {
  const card = (id: string, done = false) => ({ id: `i${id}`, kind: 'tool-use' as const, ts: 1, data: { id, name: 'mcp__perimeter__delegate_to_agent', input: {}, result: undefined, isError: false, done } });
  it('карточки ↔ воркеры по порядку, завершённые тоже (врезка ленты нужна после финиша)', () => {
    const items = [card('t1', true), card('t2'), card('t3')];
    const workers = [{ id: 'w1' }, { id: 'w2' }];
    const map = bindDelegateWorkers(items, workers);
    expect(map.get('t1')).toBe('w1');
    expect(map.get('t2')).toBe('w2');
    expect(map.size).toBe(2);
  });
  it('воркеров меньше, чем карточек — лишние карточки без воркера', () => {
    const map = bindDelegateWorkers([card('t1'), card('t2')], [{ id: 'w1' }]);
    expect(map.get('t1')).toBe('w1');
    expect(map.has('t2')).toBe(false);
  });
});
});
