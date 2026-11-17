// Удалённый браузер (ретрансляция): фейковый CDP (WebSocket-сервер) — вкладка, кадры и ack, ввод, навигация,
// лимит, простой, падение браузера; адрес и поиск браузера; плюс живой Chromium/Edge, если он есть на машине.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelError } from './errors.js';
import { fakeCdp } from './fake-cdp.js';
import { RemoteBrowserManager, chromiumArgs, displayMode, explainLaunchError, findChromium, findInPath, isSnapChromium, normalizeUrl, pickDisplay, snapScope, type RbSubscriber } from './rbrowser.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000, what = 'условие'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await sleep(10);
  }
}

function sub(): RbSubscriber & { got: Array<{ kind: string; f: Record<string, unknown> }> } {
  const got: Array<{ kind: string; f: Record<string, unknown> }> = [];
  return { got, send: (raw, kind) => got.push({ kind, f: JSON.parse(raw) as Record<string, unknown> }) };
}

const cleanups: Array<() => Promise<void> | void> = [];
// снимаем в обратном порядке: сперва менеджер (закрывает CDP), потом фейковый сервер
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

describe('адрес из строки ввода', () => {
  it('без схемы — https (локальные — http); http/https/about — как есть', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeUrl('https://a.b/c?d')).toBe('https://a.b/c?d');
    expect(normalizeUrl('')).toBe('about:blank');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });
  it('чужие схемы — отказ', () => {
    for (const u of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings']) {
      expect(() => normalizeUrl(u)).toThrow(PanelError);
    }
  });
});

describe('поиск браузера', () => {
  it('PERIMETER_CHROMIUM важнее; иначе PATH, не-snap — первыми', () => {
    expect(findChromium({ PERIMETER_CHROMIUM: '/opt/x/chrome' }, 'linux', () => false)).toBe('/opt/x/chrome');
    const have = new Set(['/usr/bin/chromium-browser', '/usr/bin/google-chrome']);
    expect(findChromium({ PATH: '/usr/bin' }, 'linux', (p) => have.has(p.replace(/\\/g, '/')))).toMatch(/google-chrome$/);
    expect(findChromium({ PATH: '' }, 'linux', (p) => p === '/snap/bin/chromium')).toBe('/snap/bin/chromium');
    expect(findChromium({ ProgramFiles: 'C:\\PF' }, 'win32', (p) => p === 'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe')).toBe('C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(findChromium({ PATH: '' }, 'linux', () => false)).toBeNull();
  });
  it('snap-обёртка узнаётся; без сессии — понятная ошибка вместо snapd', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-snapw-'));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const w = join(d, 'chromium-browser');
    writeFileSync(w, '#!/bin/sh\nexec /snap/bin/chromium "$@"\n');
    expect(isSnapChromium(w)).toBe(true);
    expect(isSnapChromium('/snap/bin/chromium')).toBe(true);
    expect(snapScope(w, { PERIMETER_CHROMIUM_SCOPE: 'off' })).toBe(false);
    expect(snapScope(w, { PERIMETER_CHROMIUM_SCOPE: 'on' })).toBe(true);
    expect(explainLaunchError('cmd_run.go:1861: The user yan cannot run snap applications on this system.')).toContain('enable-linger');
    expect(explainLaunchError('chrome: error while loading shared libraries: libgbm.so.1')).toContain('libgbm');
    expect(explainLaunchError('No usable sandbox! If you are running on Ubuntu 23.10+ … apparmor-userns-restrictions.md')).toContain('AppArmor');
    expect(explainLaunchError('что-то другое')).toBeNull();
    expect(chromiumArgs('/tmp/p', {})).not.toContain('--no-sandbox');
    expect(chromiumArgs('/tmp/p', { PERIMETER_CHROMIUM_NO_SANDBOX: '1' })[0]).toBe('--no-sandbox');
  });
});

