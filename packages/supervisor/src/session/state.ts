// Машина состояний сессии (docs/p0-design.md §4) — чистые функции, без побочных эффектов.
// Переходы вне таблицы запрещены: guard в тестах.

import type { SessionState } from '@perimeter/protocol';

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  creating: ['initializing', 'dead', 'error'],
  initializing: ['idle', 'working', 'dead', 'error'], // working: SDK стартует субпроцесс лениево — сообщение может прийти до init
  idle: ['working', 'waiting_permission', 'dead', 'error'], // waiting напрямую легитимен после resume/автохода
  working: [
    'idle',                    // ход завершился (turn.result)
    'waiting_permission',      // canUseTool
    'waiting_input',           // AskUserQuestion
    'interrupted',             // interrupt
    'dead',
    'error',
  ],
  waiting_permission: ['working', 'interrupted', 'idle', 'dead', 'error'], // respond → обратно в working
  waiting_input: ['working', 'interrupted', 'idle', 'dead', 'error'],
  interrupted: ['idle', 'dead', 'error'],
  error: ['idle', 'dead'], // повторная попытка или respawn
  dead: ['initializing'], // respawn через --resume (процесс создаётся заново)
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Счётчик seq на сессию: монотонный, без дыр (инвариант 1). seed — продолжение после рестарта. */
export class SeqCounter {
  private next: number;
  constructor(seed = 0) {
    this.next = seed;
  }
  take(): number {
    return this.next++;
  }
  /** текущий выданный (для hello/догона) */
  get last(): number {
    return this.next - 1;
  }
}

/** Валидация перехода с контекстом ошибки для лога. */
export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`запрещённый переход состояния сессии: ${from} → ${to}`);
  }
}
