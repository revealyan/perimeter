// Система панелей (BD2): положение (справа/снизу/слева/плавающая), размеры, «на весь экран»,
// прилипание плавающей панели к краям, клавиши. Чистые функции без React и DOM.

export type PanelTab = 'changes' | 'files' | 'terminal' | 'browser' | 'ports' | 'tasks' | 'context';
export type DockSide = 'right' | 'bottom' | 'left';
export type Dock = DockSide | 'floating';

export const PANEL_TABS: PanelTab[] = ['changes', 'files', 'terminal', 'browser', 'ports', 'tasks', 'context'];

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

export interface PanelState {
  open: boolean;
  tab: PanelTab;
  dock: Dock;
  /** последнее прикреплённое положение: двойной клик по шапке плавающей возвращает сюда */
  lastDock: DockSide;
  /** ширина при креплении справа/слева */
  width: number;
  /** высота при креплении снизу */
  height: number;
  /** плавающая: положение и размер относительно окна приложения */
  float: Rect;
  /** панель занимает центр и своё место, сайдбар скрыт */
  fullscreen: boolean;
}

export const WIDTH_DEFAULT = 560;
export const WIDTH_MIN = 360;
export const WIDTH_MAX = 900;
export const HEIGHT_DEFAULT = 320;
export const HEIGHT_MIN = 180;
export const FLOAT_MIN: Size = { w: 340, h: 240 };
/** Насколько близко к краю окна должен быть курсор, чтобы показать зону прилипания. */
export const SNAP_DISTANCE = 56;

