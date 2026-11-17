// Браузер на сервере — чистые функции: адресная строка, вписывание кадра, перевод мыши и клавиш в ввод CDP.

/** Что ввели в адресную строку → что открыть: адрес как есть (схему допишет сервер) или поиск. */
export function rbAddress(input: string): string {
  const s = input.trim();
  if (s === '') return 'about:blank';
  if (/^(https?:\/\/|about:)/i.test(s)) return s;
  const looksLikeHost = !/\s/.test(s) && (
    /^(localhost|\[::1\])(:\d+)?(\/|$)/i.test(s)
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)
    || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(s)
    || /^[\w.-]+:\d+(\/|$)/.test(s)
  );
  return looksLikeHost ? s : `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

/** Кадр вписывается в область без растяжения (уменьшается, но не увеличивается). */
export function fitFrame(stage: { w: number; h: number }, frame: { w: number; h: number }): { w: number; h: number } {
  if (frame.w <= 0 || frame.h <= 0 || stage.w <= 0 || stage.h <= 0) return { w: 0, h: 0 };
  const k = Math.min(stage.w / frame.w, stage.h / frame.h, 1);
  return { w: Math.round(frame.w * k), h: Math.round(frame.h * k) };
}

/** Точка на картинке (экранные координаты) → координаты страницы в браузере на сервере. */
export function toFramePoint(
  p: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  frame: { w: number; h: number },
): { x: number; y: number } {
  const kx = rect.width > 0 ? frame.w / rect.width : 1;
  const ky = rect.height > 0 ? frame.h / rect.height : 1;
  const x = Math.min(Math.max((p.x - rect.left) * kx, 0), frame.w);
  const y = Math.min(Math.max((p.y - rect.top) * ky, 0), frame.h);
  return { x: Math.round(x), y: Math.round(y) };
}

interface ModKeys { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

/** Модификаторы в битах CDP: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(e: ModKeys): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export function cdpButton(button: number): 'left' | 'middle' | 'right' | 'none' {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : 'none';
}

export interface RbKeyInput {
  kind: 'key';
  type: 'down' | 'up';
  key: string;
  code?: string;
  text?: string;
  keyCode?: number;
  modifiers?: number;
}

/**
 * Клавиша → ввод CDP. Печатаемый символ (без Ctrl/Meta) идёт с text, Enter — с «\r».
 * null — клавишу не пересылаем: Ctrl/Cmd+V (вставка придёт отдельным событием paste целиком).
 */
export function keyInput(e: ModKeys & { key: string; code: string; keyCode: number }, type: 'down' | 'up'): RbKeyInput | null {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyV' || e.key.toLowerCase() === 'v')) return null;
  const mods = cdpModifiers(e);
  const printable = type === 'down' && !e.ctrlKey && !e.metaKey && (e.key.length === 1 || e.key === 'Enter');
  return {
    kind: 'key', type,
    key: e.key.slice(0, 32),
    ...(e.code ? { code: e.code.slice(0, 32) } : {}),
    ...(printable ? { text: e.key === 'Enter' ? '\r' : e.key } : {}),
    ...(e.keyCode ? { keyCode: e.keyCode } : {}),
    ...(mods ? { modifiers: mods } : {}),
  };
}

/** Колесо: строки и страницы — в пиксели (CDP ждёт пиксели). */
export function wheelDelta(e: { deltaX: number; deltaY: number; deltaMode: number }, pageH: number): { deltaX: number; deltaY: number } {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageH : 1;
  return { deltaX: Math.round(e.deltaX * k), deltaY: Math.round(e.deltaY * k) };
}

/** Размер области → размер окна браузера на сервере (в пределах, которые принимает протокол). */
export function rbViewport(w: number, h: number): { width: number; height: number } {
  return {
    width: Math.min(Math.max(Math.floor(w), 320), 2560),
    height: Math.min(Math.max(Math.floor(h), 240), 1600),
  };
}