describe('экран браузера: виртуальный (Xvfb) или без окна', () => {
  it('с окном — без headless и без «--disable-gpu», хранилище паролей простое; без окна — как раньше', () => {
    const head = chromiumArgs('/tmp/p', {}, { headful: true });
    expect(head).not.toContain('--headless=new');
    expect(head).not.toContain('--disable-gpu');
    expect(head).toContain('--password-store=basic');
    expect(head).toContain('--remote-debugging-address=127.0.0.1');
    const less = chromiumArgs('/tmp/p', {});
    expect(less).toContain('--headless=new');
    expect(less).toContain('--disable-gpu');
  });

  it('режим: Linux с Xvfb — xvfb; без Xvfb, на Windows и по PERIMETER_CHROMIUM_DISPLAY=headless — без окна', () => {
    expect(displayMode({}, 'linux', '/usr/bin/Xvfb')).toBe('xvfb');
    expect(displayMode({}, 'linux', null)).toBe('headless');
    expect(displayMode({ PERIMETER_CHROMIUM_DISPLAY: 'headless' }, 'linux', '/usr/bin/Xvfb')).toBe('headless');
    expect(displayMode({ PERIMETER_CHROMIUM_DISPLAY: 'xvfb' }, 'win32', null)).toBe('headless');
    expect(displayMode({ PERIMETER_CHROMIUM_DISPLAY: 'XVFB' }, 'linux', '/usr/bin/Xvfb')).toBe('xvfb');
  });

  it('свободный номер экрана — первый без lock-файла и сокета; всё занято — null', () => {
    const busy = new Set(['/tmp/.X99-lock', '/tmp/.X11-unix/X100']);
    expect(pickDisplay((p) => busy.has(p))).toBe(101);
    expect(pickDisplay(() => true, 99, 101)).toBeNull();
    const norm = (p: string) => p.replace(/\\/g, '/');
    expect(norm(findInPath('Xvfb', { PATH: ['/a', '/b'].join(delimiter) }, (p) => norm(p) === '/b/Xvfb') ?? '')).toBe('/b/Xvfb');
    expect(findInPath('Xvfb', { PATH: '/a' }, () => false)).toBeNull();
  });
});

