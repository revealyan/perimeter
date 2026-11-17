import { describe, expect, it } from 'vitest';
import type { PermissionCard, SessionView } from '../supervisor';
import { PROJECT_PALETTE, askTitle, groupOf, groupSessions, hasResult, projectColor, waitingInfo } from './sessionGroups';

const S = (id: string, state: string, extra: Partial<SessionView> = {}): SessionView => ({
  id, name: id, state, needs: null, items: [], permissions: [], printing: null, lastActivity: 0, ...extra,
});
const PERM: PermissionCard = { requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf dist\nnpm run build' }, at: 0 };

describe('сайдбар: группы по статусу', () => {
  it('состояние → группа', () => {
    expect(groupOf(S('a', 'waiting_permission'))).toBe('waiting');
    expect(groupOf(S('a', 'waiting_input'))).toBe('waiting');
    expect(groupOf(S('a', 'working', { permissions: [PERM] }))).toBe('waiting'); // карточка пришла раньше смены состояния
    expect(groupOf(S('a', 'working'))).toBe('working');
    expect(groupOf(S('a', 'initializing'))).toBe('working');
    expect(groupOf(S('a', 'creating'))).toBe('working');
    expect(groupOf(S('a', 'idle', { lastResult: { costUsd: 1 } }))).toBe('ready');
    expect(groupOf(S('a', 'interrupted', { items: [{ id: 'i', kind: 'text', data: {} }] }))).toBe('ready');
    expect(groupOf(S('a', 'idle'))).toBe('fresh');
    expect(groupOf(S('a', 'dead'))).toBe('cold');
    expect(groupOf(S('a', 'error'))).toBe('cold');
  });
  it('после ресинка итога хода нет, но ответ агента в ленте — «готова»', () => {
    expect(hasResult(S('a', 'idle', { items: [{ id: 't0', kind: 'tool-use', data: {} }] }))).toBe(true);
    expect(hasResult(S('a', 'idle', { items: [{ id: 't0', kind: 'user', data: {} }] }))).toBe(false);
  });
  it('порядок групп фиксирован, пустые скрыты, внутри — свежие сверху, архив отдельно', () => {
    const g = groupSessions([
      S('old-ready', 'idle', { lastResult: {}, lastActivity: 1 }),
      S('new-ready', 'idle', { lastResult: {}, lastActivity: 9 }),
      S('cold', 'dead', { lastActivity: 5 }),
      S('ask', 'waiting_permission', { lastActivity: 2 }),
      S('arch', 'idle', { archived: true, lastActivity: 3 }),
    ]);
    expect(g.groups.map((x) => x.id)).toEqual(['waiting', 'ready', 'cold']);
    expect(g.groups[1]!.sessions.map((s) => s.id)).toEqual(['new-ready', 'old-ready']);
    expect(g.archived.map((s) => s.id)).toEqual(['arch']);
    expect(g.total).toBe(4);
    expect(g.groups[0]!.label).toBe('Ждут тебя');
  });
  it('фильтр по проекту («без проекта» — null) и поиск по имени', () => {
    const list = [S('a', 'idle', { projectId: 'p1' }), S('b', 'idle', { projectId: 'gone' }), S('c', 'idle')];
    const known = new Set(['p1']);
    expect(groupSessions(list, { projectId: 'p1' }, known).total).toBe(1);
    // сессия исчезнувшего проекта считается «без проекта»
    expect(groupSessions(list, { projectId: null }, known).groups[0]!.sessions.map((s) => s.id)).toEqual(['b', 'c']);
    expect(groupSessions(list, { query: 'C' }).total).toBe(1);
  });
});

describe('сайдбар: что ждёт ответа', () => {
  it('разрешение: заголовок по инструменту и команда целиком', () => {
    const w = waitingInfo(S('a', 'waiting_permission', { permissions: [PERM] }));
    expect(w).toMatchObject({ kind: 'permission', title: 'Разрешить команду?', target: 'rm -rf dist\nnpm run build' });
    expect(askTitle('Edit')).toBe('Разрешить правку?');
    expect(askTitle('mcp__serena__find_symbol')).toBe('Разрешить «serena»?');
  });
  it('один вопрос с одиночным выбором — варианты прямо в карточке', () => {
    const card: PermissionCard = { ...PERM, toolName: 'AskUserQuestion', questions: [{ question: 'Где диф?', header: 'Диф', options: [{ label: 'В ленте' }, { label: 'В панели' }] }] };
    expect(waitingInfo(S('a', 'waiting_input', { permissions: [card] }))).toMatchObject({ kind: 'question', question: 'Где диф?', options: ['В ленте', 'В панели'], instant: true });
  });
  it('несколько вопросов или мультивыбор — только «Ответить»', () => {
    const q = { question: 'Что?', header: 'X', options: [{ label: 'a' }] };
    const multi: PermissionCard = { ...PERM, questions: [q, { ...q, question: 'Ещё?' }] };
    expect(waitingInfo(S('a', 'waiting_input', { permissions: [multi] }))).toMatchObject({ kind: 'question', instant: false, options: [], question: 'Что? (+1)' });
  });
  it('карточки ещё нет (ждёт по данным сервера) — текст needs', () => {
    expect(waitingInfo(S('a', 'waiting_input', { needs: 'вопрос' }))).toEqual({ kind: 'unknown', text: 'вопрос' });
  });
});

describe('цвет проекта', () => {
  it('стабилен, из палитры, не зависит от регистра', () => {
    expect(projectColor('perimeter')).toBe(projectColor('Perimeter '));
    expect(PROJECT_PALETTE).toContain(projectColor('что угодно'));
  });
  it('проекты сцены: цвет по имени (после переименования в perimeter хеш сменился), конвейер — сиреневый', () => {
    expect(projectColor('perimeter')).toBe('#c9a96e');
    expect(projectColor('конвейер')).toBe('#c48fe0');
  });
});
