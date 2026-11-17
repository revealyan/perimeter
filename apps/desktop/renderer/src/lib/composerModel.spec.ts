import { describe, expect, it } from 'vitest';
import {
  DRAFT_MAX, PANEL_HEIGHT, clampPanelHeight, draftKey, enterAction, loadDraft, parseComposerStyle, parsePanelHeight, saveDraft, type KV,
} from './composerModel';

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) =>
  ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

function memKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

describe('вид поля ввода', () => {
  it('по умолчанию — карточка; панель — только явным значением', () => {
    expect(parseComposerStyle(null)).toBe('card');
    expect(parseComposerStyle('что-то')).toBe('card');
    expect(parseComposerStyle('panel')).toBe('panel');
  });
});

describe('Enter', () => {
  it('карточка: Enter — отправить, Shift+Enter — новая строка', () => {
    expect(enterAction('card', key('Enter'))).toBe('send');
    expect(enterAction('card', key('Enter', { shiftKey: true }))).toBe('newline');
  });
  it('панель: Enter — новая строка, Ctrl/Cmd+Enter — отправить', () => {
    expect(enterAction('panel', key('Enter'))).toBe('newline');
    expect(enterAction('panel', key('Enter', { ctrlKey: true }))).toBe('send');
    expect(enterAction('panel', key('Enter', { metaKey: true }))).toBe('send');
  });
  it('Ctrl+Enter отправляет и из карточки; набор через IME и другие клавиши — не трогаем', () => {
    expect(enterAction('card', key('Enter', { ctrlKey: true }))).toBe('send');
    expect(enterAction('card', key('Enter', { isComposing: true }))).toBeNull();
    expect(enterAction('panel', key('a'))).toBeNull();
  });
});

describe('высота панели', () => {
  it('в пределах: не меньше минимума, не больше 60% окна', () => {
    expect(clampPanelHeight(50, 900)).toBe(PANEL_HEIGHT.min);
    expect(clampPanelHeight(300, 900)).toBe(300);
    expect(clampPanelHeight(800, 900)).toBe(540);
  });
  it('маленькое окно — минимум всё равно держится; мусор — значение по умолчанию', () => {
    expect(clampPanelHeight(400, 100)).toBe(PANEL_HEIGHT.min);
    expect(clampPanelHeight(Number.NaN, 900)).toBe(PANEL_HEIGHT.def);
    expect(parsePanelHeight(null)).toBe(PANEL_HEIGHT.def);
    expect(parsePanelHeight('abc')).toBe(PANEL_HEIGHT.def);
    expect(parsePanelHeight('-5')).toBe(PANEL_HEIGHT.def);
    expect(parsePanelHeight('312')).toBe(312);
  });
});

describe('черновики', () => {
  it('ключ различает среды', () => {
    expect(draftKey('vps', 's1')).not.toBe(draftKey('local', 's1'));
  });
  it('сохраняется и читается; пустой — удаляется', () => {
    const kv = memKV();
    const k = draftKey('vps', 's1');
    expect(saveDraft(kv, k, 'проверь README')).toBe(true);
    expect(loadDraft(kv, k)).toBe('проверь README');
    expect(saveDraft(kv, k, '   \n ')).toBe(false);
    expect(kv.data.has(k)).toBe(false);
    expect(loadDraft(kv, k)).toBe('');
  });
  it('слишком длинный обрезается; сбой хранилища не роняет поле', () => {
    const kv = memKV();
    saveDraft(kv, 'k', 'я'.repeat(DRAFT_MAX + 10));
    expect(kv.data.get('k')!.length).toBe(DRAFT_MAX);
    const broken: KV = { getItem: () => { throw new Error('нет'); }, setItem: () => { throw new Error('квота'); }, removeItem: () => undefined };
    expect(saveDraft(broken, 'k', 'текст')).toBe(false);
    expect(loadDraft(broken, 'k')).toBe('');
  });
});
