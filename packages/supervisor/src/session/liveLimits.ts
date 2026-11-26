// Лимиты живых процессов claude по умолчанию — от памяти машины (см. LiveLimits в manager.ts).
// Процесс сессии ~165–280 МБ (замер 26.11 на VPS), плюс MCP-серверы аккаунта; 1 ГБ — системе и supervisor'у.
import type { LiveLimits } from './manager.js';

const MB = 1024 * 1024;
/** сколько памяти закладываем на одну живую сессию */
const PER_SESSION_MB = 400;

/**
 * maxLive: (память − 1 ГБ) / 400 МБ, от 2 до 16 (4 ГБ → 7, 32 ГБ → 16); PERIMETER_MAX_LIVE — явно (0 — без лимита).
 * Заранее не будим, если свободно меньше 300 МБ (PERIMETER_WAKE_MIN_FREE_MB); разбуженная без хода гаснет через
 * 5 минут простоя (PERIMETER_WAKE_IDLE_MS), но не позже обычного простоя.
 */
export function defaultLiveLimits(totalBytes: number, env: Record<string, string | undefined>, freeMem: () => number): LiveLimits {
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const explicit = num(env['PERIMETER_MAX_LIVE']);
  const byMemory = Math.min(16, Math.max(2, Math.floor((totalBytes / MB - 1024) / PER_SESSION_MB)));
  return {
    maxLive: explicit === undefined ? byMemory : explicit === 0 ? Infinity : Math.floor(explicit),
    wakeIdleMs: num(env['PERIMETER_WAKE_IDLE_MS']) ?? 5 * 60_000,
    minFreeBytes: (num(env['PERIMETER_WAKE_MIN_FREE_MB']) ?? 300) * MB,
    freeMem,
  };
}
