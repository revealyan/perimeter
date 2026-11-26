// Реплики, отправленные во время хода («в очереди»): Claude Code подмешивает их в следующий запрос к модели.

/** Реплика ещё ждёт, пока агент её возьмёт (лента держит такие внизу, под строкой активности). */
export const isQueued = (it: { kind: string; data: Record<string, unknown> }): boolean => it.kind === 'user' && it.data['queued'] === true;

/**
 * Реплики «в очереди» агент взял. Claude Code подмешивает их в следующий запрос к модели — после результата
 * инструмента: ответ агента после этого (armedOnly) снимает пометку; конец хода — снимает все.
 * Взятые переезжают в конец ленты — туда, где агент их прочитал (перед его ответом): пока ждали, агент успел
 * написать что-то по старому запросу, и в ленте реплика стояла бы над ответом, который её не видел (владелец 26.11).
 */
export function clearQueued(s: { items: Array<{ kind: string; data: Record<string, unknown> }> }, armedOnly: boolean): void {
  const taken: typeof s.items = [];
  for (const it of s.items) {
    if (!isQueued(it)) continue;
    if (armedOnly && it.data['queuedArmed'] !== true) continue;
    delete it.data['queued'];
    delete it.data['queuedArmed'];
    taken.push(it);
  }
  if (taken.length === 0) return;
  const rest = s.items.filter((it) => !taken.includes(it));
  s.items.length = 0;
  s.items.push(...rest, ...taken);
}