export const PANEL_DEFAULT: PanelState = {
  open: true,
  tab: 'changes',
  dock: 'right',
  lastDock: 'right',
  width: WIDTH_DEFAULT,
  height: HEIGHT_DEFAULT,
  float: { x: 160, y: 96, w: WIDTH_DEFAULT, h: 600 },
  fullscreen: false,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function clampWidth(w: number): number {
  return Math.round(clamp(w, WIDTH_MIN, WIDTH_MAX));
}

/** Высота нижней панели: не меньше минимума и оставляет центру хотя бы 240 px. */
export function clampHeight(h: number, viewportH: number): number {
  return Math.round(clamp(h, HEIGHT_MIN, viewportH - 240));
}

/** Плавающее окно целиком внутри границ: размер не больше границ и не меньше минимума, затем положение. */
export function clampRect(r: Rect, bounds: Size, min: Size = FLOAT_MIN): Rect {
  const w = Math.round(clamp(r.w, Math.min(min.w, bounds.w), bounds.w));
  const h = Math.round(clamp(r.h, Math.min(min.h, bounds.h), bounds.h));
  return { x: Math.round(clamp(r.x, 0, bounds.w - w)), y: Math.round(clamp(r.y, 0, bounds.h - h)), w, h };
}

/** Края, за которые тянут плавающее окно: 'e' — правый, 'se' — правый нижний угол и т. д. */
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Ресайз плавающего окна за край/угол на (dx, dy) от стартового прямоугольника; противоположный край стоит. */
export function resizeRect(start: Rect, edge: Edge, dx: number, dy: number, min: Size = FLOAT_MIN): Rect {
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = Math.max(min.w, start.w + dx);
  if (edge.includes('s')) h = Math.max(min.h, start.h + dy);
  if (edge.includes('w')) {
    w = Math.max(min.w, start.w - dx);
    x = start.x + start.w - w;
  }
  if (edge.includes('n')) {
    h = Math.max(min.h, start.h - dy);
    y = start.y + start.h - h;
  }
  return { x, y, w, h };
}

/** Область, в которой живут панели (координаты окна): слева — после сайдбара. */
export interface WorkArea { left: number; top: number; right: number; bottom: number }

/** Зона прилипания под курсором: ближайший край рабочей области в пределах SNAP_DISTANCE. */
export function snapZone(p: { x: number; y: number }, area: WorkArea, distance = SNAP_DISTANCE): DockSide | null {
  // курсор за краем области (над сайдбаром, за окном) — расстояние 0
  const cand: Array<[DockSide, number]> = [
    ['right', Math.max(0, area.right - p.x)],
    ['left', Math.max(0, p.x - area.left)],
    ['bottom', Math.max(0, area.bottom - p.y)],
  ];
  let best: DockSide | null = null;
  let bestD = Infinity;
  for (const [side, d] of cand) {
    if (d <= distance && d < bestD) { best = side; bestD = d; }
  }
  return best;
}

/** Прямоугольник подсветки зоны прилипания (куда встанет панель). */
export function zoneRect(side: DockSide, area: WorkArea, s: Pick<PanelState, 'width' | 'height'>): Rect {
  const W = area.right - area.left;
  const H = area.bottom - area.top;
  const w = Math.min(clampWidth(s.width), W - 200);
  const h = Math.min(clampHeight(s.height, H), H - 120);
  if (side === 'right') return { x: area.right - w, y: area.top, w, h: H };
  if (side === 'left') return { x: area.left, y: area.top, w, h: H };
  return { x: area.left, y: area.bottom - h, w: W, h };
}

/** Состояние из localStorage: всё непонятное — по умолчанию. */
export function normalizePanelState(raw: unknown): PanelState {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = PANEL_DEFAULT;
  const dock: Dock = o['dock'] === 'right' || o['dock'] === 'bottom' || o['dock'] === 'left' || o['dock'] === 'floating' ? o['dock'] : d.dock;
  const lastDock: DockSide = o['lastDock'] === 'right' || o['lastDock'] === 'bottom' || o['lastDock'] === 'left' ? o['lastDock'] : d.lastDock;
  const f = typeof o['float'] === 'object' && o['float'] !== null ? (o['float'] as Record<string, unknown>) : {};
  return {
    open: typeof o['open'] === 'boolean' ? o['open'] : d.open,
    tab: PANEL_TABS.includes(o['tab'] as PanelTab) ? (o['tab'] as PanelTab) : d.tab,
    dock,
    lastDock,
    width: isNum(o['width']) ? clampWidth(o['width']) : d.width,
    height: isNum(o['height']) ? Math.max(HEIGHT_MIN, Math.round(o['height'])) : d.height,
    float: {
      x: isNum(f['x']) ? f['x'] : d.float.x,
      y: isNum(f['y']) ? f['y'] : d.float.y,
      w: isNum(f['w']) ? Math.max(FLOAT_MIN.w, f['w']) : d.float.w,
      h: isNum(f['h']) ? Math.max(FLOAT_MIN.h, f['h']) : d.float.h,
    },
    fullscreen: o['fullscreen'] === true,
  };
}

/** Клик по иконке вкладки: открыта эта же вкладка — закрыть панель, иначе открыть на ней. */
export function toggleTab(s: PanelState, tab: PanelTab): PanelState {
  if (s.open && s.tab === tab) return { ...s, open: false, fullscreen: false };
  return { ...s, open: true, tab };
}

/** Прикрепить к краю (из плавающей или другого края). */
export function dockTo(s: PanelState, side: DockSide): PanelState {
  return { ...s, open: true, dock: side, lastDock: side };
}

// ─── клавиши ────────────────────────────────────────────────────────────────

export interface KeyLike { code: string; key?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }

/** Физическая кнопка: по code (любая раскладка); если code пуст (синтетические события) — по латинскому key. */
function physical(e: KeyLike): string {
  if (e.code) return e.code;
  const k = e.key ?? '';
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
  if (k === '\\' || k === '|') return 'Backslash';
  if (k === '`' || k === '~') return 'Backquote';
  return '';
}
export type PanelHotkey = { tab: PanelTab } | 'toggle' | 'fullscreen';

/** Клавиши панелей по физическим кнопкам (code) — работают и в русской раскладке. */
export function panelHotkey(e: KeyLike): PanelHotkey | null {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl || e.altKey) return null;
  const code = physical(e);
  if (!e.shiftKey) {
    if (code === 'Backquote') return { tab: 'terminal' };
    if (code === 'Backslash') return 'toggle';
    return null;
  }
  switch (code) {
    case 'KeyD': return { tab: 'changes' };
    case 'KeyE': return { tab: 'files' };
    case 'KeyB': return { tab: 'browser' };
    case 'KeyT': return { tab: 'tasks' };
    case 'KeyF': return 'fullscreen';
    default: return null;
  }
}

/** Ответ на запрос разрешения клавишей Y / N / A (без модификаторов, по физической кнопке). */
export function answerHotkey(e: KeyLike): 'allow' | 'deny' | 'always' | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const code = physical(e);
  if (code === 'KeyY') return 'allow';
  if (code === 'KeyN') return 'deny';
  if (code === 'KeyA') return 'always';
  return null;
}

// ─── вкладки, которые не влезли ─────────────────────────────────────────────

/**
 * Какие вкладки показать в шапке шириной `available`: по порядку, пока влезают
 * (с местом под «⋯», если что-то не влезло); активная видна всегда — вытесняет последнюю видимую.
 */
export function fitTabs(widths: number[], available: number, moreW: number, active: number, gap = 0): number[] {
  const total = widths.reduce((n, w) => n + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return widths.map((_, i) => i);
  const room = available - moreW - gap;
  const shown: number[] = [];
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]! + (shown.length ? gap : 0);
    if (used + w > room) break;
    shown.push(i);
    used += w;
  }
  if (active >= 0 && active < widths.length && !shown.includes(active)) {
    while (shown.length > 0 && used + widths[active]! + gap > room) {
      const drop = shown.pop()!;
      used -= widths[drop]! + (shown.length ? gap : 0);
    }
    shown.push(active);
  }
  return shown;
}
