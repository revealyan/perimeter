// Реплики, отправленные во время хода («в очереди»): Claude Code подмешивает их в следующий запрос к модели.

/**
 * Реплики «в очереди» агент взял. Claude Code подмешивает их в следующий запрос к модели — после результата
 * инструмента: ответ агента после этого (armedOnly) снимает пометку; конец хода — снимает все.
 */
export function clearQueued(s: { items: Array<{ kind: string; data: Record<string, unknown> }> }, armedOnly: boolean): void {
  for (const it of s.items) {
    if (it.kind !== 'user' || it.data['queued'] !== true) continue;
    if (armedOnly && it.data['queuedArmed'] !== true) continue;
    delete it.data['queued'];
    delete it.data['queuedArmed'];
  }
}
