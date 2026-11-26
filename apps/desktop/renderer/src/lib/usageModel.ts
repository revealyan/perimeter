// Лимиты аккаунта (usage) — подписи и тон для полосок и строки статуса.
import type { UsageWindow } from '@perimeter/protocol';

/** Короткая подпись окна для строки статуса: «5ч», «нед», «нед·Opus». */
export function shortLabel(w: UsageWindow): string {
  const l = w.label;
  if (/^5 час/.test(l)) return '5ч';
  if (/^неделя$/.test(l)) return 'нед';
  const m = /^неделя · (.+)$/.exec(l);
  if (m) return `нед·${m[1]}`;
  if (/^MCP/.test(l)) return 'MCP';
  return l;
}

/** Тон по заполненности: ≥90 — красный, ≥75 — жёлтый. */
export const usageTone = (pct: number): 'err' | 'warn' | 'ok' => (pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok');

/** «через 2 ч 10 мин» / «через 3 дн. 11 ч» / «скоро». */
export function resetIn(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return '';
  const ms = at - now;
  if (ms <= 60_000) return 'скоро';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `через ${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `через ${h} ч${min % 60 ? ` ${min % 60} мин` : ''}`;
  // недельное окно: «через 3 дн.» при 3 дн. 11 ч сбивало с толку — часы видны, пока до сброса меньше недели
  const d = Math.floor(h / 24);
  return `через ${d} дн.${h % 24 && d < 7 ? ` ${h % 24} ч` : ''}`;
}

/** Окна для строки статуса: первые два (короткое и недельное). */
export const barWindows = (ws: UsageWindow[]): UsageWindow[] => ws.slice(0, 2);
