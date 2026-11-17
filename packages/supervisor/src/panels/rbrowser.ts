// Удалённый браузер (ретрансляция): Chromium на машине supervisor'а (VPS), картинка — кадрами JPEG
// (CDP Page.startScreencast), ввод мыши/клавиатуры — обратно (CDP Input.*). Кадры идут адресно подписанным
// сокетам (как вывод терминала): seq 0, мимо ринг-буфера; закрытие сокета — отписка, браузер живёт дальше.
//
// Один процесс Chromium на supervisor (ленивый старт), каждый удалённый браузер — отдельная вкладка (target).
// Ни одной вкладки — процесс гасится. Вкладка без подписчиков дольше idleMs — закрывается.
//
// Экран: на Linux с Xvfb браузер запускается обычным (с окном) на виртуальном экране — сайты за Cloudflare
// (вход в Claude, Фигма) не принимают безоконный Chromium за человека; без Xvfb и на Windows/mac — headless.
// PERIMETER_CHROMIUM_DISPLAY = auto (по умолчанию) | xvfb | headless.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import WebSocket from 'ws';
import type { RbInput } from '@perimeter/protocol';
import { PanelError } from './errors.js';

/**
 * Получатель потока удалённого браузера (сокет клиента). frame — можно пропустить при медленном канале,
 * кроме reliable: кадр подписки по подтверждению, его ждут — пропустить нельзя (их в пути не больше одного).
 */
export interface RbSubscriber {
  send(raw: string, kind: 'frame' | 'state' | 'exit', reliable?: boolean): void;
}

/** Запущенный браузер: адрес CDP + как его погасить. Подменяется в тестах (фейковый CDP). */
export interface LaunchedBrowser {
  wsUrl: string;
  kill(): void;
  exited: Promise<void>;
}
export type BrowserLauncher = () => Promise<LaunchedBrowser>;

export interface RbInfo { rbId: string; url: string; title: string; width: number; height: number }

export interface RemoteBrowserOptions {
  /** запуск браузера; по умолчанию — найденный Chromium/Edge (env PERIMETER_CHROMIUM) */
  launcher?: BrowserLauncher;
  /** не больше стольких вкладок на supervisor (env PERIMETER_RB_MAX) */
  max?: number;
  /** вкладка без подписчиков дольше этого — закрывается (env PERIMETER_RB_IDLE_MS; 0 — никогда) */
  idleMs?: number;
  /** качество JPEG по умолчанию */
  quality?: number;
}

const DEFAULTS = {
  max: Number(process.env['PERIMETER_RB_MAX'] ?? 3),
  idleMs: Number(process.env['PERIMETER_RB_IDLE_MS'] ?? 30 * 60_000),
  quality: 55,
};

// ─── поиск и запуск Chromium ─────────────────────────────────────────────────

