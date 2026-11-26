// Обновление приложения (владелец 2026-11-25: «как-то обновление организовать»): electron-updater + GitHub Releases
// (CI публикует релизы сразу, рядом — latest.yml). Проверка при запуске и раз в 4 часа, скачивание в фоне,
// «Перезапустить и обновить» — по кнопке (идущие сессии на серверах не прерываются: они живут не в приложении).
// Обновляется только установленная версия (NSIS); portable так не умеет — ему ссылка на страницу релизов.

import { newer } from './npm-channel.mjs';

export const RELEASES_URL = 'https://github.com/revealyan/perimeter/releases/latest';
const CHECK_EVERY_MS = 4 * 3600_000;
const FIRST_CHECK_MS = 15_000;

/**
 * Состояние для окна:
 * { state: 'off', reason } — обновлений нет (dev / portable);
 * { state: 'idle' | 'checking' | 'latest' } · { state: 'available' | 'downloading', version, percent? }
 * · { state: 'ready', version } — скачано, ждёт перезапуска · { state: 'error', message }.
 */
export class AppUpdater {
  /**
   * @param {{ updater: any | null, version: string, portable: boolean, packaged: boolean, onState: (s: object) => void,
   *           manual?: boolean, openUrl?: (url: string) => void,
   *           npm?: { latest: () => Promise<string>, install: (v: string) => unknown, mode: string },
   *           setTimer?: typeof setTimeout, setEvery?: typeof setInterval }} deps
   * manual — macOS без подписи Apple Developer ID: Squirrel.Mac ставит только подписанное, поэтому новую версию
   * находим, но не качаем — «Скачать vX» ведёт на страницу релиза.
   */
  constructor(deps) {
    this.deps = deps;
    this.state = { state: 'idle', current: deps.version };
    if (!deps.packaged) this.set({ state: 'off', reason: 'сборка для разработки — обновления выключены' });
    // канал npm: версия — из реестра, ставит npm (electron-updater здесь не при чём)
    else if (deps.npm) this.set({ state: 'idle' });
    else if (deps.portable) this.set({ state: 'off', reason: 'portable-версия не обновляется сама', url: RELEASES_URL });
    else if (!deps.updater) this.set({ state: 'off', reason: 'модуль обновлений недоступен' });
    else this.wire();
  }

  set(s) {
    this.state = { ...s, current: this.deps.version };
    this.deps.onState(this.state);
  }

  wire() {
    const u = this.deps.updater;
    const manual = this.deps.manual === true;
    u.autoDownload = !manual;
    u.autoInstallOnAppQuit = !manual; // скачано, но не перезапустили — поставится при выходе
    u.on('checking-for-update', () => { if (this.state.state !== 'downloading' && this.state.state !== 'ready') this.set({ state: 'checking' }); });
    u.on('update-not-available', () => this.set({ state: 'latest' }));
    u.on('update-available', (i) => this.set({ state: 'available', version: String(i?.version ?? ''), ...(manual ? { manual: true, url: RELEASES_URL } : {}) }));
    u.on('download-progress', (p) => this.set({ state: 'downloading', version: this.state.version ?? '', percent: Math.round(Number(p?.percent ?? 0)) }));
    u.on('update-downloaded', (i) => this.set({ state: 'ready', version: String(i?.version ?? this.state.version ?? '') }));
    u.on('error', (e) => {
      // сеть пропала посреди проверки — не повод пугать: покажем ошибку, следующая проверка через 4 часа
      if (this.state.state !== 'ready') this.set({ state: 'error', message: String(e?.message ?? e).split('\n')[0].slice(0, 160) });
    });
  }

  /** Плановые проверки: через 15 с после запуска и раз в 4 часа. */
  start() {
    if (this.state.state === 'off') return;
    const t = this.deps.setTimer ?? setTimeout;
    const every = this.deps.setEvery ?? setInterval;
    t(() => void this.check(), FIRST_CHECK_MS);
    every(() => void this.check(), CHECK_EVERY_MS);
  }

  /** Проверить сейчас (кнопка в настройках). */
  async check() {
    if (this.deps.npm && this.state.state !== 'off') {
      if (this.state.state === 'available') return this.state;
      this.set({ state: 'checking' });
      try {
        const v = await this.deps.npm.latest();
        this.set(newer(v, this.deps.version) ? { state: 'available', version: v, npm: true } : { state: 'latest' });
      } catch (e) {
        this.set({ state: 'error', message: String(e?.message ?? e).split('\n')[0].slice(0, 160) });
      }
      return this.state;
    }
    if (this.state.state === 'off' || this.state.state === 'downloading' || this.state.state === 'ready' || (this.state.state === 'available' && this.state.manual)) return this.state;
    try {
      await this.deps.updater.checkForUpdates();
    } catch (e) {
      this.set({ state: 'error', message: String(e?.message ?? e).split('\n')[0].slice(0, 160) });
    }
    return this.state;
  }

  /**
   * Перезапустить и поставить скачанное — молча (/S) и с перезапуском (--force-run): мастер установщика — только
   * для первой установки (выбор папки). Владелец 2026-11-26: «визард с установкой пихается в ебало при обновлении» —
   * было quitAndInstall(false, …), т. е. NSIS с окнами.
   */
  install() {
    // канал npm: помощник поставит новую версию после выхода и запустит её
    if (this.state.state === 'available' && this.state.npm) { this.deps.npm.install(this.state.version); return true; }
    // мак без подписи: «Скачать vX» — страница релиза (поставить новую версию поверх старой руками)
    if (this.state.state === 'available' && this.state.manual) { this.deps.openUrl?.(this.state.url); return true; }
    if (this.state.state !== 'ready') return false;
    this.deps.updater.quitAndInstall(true, true);
    return true;
  }
}
