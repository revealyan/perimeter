import { describe, expect, it } from 'vitest';
import { serverUpdateText, updateBadge, updateText } from './updateModel';

describe('обновление приложения: подписи', () => {
  it('настройки — по состоянию', () => {
    expect(updateText({ state: 'off', current: '0.2.6', reason: 'portable-версия не обновляется сама' })).toBe('portable-версия не обновляется сама');
    expect(updateText({ state: 'downloading', current: '0.2.6', version: '0.2.7', percent: 42 })).toBe('скачиваю 0.2.7 · 42%');
    expect(updateText({ state: 'ready', current: '0.2.6', version: '0.2.7' })).toBe('0.2.7 скачана — перезапустите, чтобы поставить');
    expect(updateText({ state: 'error', current: '0.2.6', message: 'net::ERR' })).toBe('не удалось проверить: net::ERR');
  });
  it('строка статуса — только качается или готово (кнопка)', () => {
    expect(updateBadge({ state: 'ready', current: '0.2.6', version: '0.2.7' })).toEqual({ text: 'Перезапустить: 0.2.7', action: true });
    expect(updateBadge({ state: 'downloading', current: '0.2.6', version: '0.2.7', percent: 5 })).toEqual({ text: 'обновление 0.2.7 · 5%', action: false });
    expect(updateBadge({ state: 'latest', current: '0.2.6' })).toBeNull();
    expect(updateBadge(null)).toBeNull();
  });
});

describe('автообновление supervisor: подписи', () => {
  it('ход, готово и ошибка — с именем сервера и версией', () => {
    expect(serverUpdateText({ connId: 'v', state: 'updating', version: '0.1.0-ab' }, 'Большой')).toBe('«Большой»: обновляю supervisor до 0.1.0-ab…');
    expect(serverUpdateText({ connId: 'v', state: 'failed', message: 'нет связи' }, 'Большой')).toMatch(/не обновился — нет связи/);
  });
});