describe('вкладки на фейковом CDP', () => {
  it('открыть: размер, screencast с качеством; кадр — подписчику, затем ack', async () => {
    const cdp = await fakeCdp();
    cleanups.push(cdp.close);
    const m = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 0 });
    cleanups.push(() => m.stopAll());
    const s = sub();
    const r = await m.open({ url: 'example.com', width: 800, height: 600, quality: 40, subscriber: s });
    expect(r.rbId).toBeTruthy();
    const metrics = cdp.calls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride')!;
    expect(metrics.params).toMatchObject({ width: 800, height: 600, deviceScaleFactor: 1 });
    expect(cdp.calls.find((c) => c.method === 'Page.startScreencast')!.params).toMatchObject({ format: 'jpeg', quality: 40, maxWidth: 800 });
    expect(cdp.calls.find((c) => c.method === 'Page.navigate')!.params['url']).toBe('https://example.com');
    cdp.frame(metrics.sessionId!, 7);
    await until(() => s.got.some((g) => g.kind === 'frame'), 2000, 'кадр');
    const fr = s.got.find((g) => g.kind === 'frame')!.f;
    expect(fr).toMatchObject({ type: 'event:rb.frame', rbId: r.rbId, width: 800, height: 600, seq: 0 });
    await until(() => cdp.calls.some((c) => c.method === 'Page.screencastFrameAck' && c.params['sessionId'] === 7), 2000, 'ack');
    await until(() => s.got.some((g) => g.kind === 'state' && String(g.f['url']).includes('example.com')), 2000, 'state');
    expect(m.list()).toHaveLength(1);
  });

  it('без зрителей кадр держится без ack; подписка — последний кадр сразу и поток дальше', async () => {
    const cdp = await fakeCdp();
    cleanups.push(cdp.close);
    const m = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 0 });
    cleanups.push(() => m.stopAll());
    const a = sub();
    const r = await m.open({ width: 640, height: 480, subscriber: a });
    const sid = cdp.calls.find((c) => c.method === 'Page.startScreencast')!.sessionId!;
    m.unsubscribe(a);
    cdp.frame(sid, 11);
    await sleep(50);
    expect(cdp.calls.some((c) => c.method === 'Page.screencastFrameAck' && c.params['sessionId'] === 11)).toBe(false);
    const b = sub();
    m.attach(r.rbId, b);
    expect(b.got[0]!.kind).toBe('frame');
    await until(() => cdp.calls.some((c) => c.method === 'Page.screencastFrameAck' && c.params['sessionId'] === 11), 2000, 'отложенный ack');
  });

  it('кадры по подтверждению: в пути не больше одного, браузер ждёт; после ack — самый свежий', async () => {
    const cdp = await fakeCdp();
    cleanups.push(cdp.close);
    const m = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 0 });
    cleanups.push(() => m.stopAll());
    const a = sub();
    const r = await m.open({ width: 640, height: 480, subscriber: a, ackFrames: true });
    const sid = cdp.calls.find((c) => c.method === 'Page.startScreencast')!.sessionId!;
    const frames = () => a.got.filter((g) => g.kind === 'frame').length;
    const acked = (n: number) => cdp.calls.some((c) => c.method === 'Page.screencastFrameAck' && c.params['sessionId'] === n);
    cdp.frame(sid, 1);
    await until(() => frames() === 1, 2000, 'первый кадр');
    await sleep(50);
    expect(acked(1)).toBe(false); // зритель ещё не показал кадр — браузер не рисует следующий
    m.frameAck(r.rbId, a);
    await until(() => acked(1), 2000, 'ack браузеру после подтверждения');
    // пока кадр в пути, пришли ещё два — дойдёт только последний, и только после подтверждения
    cdp.frame(sid, 2);
    await until(() => frames() === 2, 2000, 'второй кадр');
    cdp.frame(sid, 3);
    await sleep(50);
    expect(frames()).toBe(2);
    m.frameAck(r.rbId, a);
    await until(() => frames() === 3, 2000, 'свежий кадр после ack');
    // подписчик без подтверждений рядом — браузер не стоит, ему кадры как раньше
    const b = sub();
    m.attach(r.rbId, b);
    cdp.frame(sid, 4);
    await until(() => acked(4), 2000, 'ack при обычном зрителе');
    expect(b.got.filter((g) => g.kind === 'frame').length).toBeGreaterThanOrEqual(2);
  });

  it('ввод: мышь, колесо, печатаемая клавиша, Enter, вставка текста', async () => {
    const cdp = await fakeCdp();
    cleanups.push(cdp.close);
    const m = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 0 });
    cleanups.push(() => m.stopAll());
    const r = await m.open({ width: 800, height: 600, subscriber: sub() });
    await m.input(r.rbId, { kind: 'mouse', type: 'down', x: 5, y: 6, button: 'left', clickCount: 2 });
    await m.input(r.rbId, { kind: 'mouse', type: 'move', x: 7, y: 8 });
    await m.input(r.rbId, { kind: 'mouse', type: 'wheel', x: 1, y: 1, deltaY: 120 });
    await m.input(r.rbId, { kind: 'key', type: 'down', key: 'ж', code: 'Semicolon', text: 'ж', keyCode: 186 });
    await m.input(r.rbId, { kind: 'key', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13 });
    await m.input(r.rbId, { kind: 'key', type: 'down', key: 'a', text: 'a', modifiers: 2 }); // Ctrl+A — не печатаем
    await m.input(r.rbId, { kind: 'text', text: 'вставка' });
    const mouse = cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params);
    expect(mouse[0]).toMatchObject({ type: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 2 });
    expect(mouse[1]).toMatchObject({ type: 'mouseMoved', button: 'none' });
    expect(mouse[2]).toMatchObject({ type: 'mouseWheel', deltaY: 120, deltaX: 0 });
    const keys = cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params);
    expect(keys[0]).toMatchObject({ type: 'keyDown', key: 'ж', text: 'ж', windowsVirtualKeyCode: 186 });
    expect(keys[1]).toMatchObject({ type: 'rawKeyDown', key: 'Enter', text: '\r' });
    expect(keys[2]).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 2 });
    expect(keys[2]!['text']).toBeUndefined();
    expect(cdp.calls.find((c) => c.method === 'Input.insertText')!.params['text']).toBe('вставка');
  });

  it('навигация: адрес, назад/вперёд по истории, reload; javascript: — отказ', async () => {
    const cdp = await fakeCdp();
    cleanups.push(cdp.close);
    const m = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 0 });
    cleanups.push(() => m.stopAll());
    const s = sub();
    const r = await m.open({ width: 800, height: 600, subscriber: s });
    await m.navigate(r.rbId, { url: 'a.test' });
    await m.navigate(r.rbId, { url: 'b.test' });
    await m.navigate(r.rbId, { action: 'back' });
    const toEntry = cdp.calls.filter((c) => c.method === 'Page.navigateToHistoryEntry');
    expect(toEntry).toHaveLength(1);
    await m.navigate(r.rbId, { action: 'reload' });
    expect(cdp.calls.some((c) => c.method === 'Page.reload')).toBe(true);
    await expect(m.navigate(r.rbId, { url: 'javascript:alert(1)' })).rejects.toThrow(/схемой/);
    await until(() => s.got.some((g) => g.kind === 'state' && g.f['canGoBack'] === true), 2000, 'canGoBack');
  });

  it('лимит вкладок; закрытие последней гасит браузер; неизвестная вкладка — RB_NOT_FOUND', async () => {
    const cdp = await fakeCdp();
    cleanups.push(cdp.close);
    const m = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 0, max: 1 });
    cleanups.push(() => m.stopAll());
    const s = sub();
    const r = await m.open({ width: 800, height: 600, subscriber: s });
    await expect(m.open({ width: 800, height: 600, subscriber: sub() })).rejects.toMatchObject({ code: 'RB_LIMIT' });
    await m.close(r.rbId);
    expect(s.got.some((g) => g.kind === 'exit')).toBe(true);
    expect(cdp.calls.some((c) => c.method === 'Target.closeTarget')).toBe(true);
    await until(() => cdp.killed() > 0, 3000, 'браузер погашен');
    await expect(m.input(r.rbId, { kind: 'text', text: 'x' })).rejects.toMatchObject({ code: 'RB_NOT_FOUND' });
  });

  it('простой без зрителей — вкладка закрывается сама', async () => {
    const cdp = await fakeCdp();
    cleanups.push(cdp.close);
    const m = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 60 });
    cleanups.push(() => m.stopAll());
    const s = sub();
    await m.open({ width: 800, height: 600, subscriber: s });
    m.unsubscribe(s);
    await until(() => m.list().length === 0, 2000, 'закрытие по простою');
    await until(() => cdp.calls.some((c) => c.method === 'Target.closeTarget'), 2000, 'Target.closeTarget');
    expect(s.got.some((g) => g.kind === 'exit')).toBe(false); // зрителей нет — exit некому
  });

  it('браузер упал — зрители получают rb.exit, вкладок нет', async () => {
    const cdp = await fakeCdp();
    cleanups.push(cdp.close);
    const m = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 0 });
    cleanups.push(() => m.stopAll());
    const s = sub();
    await m.open({ width: 800, height: 600, subscriber: s });
    cdp.crash();
    await until(() => s.got.some((g) => g.kind === 'exit'), 2000, 'rb.exit');
    expect(String(s.got.find((g) => g.kind === 'exit')!.f['reason'])).toContain('браузер');
    expect(m.list()).toHaveLength(0);
  });
});

