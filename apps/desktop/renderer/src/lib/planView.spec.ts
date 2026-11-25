import { describe, expect, it } from 'vitest';
import { compactPlan } from './planView';

const plan = (statuses: Array<'pending' | 'in_progress' | 'completed'>) => ({
  items: statuses.map((status, i) => ({ text: `задача ${i + 1}`, status })),
  done: statuses.filter((s) => s === 'completed').length,
  total: statuses.length,
  itemId: 'x',
});

describe('компактный список задач', () => {
  it('сверху — в работе, затем ближайшие несделанные; выполненные — только числом', () => {
    const v = compactPlan(plan(['completed', 'completed', 'pending', 'in_progress', 'pending', 'pending', 'pending']));
    expect(v.top.map((t) => t.text)).toEqual(['задача 4', 'задача 3', 'задача 5']);
    expect(v.morePending).toBe(2);
    expect(v.done).toBe(2);
  });
  it('мало задач — все несделанные видны, «ещё» нет', () => {
    const v = compactPlan(plan(['in_progress', 'pending']));
    expect(v.top).toHaveLength(2);
    expect(v.morePending).toBe(0);
  });
});
