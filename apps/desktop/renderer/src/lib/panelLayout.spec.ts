import { describe, expect, it } from 'vitest';
import {
  PANEL_DEFAULT, answerHotkey, clampHeight, clampRect, clampWidth, dockTo, fitTabs, normalizePanelState,
  panelHotkey, resizeRect, snapZone, toggleTab, zoneRect, type KeyLike,
} from './panelLayout';

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
const AREA = { left: 320, top: 0, right: 1440, bottom: 900 };

describe('панели: размеры и clamp', () => {
  it('ширина справа/слева — 360…900', () => {
    expect(clampWidth(200)).toBe(360);
    expect(clampWidth(1200)).toBe(900);
    expect(clampWidth(560.4)).toBe(560);
  });
  it('нижняя панель оставляет центру место', () => {
    expect(clampHeight(800, 900)).toBe(660);
    expect(clampHeight(50, 900)).toBe(180);
  });
  it('плавающее окно не уезжает за край при уменьшении окна', () => {
    expect(clampRect({ x: 1000, y: 700, w: 560, h: 600 }, { w: 1200, h: 800 })).toEqual({ x: 640, y: 200, w: 560, h: 600 });
    expect(clampRect({ x: -40, y: -10, w: 560, h: 600 }, { w: 1440, h: 900 })).toEqual({ x: 0, y: 0, w: 560, h: 600 });
  });
  it('окно больше границ — ужимается до границ', () => {
    expect(clampRect({ x: 0, y: 0, w: 2000, h: 1200 }, { w: 1000, h: 700 })).toEqual({ x: 0, y: 0, w: 1000, h: 700 });
  });
  it('ресайз за правый нижний угол и за левый край (правый край стоит)', () => {
    const r = { x: 100, y: 100, w: 500, h: 400 };
    expect(resizeRect(r, 'se', 40, -20)).toEqual({ x: 100, y: 100, w: 540, h: 380 });
    expect(resizeRect(r, 'w', 60, 0)).toEqual({ x: 160, y: 100, w: 440, h: 400 });
    expect(resizeRect(r, 'nw', 400, 400)).toEqual({ x: 260, y: 260, w: 340, h: 240 }); // не меньше минимума
  });
});

describe('панели: прилипание к краям', () => {
  it('у правого края — зона справа, у нижнего — снизу, у сайдбара — слева', () => {
    expect(snapZone({ x: 1420, y: 400 }, AREA)).toBe('right');
    expect(snapZone({ x: 800, y: 880 }, AREA)).toBe('bottom');
    expect(snapZone({ x: 340, y: 400 }, AREA)).toBe('left');
  });
  it('в середине — без прилипания', () => {
    expect(snapZone({ x: 800, y: 400 }, AREA)).toBeNull();
  });
  it('в углу побеждает ближний край; за краем окна — тоже прилипает', () => {
    expect(snapZone({ x: 1430, y: 870 }, AREA)).toBe('right');
    expect(snapZone({ x: 1400, y: 899 }, AREA)).toBe('bottom');
    expect(snapZone({ x: 1500, y: 400 }, AREA)).toBe('right');
    expect(snapZone({ x: 100, y: 400 }, AREA)).toBe('left');
  });
  it('подсветка зоны — там, где встанет панель', () => {
    expect(zoneRect('right', AREA, { width: 560, height: 320 })).toEqual({ x: 880, y: 0, w: 560, h: 900 });
    expect(zoneRect('left', AREA, { width: 560, height: 320 })).toEqual({ x: 320, y: 0, w: 560, h: 900 });
    expect(zoneRect('bottom', AREA, { width: 560, height: 320 })).toEqual({ x: 320, y: 580, w: 1120, h: 320 });
  });
});

