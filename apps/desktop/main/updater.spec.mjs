// Обновление приложения: состояния для окна по событиям electron-updater; dev и portable — выключено.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AppUpdater, RELEASES_URL } from './updater.mjs';

function fakeUpdater() {
  const u = new EventEmitter();
  u.checks = 0;
  u.installed = 0;
  u.checkForUpdates = async () => { u.checks++; };
  u.quitAndInstall = () => { u.installed++; };
  return u;
}

const make = (over = {}) => {
  const states = [];
  const updater = fakeUpdater();
  const timers = [];
  const a = new AppUpdater({ updater, version: '0.2.6', portable: false, packaged: true, onState: (s) => states.push(s), setTimer: (f, ms) => timers.push(['t', ms, f]), setEvery: (f, ms) => timers.push(['e', ms, f]), ...over });
  return { a, updater, states, timers };
};

describe('обновление приложения', () => {
  it('dev и portable — выключено (portable — со ссылкой на релизы); проверок не планирует', () => {
    const dev = make({ packaged: false });
    expect(dev.a.state).toMatchObject({ state: 'off', current: '0.2.6' });
    const port = make({ portable: true });
    expect(port.a.state).toMatchObject({ state: 'off', url: RELEASES_URL });
    port.a.start();
    expect(port.timers).toEqual([]);
  });

  it('проверка через 15 с и раз в 4 часа; события → состояния; скачано — перезапуск по кнопке', async () => {
    const { a, updater, states, timers } = make();
    a.start();
    expect(timers.map(([k, ms]) => [k, ms])).toEqual([['t', 15_000], ['e', 4 * 3600_000]]);
    await a.check();
    expect(updater.checks).toBe(1);
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '0.2.7' });
    updater.emit('download-progress', { percent: 42.4 });
    updater.emit('update-downloaded', { version: '0.2.7' });
    expect(states.slice(-4).map((s) => [s.state, s.version, s.percent])).toEqual([
      ['checking', undefined, undefined], ['available', '0.2.7', undefined], ['downloading', '0.2.7', 42], ['ready', '0.2.7', undefined],
    ]);
    // уже скачано — повторные проверки не сбивают «готово»
    await a.check();
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(a.state.state).toBe('ready');
    expect(a.install()).toBe(true);
    expect(updater.installed).toBe(1);
  });

  it('нет новой версии — «последняя»; ошибка сети — понятное состояние, перезапуск недоступен', async () => {
    const { a, updater } = make();
    updater.emit('update-not-available');
    expect(a.state.state).toBe('latest');
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n at …'));
    expect(a.state).toMatchObject({ state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
    expect(a.install()).toBe(false);
  });
});
