// Поле ввода: два вида на выбор в настройках — «карточка» (C1, как в Claude Code) и
// «панель с ручкой» (C3, для длинных заданий). Чистые функции без React.

export type ComposerStyle = 'card' | 'panel';

export const COMPOSER_STYLE_KEY = 'perimeter:composer';
export const COMPOSER_HEIGHT_KEY = 'perimeter:composer-height';

export const COMPOSER_STYLE_LABEL: Record<ComposerStyle, string> = {
  card: 'Карточка',
  panel: 'Панель с ручкой',
};

export const COMPOSER_STYLE_HINT: Record<ComposerStyle, string> = {
  card: 'Отдельная карточка под лентой, растёт по тексту. Enter — отправить, Shift+Enter — новая строка.',
  panel: 'Своя панель под лентой, высоту тянут за ручку. Enter — новая строка, Ctrl+Enter — отправить.',
};

/** Незнакомое значение (старая версия, ручная правка) — карточка. */
export function parseComposerStyle(v: string | null | undefined): ComposerStyle {
  return v === 'panel' ? 'panel' : 'card';
}

/** Высота панели ввода: по умолчанию и нижняя граница; верхняя — доля окна, чтобы лента оставалась видна. */
export const PANEL_HEIGHT = { min: 140, def: 220, maxShare: 0.6 } as const;

export function clampPanelHeight(h: number, viewport: number): number {
  const max = Math.max(PANEL_HEIGHT.min, Math.round(viewport * PANEL_HEIGHT.maxShare));
  if (!Number.isFinite(h)) return Math.min(PANEL_HEIGHT.def, max);
  return Math.round(Math.min(max, Math.max(PANEL_HEIGHT.min, h)));
}

export function parsePanelHeight(v: string | null | undefined): number {
  if (v === null || v === undefined || v.trim() === '') return PANEL_HEIGHT.def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : PANEL_HEIGHT.def;
}

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

/**
 * Что делает Enter. Карточка: Enter — отправить, Shift+Enter — новая строка.
 * Панель (длинные задания): Enter — новая строка, Ctrl/Cmd+Enter — отправить.
 * Ctrl/Cmd+Enter отправляет в обоих видах. null — не Enter (или идёт набор через IME).
 */
export function enterAction(style: ComposerStyle, e: KeyLike): 'send' | 'newline' | null {
  if (e.key !== 'Enter' || e.isComposing === true) return null;
  if (e.ctrlKey || e.metaKey) return 'send';
  if (style === 'card') return e.shiftKey ? 'newline' : 'send';
  return 'newline';
}

/** Черновики по сессиям; в ключе среда — у VPS и этого компьютера свои сессии. */
export function draftKey(env: string, sid: string): string {
  return `perimeter:draft:${env}:${sid}`;
}

/** Хранилище «ключ → строка» (localStorage или подмена в тестах). */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Длинный черновик не должен съесть квоту localStorage. */
export const DRAFT_MAX = 50_000;

export function loadDraft(kv: KV, key: string): string {
  try { return kv.getItem(key) ?? ''; } catch { return ''; }
}

/** Пустой (из пробелов) черновик удаляется; возвращает, сохранено ли что-то. */
export function saveDraft(kv: KV, key: string, text: string): boolean {
  try {
    if (text.trim() === '') { kv.removeItem(key); return false; }
    kv.setItem(key, text.slice(0, DRAFT_MAX));
    return true;
  } catch {
    return false; // квота/приватный режим — черновик просто не переживёт перезапуск
  }
}