// живой Chromium/Edge — только если он есть на этой машине и может стартовать: snap-chromium без
// пользовательской сессии systemd (sudo -u, служба без linger) не запустится — тогда тест пропускается
const real = findChromium();
const realUsable = real !== null && !(isSnapChromium(real) && !snapScope(real));
describe.skipIf(!realUsable || process.env['PERIMETER_SKIP_REAL_BROWSER'] === '1')('настоящий браузер', () => {
  it('about:blank → кадр → клик → закрыть', async () => {
    const m = new RemoteBrowserManager({ idleMs: 0 });
    cleanups.push(() => m.stopAll());
    const s = sub();
    const r = await m.open({ url: 'about:blank', width: 640, height: 480, subscriber: s });
    await until(() => s.got.some((g) => g.kind === 'frame'), 20_000, 'первый кадр');
    const fr = s.got.find((g) => g.kind === 'frame')!.f;
    expect(fr['width']).toBe(640);
    expect(String(fr['data']).length).toBeGreaterThan(100);
    await m.input(r.rbId, { kind: 'mouse', type: 'down', x: 10, y: 10, button: 'left', clickCount: 1 });
    await m.input(r.rbId, { kind: 'mouse', type: 'up', x: 10, y: 10, button: 'left', clickCount: 1 });
    await m.close(r.rbId);
    expect(m.list()).toHaveLength(0);
  }, 45_000);
});
