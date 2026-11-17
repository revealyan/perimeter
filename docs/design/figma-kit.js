// Набор помощников для use_figma (вставлять в начало каждого скрипта; состояние между вызовами не живёт).
// Правила ui-craft: отступы только из шкалы (иначе скрипт падает), явные заливки у каждого контейнера,
// иконки Lucide 16px (stroke 2 на viewBox 24 = 1.33), тексты с переносом — FILL + HEIGHT после appendChild.
//
// Грабли (найдены на вариантах A–D):
// - node.query() падает на кириллице в селекторе — findAll(n => n.name === '…').
// - Однострочный текст с многоточием: textAutoResize='HEIGHT'; textTruncation='ENDING'; maxLines=1 (НЕ 'TRUNCATE').
// - В JetBrains Mono в Фигме нет глифов ✓ ○ ◐ ⏎ ✗ (есть ● › ▾ ◆ − ← →) — такие глифы отдельным текстом Inter.
// - JetBrains Mono склеивает === в лигатуру (отключить через API нельзя) — для кода Roboto Mono / IBM Plex Mono.
// - Обводка входит в размер авто-лейаута (+2px) — strokesIncludedInLayout=false (сделано в AL).
// - Шрифтов, которых нет у сервера Фигмы (SF Pro и т. п.), на скриншоте не видно — проверять скриншотом.
// - После смены шрифта у текста с переносом ширина может обнулиться и раздуть высоту — снова FIXED + resize, затем FILL.
// - Пустой авто-лейаут без детей не схлопывается, а висит 100px (раздувает строку таблицы) — пустые контейнеры удалять.
// - Помощник, который меняет текст, не должен менять и name узла: дальше findOne(n => n.name === 'мета') вернёт null.
// - Белый текст на #7c8cff ≈ 3:1 — на светлом акценте текст тёмный; #c2603e + белый 13px ≈ 4.2:1 (на грани AA).

const SCALE = [4, 8, 12, 16, 24, 32, 40, 48, 64];
const sp = (v) => { if (v === 0 || SCALE.includes(v) || (v > 64 && v % 4 === 0)) return v; throw new Error('отступ вне шкалы: ' + v); };
const hex = (h) => { h = h.replace('#', '').toLowerCase(); const d = '0123456789abcdef'; const n = (i) => d.indexOf(h[i]) * 16 + d.indexOf(h[i + 1]); return { r: n(0) / 255, g: n(2) / 255, b: n(4) / 255 }; };
const paint = (h, o) => [{ type: 'SOLID', color: hex(h), ...(o !== undefined ? { opacity: o } : {}) }];

/** Авто-лейаут: dir 'HORIZONTAL'|'VERTICAL'; p = [верх, право, низ, лево]; bg/stroke — hex; bgO — прозрачность заливки. */
function AL(dir, o = {}) {
  const f = figma.createAutoLayout(dir);
  f.name = o.name || dir;
  f.itemSpacing = sp(o.gap ?? 0);
  const p = o.p ?? [0, 0, 0, 0];
  f.paddingTop = sp(p[0]); f.paddingRight = sp(p[1]); f.paddingBottom = sp(p[2]); f.paddingLeft = sp(p[3]);
  f.fills = o.bg ? paint(o.bg, o.bgO) : [];
  if (o.r) f.cornerRadius = o.r;
  if (o.stroke) { f.strokes = paint(o.stroke, o.strokeO); f.strokeWeight = o.sw ?? 1; f.strokeAlign = 'INSIDE'; f.strokesIncludedInLayout = false; if (o.dash) f.dashPattern = [4, 4]; }
  if (o.align) f.counterAxisAlignItems = o.align;       // MIN | CENTER | MAX | BASELINE
  if (o.justify) f.primaryAxisAlignItems = o.justify;   // MIN | CENTER | MAX | SPACE_BETWEEN
  f.clipsContent = o.clip ?? false; // createAutoLayout по умолчанию режет содержимое — кольца фокуса обрезаются
  return f;
}
/** Текст; wrap=true — перенос по ширине родителя (вызвать после add). */
function T(txt, o = {}) {
  const t = figma.createText();
  t.fontName = o.font; t.fontSize = o.size ?? 14; t.characters = txt; t.fills = paint(o.color, o.colorO);
  if (o.lh) t.lineHeight = { unit: 'PIXELS', value: o.lh };
  if (o.ls) t.letterSpacing = { unit: 'PERCENT', value: o.ls };
  if (o.deco) t.textDecoration = o.deco;
  t.name = o.name || txt.slice(0, 28);
  return t;
}
function add(parent, ...kids) { for (const k of kids) if (k) parent.appendChild(k); return parent; }
/** Растянуть по ширине родителя (после add). Для текста — перенос строк. */
function W(n) { n.layoutSizingHorizontal = 'FILL'; if (n.type === 'TEXT') n.textAutoResize = 'HEIGHT'; return n; }
function H(n) { n.layoutSizingVertical = 'FILL'; return n; }
function fixed(n, w, h) { n.resize(w, h); n.layoutSizingHorizontal = 'FIXED'; n.layoutSizingVertical = 'FIXED'; return n; }
/** Распорка в горизонтальном ряду: забирает остаток ширины, высота 1. */
function grow(parent) { const s = figma.createFrame(); s.name = 'spacer'; s.fills = []; s.resize(1, 1); parent.appendChild(s); s.layoutGrow = 1; return s; }
function dot(color, size = 8) { const e = figma.createEllipse(); e.resize(size, size); e.fills = paint(color); e.name = 'dot'; return e; }
function rect(w, h, color, o = {}) { const r = figma.createRectangle(); r.resize(w, h); r.fills = paint(color, o.o); if (o.r) r.cornerRadius = o.r; r.name = o.name || 'rect'; return r; }

const ICON = {
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  filePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  fork: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
  panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  question: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  diff: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  wifiOff: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
};
/** Иконка Lucide; color — hex. */
function I(name, color, size = 16) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
  const n = figma.createNodeFromSvg(svg);
  n.name = 'icon/' + name; n.fills = [];
  return n;
}
/** Числовой QA: отступы вне шкалы в поддереве (пустой массив — критерий сдачи). */
function auditSpacing(root) {
  const off = [];
  const okSp = (v) => v === 0 || SCALE.includes(v) || (v > 64 && v % 4 === 0);
  const walk = (n) => {
    if (n.layoutMode && n.layoutMode !== 'NONE')
      for (const [p, v] of [['gap', n.itemSpacing], ['pt', n.paddingTop], ['pr', n.paddingRight], ['pb', n.paddingBottom], ['pl', n.paddingLeft]])
        if (!okSp(v)) off.push(n.name + '|' + p + '|' + v);
    if ('children' in n && !n.name.startsWith('icon/')) n.children.forEach(walk);
  };
  walk(root);
  return off;
}
