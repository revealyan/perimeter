// Вставка текста в строку ввода из других частей интерфейса (панель «Файлы» → «@ Упомянуть в сообщении»).
// Строка ввода одна (у активной сессии) — шлём событие окна, она вставляет в позицию курсора.

const EVENT = 'perimeter:composer-insert';

export function requestComposerInsert(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: text }));
}

/** Команда строке ввода (или её инструментам) из других частей интерфейса. */
export type ComposerAction = 'open-model' | 'open-account';

const ACTION_EVENT = 'perimeter:composer-action';

export function requestComposerAction(action: ComposerAction): void {
  window.dispatchEvent(new CustomEvent<ComposerAction>(ACTION_EVENT, { detail: action }));
}

export function onComposerAction(cb: (action: ComposerAction) => void): () => void {
  const on = (e: Event) => {
    const t = (e as CustomEvent<unknown>).detail;
    if (t === 'open-model' || t === 'open-account') cb(t);
  };
  window.addEventListener(ACTION_EVENT, on);
  return () => window.removeEventListener(ACTION_EVENT, on);
}

export function onComposerInsert(cb: (text: string) => void): () => void {
  const on = (e: Event) => {
    const t = (e as CustomEvent<unknown>).detail;
    if (typeof t === 'string' && t !== '') cb(t);
  };
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}

/**
 * После перерисовки: rAF, а если окно перекрыто (rAF тогда не срабатывает, хотя document.hidden === false) —
 * страховочный таймер; выполняется один раз — что наступит раньше.
 */
export function afterPaint(fn: () => void): void {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  setTimeout(run, 50);
}
