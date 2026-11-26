// Бесшовный сон сессий (владелец 2026-11-26): остывшую будим, когда её открыли или начали печатать, — к отправке
// процесс уже поднят; пока просыпается или догружается лента — отправку держим. Чистые функции без React.

/** Дольше не держим отправку: процесс так и не поднялся — пусть сообщение будит, как раньше. */
export const WAKE_HOLD_MAX_MS = 20_000;
/** Пауза после выбора сессии — листание списка не будит каждую встречную. */
export const WAKE_SELECT_DELAY_MS = 300;
/** Остывшую при наборе будим не чаще раза в 3 с; живой продлеваем простой не чаще раза в минуту. */
export const WAKE_COLD_THROTTLE_MS = 3_000;
export const WAKE_TOUCH_THROTTLE_MS = 60_000;

export interface WakeLike {
  state: string;
  /** когда попросили разбудить (окно); снимается, когда процесс поднялся или не смог */
  waking?: number;
  /** лента догружается (кэш/транскрипт) */
  resyncing?: boolean;
}

/** Остывшая: процесса нет, поднимется resume. */
export const isCold = (state: string): boolean => state === 'dead' || state === 'error';

/** Просыпается по нашей просьбе (а не «запускается» новая или после сообщения). */
export function isWaking(s: WakeLike, now: number): boolean {
  return s.waking !== undefined && s.state === 'initializing' && now - s.waking < WAKE_HOLD_MAX_MS;
}

/** Почему отправку пока держим (подпись кнопки); null — можно отправлять. */
export function sendHold(s: WakeLike, now: number): string | null {
  if (isWaking(s, now)) return 'просыпается…';
  if (s.resyncing) return 'догружаю ленту…';
  return null;
}

/**
 * Смена состояния — не активность, если это сон/пробуждение без хода: иначе остывшая (или разбуженная выбором)
 * сессия прыгает наверх списка.
 */
export function isQuietState(prev: string, next: string): boolean {
  return next === 'initializing' || next === 'dead' || (next === 'idle' && prev === 'initializing');
}
