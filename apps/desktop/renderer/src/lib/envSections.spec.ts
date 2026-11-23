import { describe, expect, it } from 'vitest';
import { layoutEnvs, mergeProjects, projectGroups } from './envSections';

type S = { id: string; name: string; state: string; archived?: boolean; lastActivity: number; sortAt?: number; permissions: never[] | Array<{ requestId: string; toolName: string; input: unknown; at: number }>; items: Array<{ id: string; kind: 'text'; data: Record<string, unknown> }>; projectId?: string; lastResult?: undefined; parentSessionId?: string };
const mk = (id: string, state: string, t: number, o: Partial<S> = {}): S => ({ id, name: id, state, lastActivity: t, permissions: [], items: [], ...o });
const done = [{ id: 'x', kind: 'text' as const, data: {} }];

const vps = [
  mk('редизайн', 'waiting_permission', 50, { projectId: 'p1' }),
  mk('деплой', 'working', 40, { projectId: 'p1' }),
  mk('метрики', 'dead', 30, { projectId: 'p2' }),
  mk('ролики', 'idle', 20, { projectId: 'p2', items: done }),
  mk('старая', 'dead', 99, { archived: true }),
];
const local = [
  mk('черновик', 'waiting_input', 60),
  mk('readme', 'idle', 10, { projectId: 'L1', items: done }),
];
const names: Record<string, string> = { p1: 'perimeter', p2: 'конвейер', L1: 'Perimeter' };
const inputs = [
  { env: 'vps' as const, sessions: vps, projectName: (s: S) => (s.projectId ? names[s.projectId] : undefined) },
  { env: 'local' as const, sessions: local, projectName: (s: S) => (s.projectId ? names[s.projectId] : undefined) },
];

describe('layoutEnvs — S1 «Среды секциями»', () => {
  it('ждущие из обеих сред — сверху общей группой с меткой среды, свежие первыми', () => {
    const l = layoutEnvs(inputs);
    expect(l.waiting.map((w) => [w.env, w.s.id])).toEqual([['local', 'черновик'], ['vps', 'редизайн']]);
  });

  it('в секции — без ждущих, по статусу (работают → готовы → остыли), счётчик — все живые среды', () => {
    const l = layoutEnvs(inputs);
    const v = l.sections.find((s) => s.env === 'vps')!;
    expect(v.rows.map((r) => [r.s.id, r.group])).toEqual([['деплой', 'working'], ['ролики', 'ready'], ['метрики', 'cold']]);
    expect(v.total).toBe(4);
    expect(l.total).toBe(6);
  });

  it('архив общий, с меткой среды', () => {
    expect(layoutEnvs(inputs).archived.map((a) => [a.env, a.s.id])).toEqual([['vps', 'старая']]);
  });

  it('фильтр по имени проекта — в обеих средах сразу, без учёта регистра', () => {
    const l = layoutEnvs(inputs, { project: 'perimeter' });
    expect(l.waiting.map((w) => w.s.id)).toEqual(['редизайн']);
    expect(l.sections.map((s) => s.rows.map((r) => r.s.id))).toEqual([['деплой'], ['readme']]);
  });

  it('«без проекта» и поиск по имени', () => {
    expect(layoutEnvs(inputs, { project: null }).waiting.map((w) => w.s.id)).toEqual(['черновик']);
    expect(layoutEnvs(inputs, { query: 'РОЛ' }).sections[0]!.rows.map((r) => r.s.id)).toEqual(['ролики']);
  });
});


describe('layoutEnvs — воркеры делегирования', () => {
  const parent = mk('главная', 'working', 50, { projectId: 'p1' });
  const worker = mk('воркер', 'working', 45, { projectId: 'p1', parentSessionId: 'главная' });
  const idleParent = mk('отдых', 'idle', 30, { items: done });
  const its = [{ env: 'vps' as const, sessions: [parent, worker, idleParent], projectName: (s: S) => (s.projectId ? names[s.projectId] : undefined) }];

  it('воркер — под родителем (children), не строкой секции; в total входит', () => {
    const l = layoutEnvs(its);
    const sec = l.sections[0]!;
    expect(sec.rows.map((r) => r.s.id)).toEqual(['главная', 'отдых']);
    expect(sec.children.get('главная')!.map((w) => w.id)).toEqual(['воркер']);
    expect(sec.total).toBe(3);
  });

  it('ждущий воркер — карточкой в общий «Ждут тебя», не в children', () => {
    const waiting = [{ ...worker, state: 'waiting_permission', permissions: [{ requestId: 'r', toolName: 'Bash', input: {}, at: 45 }] }];
    const l = layoutEnvs([{ env: 'vps' as const, sessions: [parent, ...waiting, idleParent], projectName: its[0]!.projectName }]);
    expect(l.waiting.map((w) => w.s.id)).toEqual(['воркер']);
    expect(l.sections[0]!.children.size).toBe(0);
    expect(l.sections[0]!.rows.map((r) => r.s.id)).toEqual(['главная', 'отдых']); // родитель как строка
  });

  it('родитель в архиве — воркер обычной строкой, не теряется', () => {
    const arch = layoutEnvs([{ env: 'vps' as const, sessions: [{ ...parent, archived: true }, worker, idleParent], projectName: its[0]!.projectName }]);
    expect(arch.archived.map((a) => a.s.id)).toEqual(['главная']);
    expect(arch.sections[0]!.rows.map((r) => r.s.id)).toEqual(['воркер', 'отдых']);
    expect(arch.sections[0]!.children.size).toBe(0);
  });
});

