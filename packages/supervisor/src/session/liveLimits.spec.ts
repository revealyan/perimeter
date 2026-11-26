import { describe, expect, it } from 'vitest';
import { defaultLiveLimits } from './liveLimits.js';

const GB = 1024 ** 3;
const free = () => 0;

describe('лимит живых процессов по умолчанию', () => {
  it('от памяти: 4 ГБ → 7, 32 ГБ → 16 (потолок), 2 ГБ → 2 (пол)', () => {
    expect(defaultLiveLimits(3.83 * GB, {}, free).maxLive).toBe(7); // Velohost: 3922 МБ
    expect(defaultLiveLimits(32 * GB, {}, free).maxLive).toBe(16);
    expect(defaultLiveLimits(2 * GB, {}, free).maxLive).toBe(2);
  });

  it('env: явный лимит, 0 — без лимита; мусор — по памяти; простой и запас памяти', () => {
    expect(defaultLiveLimits(4 * GB, { PERIMETER_MAX_LIVE: '3' }, free).maxLive).toBe(3);
    expect(defaultLiveLimits(4 * GB, { PERIMETER_MAX_LIVE: '0' }, free).maxLive).toBe(Infinity);
    expect(defaultLiveLimits(4 * GB, { PERIMETER_MAX_LIVE: 'много' }, free).maxLive).toBe(7);
    const l = defaultLiveLimits(4 * GB, { PERIMETER_WAKE_IDLE_MS: '60000', PERIMETER_WAKE_MIN_FREE_MB: '500' }, free);
    expect(l.wakeIdleMs).toBe(60_000);
    expect(l.minFreeBytes).toBe(500 * 1024 * 1024);
    expect(defaultLiveLimits(4 * GB, {}, free)).toMatchObject({ wakeIdleMs: 300_000, minFreeBytes: 300 * 1024 * 1024 });
  });
});
