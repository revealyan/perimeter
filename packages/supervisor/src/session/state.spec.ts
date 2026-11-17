// Машина состояний: разрешённые/запрещённые переходы + монотонный seq.
import { describe, expect, it } from 'vitest';
import { SeqCounter, assertTransition, canTransition } from './state.js';

describe('переходы состояний сессии', () => {
  it('жизненный цикл create→init→idle→working→permission→working→idle проходит', () => {
    const путь = ['creating', 'initializing', 'idle', 'working', 'waiting_permission', 'working', 'idle'] as const;
    for (let i = 0; i + 1 < путь.length; i++) {
      expect(() => assertTransition(путь[i]!, путь[i + 1]!)).not.toThrow();
    }
  });

  it('respawn: dead → initializing разрешён, idle → dead разрешён', () => {
    expect(canTransition('dead', 'initializing')).toBe(true);
    expect(canTransition('idle', 'dead')).toBe(true);
  });

  it('запрещённые переходы бросают', () => {
    expect(() => assertTransition('creating', 'working')).toThrow();
    expect(() => assertTransition('idle', 'idle')).toThrow(); // no-op не в таблице
    expect(() => assertTransition('dead', 'working')).toThrow();
  });
});

describe('SeqCounter', () => {
  it('монотонный без дыр', () => {
    const s = new SeqCounter();
    expect([s.take(), s.take(), s.take()]).toEqual([0, 1, 2]);
    expect(s.last).toBe(2);
  });
});
