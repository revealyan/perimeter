import { describe, expect, it } from 'vitest';
import { clearQueued } from './queued';

const item = (kind: string, data: Record<string, unknown>) => ({ id: Math.random().toString(), kind, data, ts: 1 }) as never;

describe('реплика «в очереди» во время хода', () => {
  it('ответ агента на текущий шаг не снимает пометку; после результата инструмента — снимает; конец хода — снимает всё', () => {
    const q = item('user', { text: 'два', queued: true });
    const s = { items: [item('user', { text: 'раз' }), q] };
    clearQueued(s, true); // ответ ещё по старому запросу
    expect((q as { data: Record<string, unknown> }).data['queued']).toBe(true);
    (q as { data: Record<string, unknown> }).data['queuedArmed'] = true; // результат инструмента ушёл
    clearQueued(s, true); // следующий ответ — уже с репликой
    expect((q as { data: Record<string, unknown> }).data['queued']).toBeUndefined();
    const q2 = item('user', { text: 'три', queued: true });
    clearQueued({ items: [q2] }, false);
    expect((q2 as { data: Record<string, unknown> }).data['queued']).toBeUndefined();
  });
});