describe('панели: состояние', () => {
  it('мусор из localStorage — значения по умолчанию', () => {
    expect(normalizePanelState(null)).toEqual(PANEL_DEFAULT);
    expect(normalizePanelState({ dock: 'top', tab: 'x', width: 'wide' })).toEqual(PANEL_DEFAULT);
  });
  it('сохранённое восстанавливается, ширина — в пределах', () => {
    const s = normalizePanelState({ open: false, tab: 'tasks', dock: 'floating', lastDock: 'bottom', width: 2000, float: { x: 10, y: 20, w: 400, h: 300 } });
    expect(s).toMatchObject({ open: false, tab: 'tasks', dock: 'floating', lastDock: 'bottom', width: 900, float: { x: 10, y: 20, w: 400, h: 300 } });
  });
  it('иконка вкладки: та же открытая — закрыть, другая — переключить', () => {
    const s = { ...PANEL_DEFAULT, open: true, tab: 'changes' as const };
    expect(toggleTab(s, 'changes').open).toBe(false);
    expect(toggleTab(s, 'tasks')).toMatchObject({ open: true, tab: 'tasks' });
    expect(toggleTab({ ...s, open: false }, 'changes').open).toBe(true);
  });
  it('прикрепление запоминает край для возврата из плавающей', () => {
    expect(dockTo({ ...PANEL_DEFAULT, dock: 'floating' }, 'bottom')).toMatchObject({ dock: 'bottom', lastDock: 'bottom', open: true });
  });
});

describe('панели: клавиши', () => {
  it('Ctrl Shift D/E/B/T, Ctrl `, Ctrl \\, Ctrl Shift F', () => {
    expect(panelHotkey(key('KeyD', { ctrlKey: true, shiftKey: true }))).toEqual({ tab: 'changes' });
    expect(panelHotkey(key('KeyE', { ctrlKey: true, shiftKey: true }))).toEqual({ tab: 'files' });
    expect(panelHotkey(key('KeyB', { ctrlKey: true, shiftKey: true }))).toEqual({ tab: 'browser' });
    expect(panelHotkey(key('KeyT', { ctrlKey: true, shiftKey: true }))).toEqual({ tab: 'tasks' });
    expect(panelHotkey(key('Backquote', { ctrlKey: true }))).toEqual({ tab: 'terminal' });
    expect(panelHotkey(key('Backslash', { ctrlKey: true }))).toBe('toggle');
    expect(panelHotkey(key('KeyF', { ctrlKey: true, shiftKey: true }))).toBe('fullscreen');
  });
  it('синтетические события без code — по латинскому key', () => {
    expect(panelHotkey(key('', { key: '\\', ctrlKey: true }))).toBe('toggle');
    expect(panelHotkey(key('', { key: 'D', ctrlKey: true, shiftKey: true }))).toEqual({ tab: 'changes' });
    expect(answerHotkey(key('', { key: 'y' }))).toBe('allow');
    expect(answerHotkey(key('', { key: 'н' }))).toBeNull(); // кириллица без code — не угадываем
  });
  it('без Ctrl и чужие сочетания — мимо', () => {
    expect(panelHotkey(key('KeyD', { shiftKey: true }))).toBeNull();
    expect(panelHotkey(key('KeyD', { ctrlKey: true }))).toBeNull();
    expect(panelHotkey(key('KeyN', { ctrlKey: true }))).toBeNull();
  });
  it('Y/N/A — по физической кнопке и без модификаторов', () => {
    expect(answerHotkey(key('KeyY'))).toBe('allow');
    expect(answerHotkey(key('KeyN'))).toBe('deny');
    expect(answerHotkey(key('KeyA'))).toBe('always');
    expect(answerHotkey(key('KeyY', { ctrlKey: true }))).toBeNull();
    expect(answerHotkey(key('KeyA', { shiftKey: true }))).toBeNull();
  });
});

describe('панели: вкладки, которые не влезли', () => {
  const W = [110, 80, 100, 90, 90, 100];
  it('всё влезает — всё видно', () => {
    expect(fitTabs(W, 600, 28, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('не влезло — хвост уходит в «⋯»', () => {
    expect(fitTabs(W, 420, 28, 0)).toEqual([0, 1, 2, 3]);
  });
  it('активная видна всегда — вытесняет последнюю видимую', () => {
    expect(fitTabs(W, 420, 28, 5)).toEqual([0, 1, 2, 5]);
    expect(fitTabs(W, 300, 28, 5)).toEqual([0, 5]);
  });
});