/** Где искать браузер. PERIMETER_CHROMIUM — явно; иначе Chromium/Chrome/Edge в PATH и стандартных местах. */
export function findChromium(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  const explicit = env['PERIMETER_CHROMIUM'];
  if (explicit) return explicit;
  if (platform === 'win32') {
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
    const local = env['LOCALAPPDATA'] ?? '';
    const cands = [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      ...(local ? [`${local}\\Google\\Chrome\\Application\\chrome.exe`] : []),
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
    return cands.find(exists) ?? null;
  }
  // не-snap браузеры — первыми: snap-Chromium из службы без пользовательской сессии не стартует (см. snapScope)
  const names = ['google-chrome', 'google-chrome-stable', 'chrome-headless-shell', 'chromium', 'chromium-browser', 'microsoft-edge'];
  const dirs = (env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const n of names) for (const d of dirs) if (exists(join(d, n))) return join(d, n);
  const extra = ['/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return extra.find(exists) ?? null;
}

/**
 * Флаги запуска: headless, свой профиль во временной папке, CDP только на loopback.
 * PERIMETER_CHROMIUM_NO_SANDBOX=1 — без песочницы Chromium (явный выбор оператора: например, Ubuntu 24.04
 * запрещает AppArmor'ом пространства имён пользователя, а профиль AppArmor ставить не хотят).
 */
export function chromiumArgs(userDataDir: string, env: NodeJS.ProcessEnv = process.env, opts: { headful?: boolean } = {}): string[] {
  const noSandbox = /^(1|on|true|yes)$/i.test(env['PERIMETER_CHROMIUM_NO_SANDBOX'] ?? '');
  return [
    ...(noSandbox ? ['--no-sandbox'] : []),
    // с окном (на виртуальном экране) — обычный браузер: без «HeadlessChrome» в подписи, с отрисовкой как у человека
    ...(opts.headful ? ['--window-position=0,0', '--password-store=basic', '--disable-session-crashed-bubble'] : ['--headless=new', '--disable-gpu']),
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage', // /dev/shm на VPS маленький
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1280,800',
    'about:blank',
  ];
}

/** Это snap-Chromium (сам /snap/… или обёртка /usr/bin/chromium-browser, которая зовёт snap)? */
export function isSnapChromium(path: string): boolean {
  if (path.startsWith('/snap/')) return true;
  try {
    if (statSync(path).size > 64 * 1024) return false; // настоящий бинарь, не скрипт-обёртка
    return /\/snap\/bin\/|snap run/.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * snap-Chromium из системной службы: snapd требует пользовательскую сессию systemd («cannot run snap applications»).
 * Если она есть (loginctl enable-linger + XDG_RUNTIME_DIR в юните) — запускаем через systemd-run --user --scope.
 * PERIMETER_CHROMIUM_SCOPE=on/off — принудительно.
 */
export function snapScope(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env['PERIMETER_CHROMIUM_SCOPE'] ?? '').toLowerCase();
  if (flag === 'on' || flag === '1') return true;
  if (flag === 'off' || flag === '0') return false;
  const rt = env['XDG_RUNTIME_DIR'];
  return process.platform === 'linux' && isSnapChromium(path) && rt !== undefined && existsSync(rt);
}

/** Понятный текст вместо загадочной ошибки snapd. */
export function explainLaunchError(tail: string): string | null {
  if (/cannot run snap applications|cannot track application process|snap-confine/i.test(tail)) {
    return 'snap-Chromium не запускается из службы без пользовательской сессии. Варианты: '
      + '(1) sudo loginctl enable-linger <пользователь службы> и в юнит Environment=XDG_RUNTIME_DIR=/run/user/<uid> — '
      + 'тогда supervisor запустит браузер через systemd-run --user --scope; '
      + '(2) поставить не-snap браузер (Google Chrome или chrome-headless-shell) и указать путь в PERIMETER_CHROMIUM';
  }
  if (/No usable sandbox|userns-restrictions|suid_sandbox/i.test(tail)) {
    return 'песочнице Chromium нужны пространства имён пользователя, а AppArmor (Ubuntu 23.10+) их запрещает непривилегированным программам. Варианты: '
      + '(1) профиль AppArmor для браузера с «userns,» (sudo, файл в /etc/apparmor.d — песочница сохраняется); '
      + '(2) PERIMETER_CHROMIUM_NO_SANDBOX=1 в окружении службы — без песочницы (страницы изолированы от пользователя службы слабее)';
  }
  if (/error while loading shared libraries|GLIBC_\d/.test(tail)) {
    const line = tail.split(/\r?\n/).find((l) => /shared libraries|GLIBC/.test(l))?.trim() ?? '';
    return `браузеру не хватает системных библиотек: ${line}`;
  }
  return null;
}

// ─── виртуальный экран (Xvfb) ────────────────────────────────────────────────

export type DisplayMode = 'xvfb' | 'headless';

/** Найти исполняемый файл в PATH. */
export function findInPath(name: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  for (const d of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) if (exists(join(d, name))) return join(d, name);
  for (const d of ['/usr/bin', '/usr/local/bin']) if (exists(join(d, name))) return join(d, name);
  return null;
}

/**
 * Как запускать браузер: xvfb — обычный Chromium на виртуальном экране (Linux, есть Xvfb), иначе headless.
 * PERIMETER_CHROMIUM_DISPLAY=xvfb без Xvfb — тоже headless (с предупреждением в логе), а не отказ браузера.
 */
export function displayMode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, xvfb: string | null = platform === 'linux' ? findInPath('Xvfb', env) : null): DisplayMode {
  const want = (env['PERIMETER_CHROMIUM_DISPLAY'] ?? 'auto').toLowerCase();
  if (want === 'headless') return 'headless';
  if (platform !== 'linux') return 'headless';
  if (xvfb) return 'xvfb';
  if (want === 'xvfb') console.warn('[rb] PERIMETER_CHROMIUM_DISPLAY=xvfb, но Xvfb не найден (apt install xvfb) — браузер без окна');
  return 'headless';
}

/** Свободный номер экрана: :99 и дальше, без lock-файла и сокета X. */
export function pickDisplay(exists: (p: string) => boolean = existsSync, from = 99, to = 199): number | null {
  for (let n = from; n <= to; n += 1) {
    if (!exists(`/tmp/.X${n}-lock`) && !exists(`/tmp/.X11-unix/X${n}`)) return n;
  }
  return null;
}

/** Поднять Xvfb: готов, когда появился его сокет; не поднялся за 5 с — исключение с хвостом вывода. */
export function startXvfb(bin: string): Promise<{ display: string; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const n = pickDisplay();
    if (n === null) { reject(new PanelError('RB_UNAVAILABLE', 'нет свободного номера виртуального экрана (:99–:199)')); return; }
    let child: ChildProcess;
    try {
      child = spawn(bin, [`:${n}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-dpi', '96'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    } catch (err) {
      reject(new PanelError('RB_UNAVAILABLE', `виртуальный экран не запустился: ${String((err as Error).message)}`));
      return;
    }
    let tail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => { tail = (tail + d).slice(-2000); });
    const kill = () => killTree(child);
    let done = false;
    const finish = (err?: string) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      if (err) { kill(); reject(new PanelError('RB_UNAVAILABLE', err)); } else resolve({ display: `:${n}`, kill });
    };
    child.once('error', (e) => finish(`виртуальный экран не запустился: ${String(e.message)}`));
    child.once('exit', (code) => finish(`виртуальный экран завершился при запуске (код ${code ?? '—'})${tail ? `: ${tail.slice(-300)}` : ''}`));
    const started = Date.now();
    const poll = setInterval(() => {
      if (existsSync(`/tmp/.X11-unix/X${n}`)) finish();
      else if (Date.now() - started > 5000) finish(`виртуальный экран не ответил за 5 с${tail ? `: ${tail.slice(-300)}` : ''}`);
    }, 50);
  });
}

/**
 * Настоящий запуск: адрес CDP — из строки «DevTools listening on ws://…» в stderr.
 * profileDir — постоянный профиль (куки, входы на сайты переживают закрытие браузера);
 * без него — временный, удаляется при выходе.
 */
export function chromiumLauncher(path: string | null = findChromium(), opts: { profileDir?: string; display?: DisplayMode } = {}): BrowserLauncher {
  return async () => {
    const mode = opts.display ?? displayMode();
    let screen: { display: string; kill: () => void } | null = null;
    if (mode === 'xvfb' && path) {
      try {
        screen = await startXvfb(findInPath('Xvfb') ?? 'Xvfb');
      } catch (err) {
        console.warn(`[rb] ${String((err as Error).message)} — запускаю браузер без окна`);
      }
    }
    try {
      const b = await launchChromium(path, opts.profileDir, screen?.display);
      if (screen) {
        const s = screen;
        void b.exited.then(() => s.kill());
        console.log(`[rb] браузер запущен с окном на виртуальном экране ${s.display}`);
      }
      return b;
    } catch (err) {
      screen?.kill();
      throw err;
    }
  };
}

function launchChromium(path: string | null, profileDir: string | undefined, display: string | undefined): Promise<LaunchedBrowser> {
  const opts = { profileDir };
  return new Promise<LaunchedBrowser>((resolve, reject) => {
    if (!path) {
      reject(new PanelError('RB_UNAVAILABLE', 'браузер не найден: установите Chromium (на Ubuntu: chromium) или укажите путь в PERIMETER_CHROMIUM'));
      return;
    }
    const persistent = opts.profileDir !== undefined;
    let dataDir: string;
    try {
      dataDir = persistent ? (mkdirSync(opts.profileDir!, { recursive: true, mode: 0o700 }), opts.profileDir!) : mkdtempSync(join(tmpdir(), 'cc-rb-'));
    } catch (err) {
      reject(new PanelError('RB_UNAVAILABLE', `папка профиля браузера недоступна: ${String((err as Error).message)}`));
      return;
    }
    const cleanup = () => { if (!persistent) rmSync(dataDir, { recursive: true, force: true }); };
    let child: ChildProcess;
    const scoped = snapScope(path);
    const flags = chromiumArgs(dataDir, process.env, { headful: display !== undefined });
    const [cmd, args] = scoped
      ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', path, ...flags]]
      : [path, flags];
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        // snap-chromium под systemd-юзером: без HOME/XDG_RUNTIME_DIR не стартует
        env: { ...process.env, HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? tmpdir(), ...(display ? { DISPLAY: display } : {}) },
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      cleanup();
      reject(new PanelError('RB_UNAVAILABLE', `браузер не запустился: ${String((err as Error).message)}`));
      return;
    }
    let tail = '';
    let settled = false;
    let handedOff = false; // браузер «отцепился» от стартового процесса (Chrome ≥157 на Windows)
    // Chrome ≥157 на Windows: стартовый процесс сразу выходит с кодом 0, браузер продолжает работать
    // отдельным процессом, а «DevTools listening» в stderr не пишет. Порт CDP берём из файла
    // DevToolsActivePort в папке профиля (как chromedriver); жизненный цикл ведёт соединение-наблюдатель.
    const adopt = async (): Promise<void> => {
      const file = join(dataDir, 'DevToolsActivePort');
      const deadline = Date.now() + 10_000;
      while (!existsSync(file)) {
        if (Date.now() > deadline) throw new Error('DevToolsActivePort не появился');
        await new Promise((r) => setTimeout(r, 200));
      }
      const [p0, p1] = readFileSync(file, 'utf8').split('\n');
      const port = (p0 ?? '').trim();
      const wsPath = (p1 ?? '').trim();
      if (!/^\d+$/.test(port) || !wsPath.startsWith('/')) throw new Error('битый DevToolsActivePort');
      const wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
      // порт в файле появляется раньше, чем CDP начинает слушать — подключаемся с повторами
      let watch: Cdp | null = null;
      let lastErr: unknown = null;
      for (const until = Date.now() + 5_000; Date.now() < until && !watch;) {
        try { watch = await Cdp.connect(wsUrl); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
      }
      if (!watch) throw lastErr instanceof Error ? lastErr : new Error('CDP браузера не отвечает');
      const conn = watch; // закрылось — браузер умер; им же браузер и закрываем
      settled = true;
      clearTimeout(timer);
      resolve({
        wsUrl,
        kill: () => { void conn.send('Browser.close').catch(() => undefined).finally(() => conn.close()); },
        exited: conn.closed.then(() => { cleanup(); }),
      });
    };
    const exited = new Promise<void>((r) => {
      child.once('exit', (code) => {
        r();
        if (handedOff) return; // профиль чистится, когда умрёт сам браузер (watch.closed в adopt)
        if (!settled && code === 0) {
          handedOff = true;
          // профиль ещё нужен (там DevToolsActivePort) — почистит adopt() или ветка неудачи
          void adopt().catch(() => { cleanup(); fail('браузер завершился при запуске (код 0): порт CDP не появился в профиле'); });
          return;
        }
        cleanup();
        if (!settled) fail(`браузер завершился при запуске (код ${code ?? '—'})${tail ? `: ${tail.slice(-300)}` : ''}`);
      });
    });
    const timer = setTimeout(() => fail(`браузер не ответил за 30 с${tail ? `: ${tail.slice(-300)}` : ''}`), 30_000);
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      reject(new PanelError('RB_UNAVAILABLE', explainLaunchError(tail) ?? msg));
    };
    child.once('error', (err) => fail(`браузер не запустился: ${String(err.message)}`));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      tail = (tail + d).slice(-4000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(tail);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ wsUrl: m[1]!, kill: () => killTree(child), exited });
      }
    });
  });
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* уже вышел */ } }
  setTimeout(() => { if (child.exitCode === null) { try { process.kill(-pid, 'SIGKILL'); } catch { /* вышел */ } } }, 3000).unref();
}

// ─── соединение CDP ──────────────────────────────────────────────────────────

type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

/** Минимальный клиент CDP (плоский режим: команды вкладок — с sessionId в одном сокете). */
export class Cdp {
  private n = 0;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(e: CdpEvent) => void>();
  closed: Promise<void>;

  private constructor(private ws: WebSocket) {
    this.closed = new Promise((r) => ws.once('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('соединение с браузером закрыто'));
      this.pending.clear();
      r();
    }));
    ws.on('message', (raw) => {
      let m: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? 'ошибка CDP'));
        else p.resolve(m.result ?? {});
        return;
      }
      if (m.method) {
        const e: CdpEvent = { method: m.method, params: m.params ?? {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) };
        for (const l of [...this.listeners]) { try { l(e); } catch { /* слушатель не роняет соединение */ } }
      }
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      // кадры по 50–200 КБ: без лимита на размер сообщения
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.once('open', () => resolve(new Cdp(ws)));
      ws.once('error', (err) => reject(err));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('соединение с браузером закрыто'));
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: (e: CdpEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    try { this.ws.close(); } catch { /* уже закрыто */ }
  }
}

// ─── адрес ───────────────────────────────────────────────────────────────────

/**
 * Адрес из строки ввода: без схемы — https:// (localhost и IP — http://); http/https/about — можно;
 * javascript:, data:, file: и прочие схемы — отказ (браузер на сервере, не песочница для чужих схем).
 */
export function normalizeUrl(input: string | undefined): string {
  const s = (input ?? '').trim();
  if (s === '') return 'about:blank';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^about:[a-z-]*$/i.test(s)) return s.toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:(\/\/)?/i.test(s) && !/^[\w.-]+:\d+(\/|$)/.test(s)) {
    throw new PanelError('RB_BAD_URL', `адреса со схемой «${s.split(':')[0]}:» не открываются — только http, https и about`);
  }
  const host = s.split(/[/?#]/)[0]!.toLowerCase();
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/.test(host) || /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host);
  return `${local ? 'http' : 'https'}://${s}`;
}

// ─── вкладки ─────────────────────────────────────────────────────────────────

interface Tab {
  id: string;
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  width: number;
  height: number;
  quality: number;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  subs: Set<RbSubscriber>;
  /** подписчики с кадрами по подтверждению: кадр в пути / пришёл более свежий, пока ждали */
  flow: Map<RbSubscriber, Flow>;
  lastFrame: string | null;
  /** кадр без подписчиков: ack держим, пока кто-то не подпишется (screencast стоит, CPU не тратится) */
  heldAck: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
}

/** Подписка по подтверждению: кадр в пути, пришёл более свежий, страховочный таймер потерянного подтверждения. */
interface Flow { inflight: boolean; stale: boolean; sentAt: number; timer: ReturnType<typeof setTimeout> | null }
const newFlow = (): Flow => ({ inflight: false, stale: false, sentAt: 0, timer: null });
/** подтверждение не пришло за столько — кадр считаем дошедшим (потерялся, клиент не успел подписаться) */
const ACK_LOST_MS = 5000;

export class RemoteBrowserManager {
  private readonly launcher: BrowserLauncher;
  private readonly max: number;
  private readonly idleMs: number;
  private readonly quality: number;
  private browser: { proc: LaunchedBrowser; cdp: Cdp; off: () => void } | null = null;
  private starting: Promise<{ proc: LaunchedBrowser; cdp: Cdp; off: () => void }> | null = null;
  private tabs = new Map<string, Tab>();
  private stopped = false;

  constructor(opts: RemoteBrowserOptions = {}) {
    this.launcher = opts.launcher ?? chromiumLauncher();
    this.max = opts.max ?? DEFAULTS.max;
    this.idleMs = opts.idleMs ?? DEFAULTS.idleMs;
    this.quality = opts.quality ?? DEFAULTS.quality;
  }

  list(): RbInfo[] {
    return [...this.tabs.values()].filter((t) => !t.closing).map((t) => ({ rbId: t.id, url: t.url, title: t.title, width: t.width, height: t.height }));
  }

  async open(p: { url?: string; width: number; height: number; quality?: number; subscriber: RbSubscriber; ackFrames?: boolean }): Promise<{ rbId: string; url: string; title: string }> {
    if (this.stopped) throw new PanelError('RB_UNAVAILABLE', 'supervisor останавливается');
    if ([...this.tabs.values()].filter((t) => !t.closing).length >= this.max) {
      throw new PanelError('RB_LIMIT', `открыто ${this.max} удалённых браузера — закройте лишний`);
    }
    const url = normalizeUrl(p.url);
    const { cdp } = await this.ensureBrowser();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const tab: Tab = {
      id: randomUUID(), targetId, sessionId, url, title: '', width: p.width, height: p.height,
      quality: p.quality ?? this.quality, loading: false, canGoBack: false, canGoForward: false,
      subs: new Set([p.subscriber]), lastFrame: null, heldAck: null, idleTimer: null, closing: false,
      flow: new Map(p.ackFrames ? [[p.subscriber, newFlow()]] : []),
    };
    this.tabs.set(tab.id, tab);
    try {
      await cdp.send('Page.enable', {}, sessionId);
      await this.applySize(tab);
      if (url !== 'about:blank') await cdp.send('Page.navigate', { url }, sessionId);
      await this.refreshHistory(tab);
    } catch (err) {
      await this.close(tab.id).catch(() => undefined);
      throw new PanelError('RB_UNAVAILABLE', `вкладка не открылась: ${String((err as Error).message)}`);
    }
    return { rbId: tab.id, url: tab.url, title: tab.title };
  }

  attach(rbId: string, subscriber: RbSubscriber, ackFrames = false): { rbId: string; url: string; title: string } {
    const t = this.tab(rbId);
    t.subs.add(subscriber);
    const old = t.flow.get(subscriber);
    if (old?.timer) clearTimeout(old.timer);
    if (ackFrames) t.flow.set(subscriber, newFlow());
    else t.flow.delete(subscriber);
    this.clearIdle(t);
    if (t.lastFrame) this.deliverFrame(t, subscriber, t.lastFrame);
    if (this.anyReady(t)) this.releaseAck(t);
    try { subscriber.send(this.stateFrame(t), 'state'); } catch { /* сокет умирает */ }
    return { rbId: t.id, url: t.url, title: t.title };
  }

  /** Сокет закрылся: отписка от всех вкладок; у вкладки без подписчиков пошёл счётчик простоя. */
  unsubscribe(subscriber: RbSubscriber): void {
    for (const t of this.tabs.values()) {
      const f = t.flow.get(subscriber);
      if (f?.timer) clearTimeout(f.timer);
      t.flow.delete(subscriber);
      if (t.subs.delete(subscriber) && t.subs.size === 0) this.armIdle(t);
      else if (this.anyReady(t)) this.releaseAck(t);
    }
  }

  /** Клиент показал кадр: шлём ему самый свежий, если успел появиться; браузер рисует дальше. */
  frameAck(rbId: string, subscriber: RbSubscriber): void {
    const t = this.tabs.get(rbId);
    const f = t?.flow.get(subscriber);
    if (!t || !f) return;
    if (f.timer) { clearTimeout(f.timer); f.timer = null; }
    f.inflight = false;
    if (f.stale && t.lastFrame) this.deliverFrame(t, subscriber, t.lastFrame);
    if (this.anyReady(t)) this.releaseAck(t);
  }

  /** Кадр подписчику: по подтверждению — не больше одного в пути, иначе — как есть. */
  private deliverFrame(t: Tab, s: RbSubscriber, raw: string): void {
    const f = t.flow.get(s);
    if (f) {
      if (f.inflight && Date.now() - f.sentAt < ACK_LOST_MS) { f.stale = true; return; }
      f.inflight = true;
      f.stale = false;
      f.sentAt = Date.now();
      // подтверждение потерялось (кадр пришёл раньше, чем клиент подписался; обрыв) — не стоим вечно
      if (f.timer) clearTimeout(f.timer);
      f.timer = setTimeout(() => { f.timer = null; if (f.inflight && t.flow.get(s) === f) this.frameAck(t.id, s); }, ACK_LOST_MS);
      f.timer.unref?.();
    }
    try { s.send(raw, 'frame', f !== undefined); } catch { /* сокет умирает — отпишется по close */ }
  }

  /** Есть зритель, готовый принять кадр (без подтверждений — всегда готов). */
  private anyReady(t: Tab): boolean {
    for (const s of t.subs) {
      const f = t.flow.get(s);
      if (!f || !f.inflight || Date.now() - f.sentAt >= ACK_LOST_MS) return true;
    }
    return false;
  }

  async navigate(rbId: string, p: { url?: string; action?: 'back' | 'forward' | 'reload' | 'stop' }): Promise<void> {
    const t = this.tab(rbId);
    const cdp = this.cdp();
    if (p.url !== undefined) {
      await cdp.send('Page.navigate', { url: normalizeUrl(p.url) }, t.sessionId);
      return;
    }
    switch (p.action) {
      case 'reload': await cdp.send('Page.reload', {}, t.sessionId); return;
      case 'stop': await cdp.send('Page.stopLoading', {}, t.sessionId); return;
      case 'back':
      case 'forward': {
        const h = await cdp.send('Page.getNavigationHistory', {}, t.sessionId) as { currentIndex: number; entries: Array<{ id: number }> };
        const idx = h.currentIndex + (p.action === 'back' ? -1 : 1);
        const entry = h.entries[idx];
        if (entry) await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, t.sessionId);
        return;
      }
      default:
        throw new PanelError('BAD_REQUEST', 'нужен адрес или действие');
    }
  }

  async input(rbId: string, i: RbInput): Promise<void> {
    const t = this.tab(rbId);
    const cdp = this.cdp();
    const s = t.sessionId;
    switch (i.kind) {
      case 'mouse': {
        const mods = i.modifiers ?? 0;
        if (i.type === 'wheel') {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: i.x, y: i.y, deltaX: i.deltaX ?? 0, deltaY: i.deltaY ?? 0, modifiers: mods }, s);
          return;
        }
        const type = i.type === 'move' ? 'mouseMoved' : i.type === 'down' ? 'mousePressed' : 'mouseReleased';
        const button = i.button ?? (i.type === 'move' ? 'none' : 'left');
        await cdp.send('Input.dispatchMouseEvent', {
          type, x: i.x, y: i.y, button, modifiers: mods,
          ...(i.type !== 'move' ? { clickCount: i.clickCount ?? 1 } : {}),
        }, s);
        return;
      }
      case 'key': {
        const base = {
          key: i.key,
          ...(i.code !== undefined ? { code: i.code } : {}),
          ...(i.keyCode !== undefined ? { windowsVirtualKeyCode: i.keyCode, nativeVirtualKeyCode: i.keyCode } : {}),
          modifiers: i.modifiers ?? 0,
        };
        if (i.type === 'up') {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s);
          return;
        }
        // печатаемый символ (без Ctrl/Alt/Meta) — keyDown с текстом; служебные (Enter, стрелки, сочетания) — rawKeyDown
        const printable = i.text !== undefined && i.text !== '' && ((i.modifiers ?? 0) & 0b0111) === 0;
        await cdp.send('Input.dispatchKeyEvent', printable
          ? { type: 'keyDown', ...base, text: i.text, unmodifiedText: i.text }
          : { type: 'rawKeyDown', ...base, ...(i.key === 'Enter' ? { text: '\r' } : {}) }, s);
        return;
      }
      case 'text':
        await cdp.send('Input.insertText', { text: i.text }, s);
        return;
    }
  }

  async resize(rbId: string, width: number, height: number): Promise<void> {
    const t = this.tab(rbId);
    t.width = width;
    t.height = height;
    await this.applySize(t);
  }

  async close(rbId: string, reason?: string): Promise<void> {
    const t = this.tabs.get(rbId);
    if (!t || t.closing) return;
    t.closing = true;
    this.clearIdle(t);
    for (const f of t.flow.values()) if (f.timer) clearTimeout(f.timer);
    t.flow.clear();
    this.emitExit(t, reason);
    this.tabs.delete(rbId);
    if (this.browser) await this.browser.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
    if (this.tabs.size === 0) this.shutdownBrowser();
  }

  /** Остановка supervisor'а: все вкладки закрываются, процесс браузера гасится. */
  async stopAll(): Promise<void> {
    this.stopped = true;
    for (const id of [...this.tabs.keys()]) await this.close(id, 'supervisor остановлен').catch(() => undefined);
    this.shutdownBrowser();
  }

  // ─── внутреннее ────────────────────────────────────────────────────────────

  private tab(rbId: string): Tab {
    const t = this.tabs.get(rbId);
    if (!t || t.closing) throw new PanelError('RB_NOT_FOUND', 'удалённый браузер закрыт — откройте заново');
    return t;
  }

  private cdp(): Cdp {
    if (!this.browser) throw new PanelError('RB_NOT_FOUND', 'удалённый браузер закрыт — откройте заново');
    return this.browser.cdp;
  }

  private async ensureBrowser(): Promise<{ proc: LaunchedBrowser; cdp: Cdp; off: () => void }> {
    if (this.browser) return this.browser;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const proc = await this.launcher();
      let cdp: Cdp;
      try {
        cdp = await Cdp.connect(proc.wsUrl);
      } catch (err) {
        proc.kill();
        throw new PanelError('RB_UNAVAILABLE', `нет связи с браузером: ${String((err as Error).message)}`);
      }
      const off = cdp.on((e) => this.onEvent(e));
      const b = { proc, cdp, off };
      this.browser = b;
      // браузер упал или его убили — все вкладки закрыты
      const gone = () => {
        if (this.browser !== b) return;
        this.browser = null;
        off();
        for (const t of [...this.tabs.values()]) {
          t.closing = true;
          this.clearIdle(t);
          this.emitExit(t, 'браузер завершился');
        }
        this.tabs.clear();
      };
      void proc.exited.then(gone);
      void cdp.closed.then(() => { if (this.browser === b) { proc.kill(); gone(); } });
      return b;
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  private shutdownBrowser(): void {
    const b = this.browser;
    if (!b) return;
    this.browser = null;
    b.off();
    void b.cdp.send('Browser.close').catch(() => undefined);
    setTimeout(() => { b.cdp.close(); b.proc.kill(); }, 1500).unref();
  }

  private async applySize(t: Tab): Promise<void> {
    const cdp = this.cdp();
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: t.width, height: t.height, deviceScaleFactor: 1, mobile: false }, t.sessionId);
    await cdp.send('Page.stopScreencast', {}, t.sessionId).catch(() => undefined);
    t.heldAck = null;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: t.quality, maxWidth: t.width, maxHeight: t.height, everyNthFrame: 1 }, t.sessionId);
  }

  private tabBySession(sessionId: string | undefined): Tab | undefined {
    if (!sessionId) return undefined;
    for (const t of this.tabs.values()) if (t.sessionId === sessionId && !t.closing) return t;
    return undefined;
  }

  private onEvent(e: CdpEvent): void {
    const t = this.tabBySession(e.sessionId);
    if (!t) return;
    switch (e.method) {
      case 'Page.screencastFrame': {
        const meta = (e.params['metadata'] ?? {}) as { deviceWidth?: number; deviceHeight?: number };
        const ackId = Number(e.params['sessionId']);
        const raw = JSON.stringify({
          v: 1, ts: Date.now(), seq: 0, type: 'event:rb.frame', rbId: t.id,
          data: String(e.params['data'] ?? ''),
          width: Math.round(meta.deviceWidth ?? t.width), height: Math.round(meta.deviceHeight ?? t.height),
        });
        t.lastFrame = raw;
        if (t.subs.size === 0) { t.heldAck = ackId; return; }
        for (const s of [...t.subs]) this.deliverFrame(t, s, raw);
        // все зрители ждут подтверждения — браузер не рисует впустую: ack держим до cmd:rb.ack
        if (!this.anyReady(t)) { t.heldAck = ackId; return; }
        void this.browser?.cdp.send('Page.screencastFrameAck', { sessionId: ackId }, t.sessionId).catch(() => undefined);
        return;
      }
      case 'Page.frameStartedLoading':
        if (!t.loading) { t.loading = true; this.emitState(t); }
        return;
      case 'Page.frameStoppedLoading':
      case 'Page.loadEventFired':
        t.loading = false;
        void this.refreshHistory(t).then(() => this.emitState(t));
        return;
      case 'Page.frameNavigated': {
        const frame = (e.params['frame'] ?? {}) as { parentId?: string; url?: string };
        if (frame.parentId) return; // только главная рамка
        if (frame.url) t.url = frame.url;
        void this.refreshHistory(t).then(() => this.emitState(t));
        return;
      }
      case 'Page.navigatedWithinDocument':
        if (typeof e.params['url'] === 'string') t.url = e.params['url'] as string;
        void this.refreshHistory(t).then(() => this.emitState(t));
        return;
      case 'Inspector.targetCrashed':
        void this.close(t.id, 'вкладка упала');
        return;
    }
  }

  private async refreshHistory(t: Tab): Promise<void> {
    try {
      const h = await this.cdp().send('Page.getNavigationHistory', {}, t.sessionId) as { currentIndex: number; entries: Array<{ url: string; title: string }> };
      const cur = h.entries[h.currentIndex];
      if (cur) { t.url = cur.url; t.title = cur.title; }
      t.canGoBack = h.currentIndex > 0;
      t.canGoForward = h.currentIndex < h.entries.length - 1;
    } catch { /* вкладку закрыли — состояние неважно */ }
  }

  private releaseAck(t: Tab): void {
    if (t.heldAck === null || !this.browser) return;
    const id = t.heldAck;
    t.heldAck = null;
    void this.browser.cdp.send('Page.screencastFrameAck', { sessionId: id }, t.sessionId).catch(() => undefined);
  }

  private stateFrame(t: Tab): string {
    return JSON.stringify({
      v: 1, ts: Date.now(), seq: 0, type: 'event:rb.state', rbId: t.id,
      url: t.url, title: t.title, loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward,
    });
  }

  private emitState(t: Tab): void {
    if (t.closing) return;
    this.broadcast(t, this.stateFrame(t), 'state');
  }

  private emitExit(t: Tab, reason?: string): void {
    this.broadcast(t, JSON.stringify({ v: 1, ts: Date.now(), seq: 0, type: 'event:rb.exit', rbId: t.id, ...(reason ? { reason } : {}) }), 'exit');
  }

  private broadcast(t: Tab, raw: string, kind: 'frame' | 'state' | 'exit'): void {
    for (const s of [...t.subs]) {
      try { s.send(raw, kind); } catch { /* сокет умирает — отпишется по close */ }
    }
  }

  private armIdle(t: Tab): void {
    if (t.idleTimer || this.idleMs <= 0 || t.closing) return;
    t.idleTimer = setTimeout(() => {
      t.idleTimer = null;
      if (t.subs.size === 0) void this.close(t.id, 'закрыт: долго без зрителей');
    }, this.idleMs);
    t.idleTimer.unref?.();
  }

  private clearIdle(t: Tab): void {
    if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null; }
  }
}
