// Инвариант 2 (реестр): save/load roundtrip, битый файл не роняет старт.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from './state-store.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('StateStore', () => {
  it('roundtrip: сохранили — загрузили как есть', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-state-')); dirs.push(dir);
    const store = new StateStore(join(dir, 'state.json'));
    store.save([
      { id: '4265f11d-e860-47ad-9b54-306e22e68390', name: 'прогон', cwd: '/opt/x', lastSeq: 41 },
      { id: '716a6187-e2e9-46b0-a2bf-8c584856423b', name: 'вторая', model: 'glm-5.3[1m]', lastSeq: 0 },
    ]);
    const loaded = store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ name: 'прогон', lastSeq: 41 });
  });

  it('битые записи не валят hello: без uuid/seq — пропуск, без имени — имя по id, поля не той формы — прочь', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-state-')); dirs.push(dir);
    const f = join(dir, 'state.json');
    writeFileSync(f, JSON.stringify({ version: 1, savedAt: 0, sessions: [
      { id: '4265f11d-e860-47ad-9b54-306e22e68390', name: 'ок', lastSeq: 3, model: 'sonnet' },
      { id: '716a6187-e2e9-46b0-a2bf-8c584856423b', lastSeq: 1, model: null, archived: 'да', profile: 5 },
      { id: 'не-uuid', name: 'x', lastSeq: 1 },
      { id: 'a26a6187-e2e9-46b0-a2bf-8c584856423b', name: 'без seq' },
    ] }), 'utf8');
    const loaded = new StateStore(f).load();
    expect(loaded).toEqual([
      { id: '4265f11d-e860-47ad-9b54-306e22e68390', name: 'ок', lastSeq: 3, model: 'sonnet' },
      { id: '716a6187-e2e9-46b0-a2bf-8c584856423b', name: 'сессия-716a6187', lastSeq: 1 },
    ]);
  });

  it('нет файла → пусто; битый JSON → пусто; не тот version → пусто', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-state-')); dirs.push(dir);
    expect(new StateStore(join(dir, 'нет.json')).load()).toEqual([]);
    const f = join(dir, 'bit.json');
    writeFileSync(f, '{{{не json', 'utf8');
    expect(new StateStore(f).load()).toEqual([]);
    writeFileSync(f, JSON.stringify({ version: 99, sessions: [] }), 'utf8');
    expect(new StateStore(f).load()).toEqual([]);
  });

  it('воркер делегирования: parentSessionId/agentOf переживают round-trip, кривой uuid отброшен', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-state-')); dirs.push(dir);
    const f = join(dir, 'state.json');
    const parent = '4265f11d-e860-47ad-9b54-306e22e68390';
    new StateStore(f).save([
      { id: '716a6187-e2e9-46b0-a2bf-8c584856423b', name: 'сабагент', lastSeq: 2, parentSessionId: parent, agentOf: 'delegate_to_agent', profile: 'zai' },
    ]);
    const loaded = new StateStore(f).load();
    expect(loaded[0]!.parentSessionId).toBe(parent);
    expect(loaded[0]!.agentOf).toBe('delegate_to_agent');
    // кривой родитель в файле не должен ронять hello — поле отбрасывается
    writeFileSync(f, JSON.stringify({ version: 1, savedAt: 0, sessions: [
      { id: parent, name: 'родитель', lastSeq: 0 },
      { id: '716a6187-e2e9-46b0-a2bf-8c584856423b', name: 'воркер', lastSeq: 1, parentSessionId: 'не-uuid', agentOf: 5 },
    ] }), 'utf8');
    const again = new StateStore(f).load();
    expect(again).toHaveLength(2);
    expect(again[1]!.parentSessionId).toBeUndefined();
    expect(again[1]!.agentOf).toBeUndefined();
  });
});