describe('mergeProjects', () => {
  it('один проект в двух средах — одна запись с путями обеих', () => {
    const m = mergeProjects([
      { env: 'vps', projects: [{ id: '1', name: 'perimeter', path: '/opt/perimeter' }, { id: '2', name: 'конвейер', path: '/opt/pipeline' }] },
      { env: 'local', projects: [{ id: '3', name: 'Perimeter ', path: 'C:\\devs\\perimeter' }] },
    ]);
    expect(m).toEqual([
      { name: 'perimeter', envs: ['vps', 'local'], paths: { vps: '/opt/perimeter', local: 'C:\\devs\\perimeter' } },
      { name: 'конвейер', envs: ['vps'], paths: { vps: '/opt/pipeline' } },
    ]);
  });
});

describe('projectGroups — сессии среды по проектам', () => {
  const row = (id: string, projectId: string | undefined, lastActivity: number) => ({
    s: { id, name: id, state: 'idle', archived: false, lastActivity, permissions: [], items: [], projectId } as never,
    group: 'ready' as const,
  });
  const projects = [{ id: 'p1', name: 'perimeter' }, { id: 'p2', name: 'конвейер' }, { id: 'p3', name: 'лендинг' }];

  it('проекты со свежей активностью выше, внутри — свежие сверху; без проекта и удалённый проект — в конце', () => {
    const g = projectGroups([row('a', 'p2', 10), row('b', 'p1', 50), row('c', 'p2', 30), row('d', undefined, 99), row('e', 'нет-такого', 5)], projects);
    expect(g.map((x) => x.name)).toEqual(['perimeter', 'конвейер', null]);
    expect(g[1]!.rows.map((r) => (r.s as { id: string }).id)).toEqual(['c', 'a']);
    expect(g[2]!.rows.map((r) => (r.s as { id: string }).id)).toEqual(['d', 'e']);
  });

  it('includeEmpty — проекты без сессий тоже (для «+»), после активных, по алфавиту', () => {
    const g = projectGroups([row('a', 'p2', 10)], projects, { includeEmpty: true });
    expect(g.map((x) => x.name)).toEqual(['конвейер', 'лендинг', 'perimeter']); // русская сортировка: кириллица раньше латиницы
    expect(g[2]!.rows).toHaveLength(0);
  });
});

describe('порядок не скачет во время хода (sortAt)', () => {
  it('проекты и сессии упорядочены по sortAt, а не по последнему событию потока', () => {
    // a — работает в проекте p1, последнее событие только что (lastActivity 100), но ход начат в 10;
    // b — работает в p2, ход начат в 20 → p2 выше, хотя событие у a свежее
    const rows = [
      { s: mk('a', 'working', 100, { projectId: 'p1', sortAt: 10 }), group: 'working' as const },
      { s: mk('b', 'working', 90, { projectId: 'p2', sortAt: 20 }), group: 'working' as const },
    ];
    const g = projectGroups(rows, [{ id: 'p1', name: 'один' }, { id: 'p2', name: 'два' }]);
    expect(g.map((x) => x.projectId)).toEqual(['p2', 'p1']);
  });
  it('без sortAt (старый кэш) — по lastActivity, как раньше', () => {
    const l = layoutEnvs([{ env: 'vps', sessions: [mk('a', 'idle', 1, { items: done }), mk('b', 'idle', 2, { items: done })], projectName: () => undefined }]);
    expect(l.sections[0]!.rows.map((r) => r.s.id)).toEqual(['b', 'a']);
  });
});
