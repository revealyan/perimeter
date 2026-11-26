import { describe, expect, it } from 'vitest';
import { isQuietState, isWaking, sendHold, WAKE_HOLD_MAX_MS } from './wake';

describe('сон сессий в окне', () => {
  it('отправку держим, пока просыпается по нашей просьбе или догружается лента; не дольше 20 с', () => {
    expect(sendHold({ state: 'initializing', waking: 1000 }, 1500)).toBe('просыпается…');
    expect(sendHold({ state: 'idle', waking: 1000 }, 1500)).toBeNull(); // поднялась
    expect(sendHold({ state: 'initializing' }, 1500)).toBeNull(); // новая/после сообщения — не держим
    expect(sendHold({ state: 'initializing', waking: 0 }, WAKE_HOLD_MAX_MS + 1)).toBeNull();
    expect(sendHold({ state: 'dead', resyncing: true }, 0)).toBe('догружаю ленту…');
    expect(sendHold({ state: 'dead' }, 0)).toBeNull(); // не будили (лимит, старый supervisor) — сообщение разбудит
    expect(isWaking({ state: 'initializing', waking: 5 }, 10)).toBe(true);
  });

  it('сон и пробуждение без хода — не активность (сессия не прыгает в списке)', () => {
    expect(isQuietState('idle', 'dead')).toBe(true);
    expect(isQuietState('dead', 'initializing')).toBe(true);
    expect(isQuietState('initializing', 'idle')).toBe(true);
    expect(isQuietState('idle', 'working')).toBe(false);
    expect(isQuietState('working', 'idle')).toBe(false); // конец хода — активность
  });
});
