import { describe, expect, it } from 'vitest';
import { loadSeen, newForeign, saveSeen } from './foreignScan';

describe('фоновый поиск сессий вне Perimeter', () => {
  it('первый скан — запомнить молча; дальше — только новые; хранилище по среде', () => {
    const first = newForeign([{ claudeSessionId: 'a' }, { claudeSessionId: 'b' }], new Set(), true);
    expect(first.fresh).toEqual([]);
    const next = newForeign([{ claudeSessionId: 'a' }, { claudeSessionId: 'c' }], first.seen, false);
    expect(next.fresh).toEqual(['c']);
    const m = new Map<string, string>();
    const ls = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    saveSeen(ls, 'vps', next.seen);
    expect([...loadSeen(ls, 'vps')].sort()).toEqual(['a', 'b', 'c']);
    expect(loadSeen(ls, 'local').size).toBe(0);
  });
});
