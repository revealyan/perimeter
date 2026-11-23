import { describe, expect, it } from 'vitest';
import { barWindows, resetIn, shortLabel, usageTone } from './usageModel';

const w = (label: string, pct = 1) => ({ id: label, label, pct });

describe('лимиты: подписи и тон', () => {
  it('короткие подписи окон', () => {
    expect(['5 часов', 'неделя', 'неделя · Opus', 'MCP · месяц', 'сутки'].map((l) => shortLabel(w(l)))).toEqual(['5ч', 'нед', 'нед·Opus', 'MCP', 'сутки']);
  });
  it('тон и «когда сброс»', () => {
    expect([usageTone(50), usageTone(80), usageTone(95)]).toEqual(['ok', 'warn', 'err']);
    expect(resetIn(1000 + 30_000, 1000)).toBe('скоро');
    expect(resetIn(1000 + 45 * 60_000, 1000)).toBe('через 45 мин');
    expect(resetIn(1000 + 130 * 60_000, 1000)).toBe('через 2 ч 10 мин');
    expect(resetIn(1000 + 3 * 86_400_000, 1000)).toBe('через 3 дн.');
    expect(resetIn(undefined)).toBe('');
  });
  it('в строку статуса — два первых окна', () => {
    expect(barWindows([w('5 часов'), w('неделя'), w('неделя · Opus')]).map((x) => x.label)).toEqual(['5 часов', 'неделя']);
  });
});
