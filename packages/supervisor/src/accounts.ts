// Аккаунты из UI (эталон 003-accounts-add): папка нового аккаунта, вход в подписку Claude на стороне сервера,
// проверка ключа API.
//
// Вход: supervisor запускает `claude auth login --claudeai` (бинарь Claude Code из Agent SDK) в PTY с
// CLAUDE_CONFIG_DIR аккаунта; ссылку из вывода открывает во вкладке браузера на сервере; вкладку «слушает»
// собственный подписчик — как только Anthropic перебросит на страницу с кодом (…/oauth/code/callback?code=…),
// код уходит в процесс входа. Запасной путь — код руками из UI (cmd:profile.login.code).
// Пароль вводится только на сайте Anthropic; токены остаются в папке аккаунта на сервере.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnProcAuto, type TermBackendPref, type TermProc } from './panels/terminal.js';
import type { RbSubscriber } from './panels/rbrowser.js';

/** Что из базовой папки Claude Code делим с новым аккаунтом симлинками (тяжёлое общее). settings.json — НЕТ: там может быть шлюз. */
export const SHARED_ITEMS = ['plugins', 'skills', 'commands', 'agents'] as const;

/** Вход дольше этого — прерываем (вкладка и процесс закрываются). */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;

/**
 * Бинарь Claude Code: PERIMETER_CLAUDE_BIN (можно «node путь/к/скрипту» — для тестов), иначе платформенный
 * пакет Agent SDK (@anthropic-ai/claude-agent-sdk-<платформа>-<архитектура>), иначе `claude` из PATH.
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = env['PERIMETER_CLAUDE_BIN'];
  if (own && own.trim()) return splitCmd(own.trim());
  const req = createRequire(import.meta.url);
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const names = [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`];
  if (process.platform === 'linux') names.push(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`);
  for (const n of names) {
    try {
      const p = join(dirname(req.resolve(`${n}/package.json`)), exe);
      if (existsSync(p)) return [p];
    } catch { /* пакета нет — дальше */ }
  }
  return ['claude'];
}

/** «node "C:/a b/fake.mjs"» → ['node', 'C:/a b/fake.mjs'] (кавычки — для путей с пробелами). */
export function splitCmd(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** Корень папок аккаунтов: рядом с profiles.json — ~/.perimeter/accounts. */
export function accountsRoot(profilesFile: string | undefined): string {
  return profilesFile ? join(dirname(profilesFile), 'accounts') : join(homedir(), '.perimeter', 'accounts');
}

/**
 * Папка конфигурации нового аккаунта: <root>/<slug>/.claude (права 700) + симлинки общего из базовой папки.
 * Существующие элементы не трогаем. Возвращает путь к .claude.
 */
export function prepareAccountDir(root: string, slug: string, baseDir: string): string {
  const dir = join(root, slug, '.claude');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const item of SHARED_ITEMS) {
    const src = join(baseDir, item);
    const dst = join(dir, item);
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      // Windows без прав разработчика не даёт обычных симлинков на папки — junction работает всегда
      symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
    } catch { /* без общего — аккаунт всё равно рабочий */ }
  }
  return dir;
}

/**
 * Новая папка аккаунта, вход в которую не случился, — убрать вместе с родителем <slug>. Claude Code успевает
 * записать туда служебное (.claude.json, backups), поэтому смотрим не на пустоту, а на файл входа.
 * Симлинки общего удаляются как ссылки — сами plugins/skills не трогаются.
 */
export function removeAccountDirIfUnused(configDir: string): void {
  try {
    if (existsSync(join(configDir, '.credentials.json'))) return;
    readdirSync(configDir); // нет папки — исключение, нечего убирать
    rmSync(dirname(configDir), { recursive: true, force: true });
  } catch { /* нет папки — нечего убирать */ }
}

/** Погасить процесс входа: Claude Code в PTY не всегда выходит по SIGHUP — через 1,5 с добиваем группу SIGKILL. */
function killHard(proc: TermProc | null): void {
  if (!proc) return;
  try { proc.kill(); } catch { /* уже вышел */ }
  const pid = proc.pid;
  if (pid === undefined || process.platform === 'win32') return;
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* вышел */ } }
  }, 1500).unref?.();
}

/** Убрать ANSI/OSC-последовательности (OSC 8 — ссылки в терминале) и \r. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

/** Первая https-ссылка входа в выводе `claude auth login` / `claude mcp login` (…/authorize). */
export function findLoginUrl(out: string): string | null {
  const clean = stripAnsi(out);
  const all = clean.match(/https:\/\/[^\s"'<>\]]+/g) ?? [];
  return all.find((u) => /oauth\/authorize/.test(u)) ?? all.find((u) => /authorize/.test(u)) ?? all[0] ?? null;
}

/**
 * Код со страницы-ответа Anthropic: …/oauth/code/callback?code=X&state=Y → «X#Y» (так его показывает страница
 * и так ждёт `claude auth login`). Чужие адреса и страницы без кода — null.
 */
export function extractCallbackCode(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname;
  const ours = host === 'claude.ai' || host === 'claude.com' || host.endsWith('.claude.com') || host.endsWith('.claude.ai')
    || host === 'anthropic.com' || host.endsWith('.anthropic.com');
  if (u.protocol !== 'https:' || !ours || !/\/oauth\/code\/callback\/?$/.test(u.pathname)) return null;
  const code = u.searchParams.get('code');
  if (!code) return null;
  const state = u.searchParams.get('state');
  return state ? `${code}#${state}` : code;
}

/**
 * Токен подписки из вывода `claude setup-token`. Вывод приходит кусками: начало токена может прийти раньше конца —
 * поэтому берём его, только когда Claude Code уже напечатал пояснение под ним («Store this token…» / «Use this token…»).
 * Перенос строки терминала внутри токена склеиваем; лишнее после токена (обрывки перерисовки) отрезаем.
 */
export function findOAuthToken(out: string): string | null {
  // кроме CSI/OSC — короткие ESC-последовательности (набор символов, сохранение курсора)
  const clean = stripAnsi(out).replace(/\x1b[()][A-Za-z0-9]|\x1b[78=>]/g, '');
  const end = clean.search(/Store this token|Use this token by setting/i);
  if (end < 0) return null;
  const head = clean.slice(0, end);
  const start = head.lastIndexOf('sk-ant-oat');
  if (start < 0) return null;
  return /^sk-ant-oat[0-9]*-[A-Za-z0-9_-]{16,}/.exec(head.slice(start).replace(/\s+/g, ''))?.[0] ?? null;
}

/** Разобрать `claude auth status --json`: вошёл, почта, тариф (поля в разных версиях называются по-разному). */
export function parseAuthStatus(raw: string): { loggedIn: boolean; email?: string; plan?: string } {
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch { return { loggedIn: false }; }
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = k.split('.').reduce<unknown>((o, part) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[part] : undefined), j);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  const email = pick('email', 'emailAddress', 'account.email', 'account.emailAddress', 'oauthAccount.emailAddress');
  const sub = pick('subscriptionType', 'plan', 'subscription', 'account.subscriptionType', 'oauthAccount.subscriptionType');
  const method = pick('authMethod');
  const plan = sub ? planLabel(sub) : method && method !== 'none' && method !== 'oauth' && method !== 'claude.ai' ? method : undefined;
  return { loggedIn: j['loggedIn'] === true, ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
}

function planLabel(s: string): string {
  const v = s.toLowerCase();
  if (v.includes('max')) return 'Claude Max';
  if (v.includes('pro')) return 'Claude Pro';
  if (v.includes('team')) return 'Claude Team';
  if (v.includes('enterprise')) return 'Claude Enterprise';
  return s;
}

/** Окружение процесса Claude Code для папки аккаунта: без ключей/шлюзов supervisor'а (вход — именно в подписку). */
/** configDir не задан — папка Claude Code по умолчанию (~/.claude + ~/.claude.json), CLAUDE_CONFIG_DIR убираем. */
export function loginEnv(configDir: string | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  if (configDir) env['CLAUDE_CONFIG_DIR'] = configDir;
  else delete env['CLAUDE_CONFIG_DIR'];
  // браузер Claude Code не открывает: страница входа откроется во вкладке браузера на сервере
  if (process.platform !== 'win32') env['BROWSER'] = 'true';
  env['TERM'] = 'xterm-256color';
  return env;
}

/** `claude auth status --json` для папки аккаунта; extraEnv — например, токен подписки (CLAUDE_CODE_OAUTH_TOKEN). */
export function authStatus(bin: string[], configDir: string | undefined, timeoutMs = 20_000, extraEnv: Record<string, string> = {}): Promise<{ loggedIn: boolean; email?: string; plan?: string }> {
  return new Promise((resolve) => {
    execFile(bin[0]!, [...bin.slice(1), 'auth', 'status', '--json'], { env: { ...loginEnv(configDir), ...extraEnv }, timeout: timeoutMs, windowsHide: true },
      (_err, stdout) => resolve(parseAuthStatus(String(stdout ?? ''))));
  });
}

// ─── вход ────────────────────────────────────────────────────────────────────

export type LoginState = 'starting' | 'waiting' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface LoginEvent {
  loginId: string;
  state: LoginState;
  rbId?: string;
  url?: string;
  rbError?: string;
  profile?: string;
  email?: string;
  plan?: string;
  error?: string;
}

export interface LoginStartOptions {
  /** папка CLAUDE_CONFIG_DIR, куда входить; undefined — папка Claude Code по умолчанию (аккаунт supervisor'а) */
  configDir: string | undefined;
  /** аргументы Claude Code; по умолчанию вход в подписку (`auth login --claudeai`), для MCP — `mcp login <имя> --no-browser` */
  args?: string[];
  /** код из адреса вкладки (null — не трогать): по умолчанию страница-ответ Anthropic; у MCP возврат ловит сам Claude Code */
  extractCode?: (url: string) => string | null;
  /** проверка после выхода процесса; по умолчанию — `claude auth status` папки */
  check?: () => Promise<{ loggedIn: boolean; email?: string; plan?: string }>;
  /** таймаут ожидания ссылки входа, мс (по умолчанию 30 с) */
  urlTimeoutMs?: number;
  /** новая папка (создана под вход): при отмене/ошибке — убрать */
  fresh: boolean;
  width: number;
  height: number;
  /** вход завершён: создать/обновить аккаунт, вернуть его имя */
  onDone: (a: { email?: string; plan?: string }) => Promise<string> | string;
  /**
   * Поймать результат в выводе (`claude setup-token` печатает токен): нашёлся — вход завершён (done), процесс гасим,
   * результат отдаёт take() один раз. Тогда check/onDone не зовутся.
   */
  capture?: (out: string) => string | null;
  /** страницу входа открывает сам Claude Code в браузере этой машины (у локального supervisor'а — браузер владельца), без вкладки */
  ownBrowser?: boolean;
  /** уборка после входа (временная папка) */
  cleanup?: () => void;
}

export interface LoginDeps {
  bin?: string[];
  backend?: TermBackendPref;
  /** открыть вкладку браузера на сервере (нет браузера — исключение с понятным текстом) */
  openTab?: (p: { url: string; width: number; height: number; subscriber: RbSubscriber }) => Promise<{ rbId: string }>;
  closeTab?: (rbId: string) => Promise<void>;
  emit: (e: LoginEvent) => void;
  timeoutMs?: number;
  /** проверка входа (подменяется в тестах) */
  status?: (configDir: string | undefined, extraEnv?: Record<string, string>) => Promise<{ loggedIn: boolean; email?: string; plan?: string }>;
}

interface Login {
  id: string;
  opts: LoginStartOptions;
  proc: TermProc | null;
  out: string;
  rbId?: string;
  url?: string;
  codeSent: boolean;
  finished: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** пойманный результат (capture) — до take() */
  captured?: string;
}

export class LoginManager {
  private logins = new Map<string, Login>();
  private readonly bin: string[];

  constructor(private readonly deps: LoginDeps) {
    this.bin = deps.bin ?? resolveClaudeBin();
  }

  /** Вошёл ли Claude Code в папке аккаунта (`claude auth status --json`). */
  status(configDir: string | undefined, extraEnv: Record<string, string> = {}): Promise<{ loggedIn: boolean; email?: string; plan?: string }> {
    return (this.deps.status ?? ((d, e) => authStatus(this.bin, d, 20_000, e ?? {})))(configDir, extraEnv);
  }

  /** Бинарь Claude Code, которым идёт вход (для проверки токена). */
  get claudeBin(): string[] { return this.bin; }

  /** Идущих входов (для статуса и тестов). */
  get active(): number { return [...this.logins.values()].filter((l) => !l.finished).length; }

  async start(opts: LoginStartOptions): Promise<{ loginId: string; rbId?: string; url?: string }> {
    const l: Login = { id: randomUUID(), opts, proc: null, out: '', codeSent: false, finished: false, timer: null };
    this.logins.set(l.id, l);
    this.emit(l, 'starting');
    const urlReady = new Promise<string | null>((resolve) => {
      let done = false;
      const check = () => {
        if (done) return;
        const u = findLoginUrl(l.out);
        if (u) { done = true; resolve(u); }
      };
      const onData = (d: string) => {
        l.out = (l.out + d).slice(-64_000);
        check();
        if (opts.capture && !l.finished && l.captured === undefined) {
          const got = opts.capture(l.out);
          if (got) { l.captured = got; void this.finish(l, 'done', {}, true); }
        }
      };
      const onExit = (code: number | null) => {
        if (!done) { done = true; resolve(null); }
        void this.onExit(l, code);
      };
      spawnProcAuto(this.deps.backend ?? 'auto', {
        file: this.bin[0]!, args: [...this.bin.slice(1), ...(opts.args ?? ['auth', 'login', '--claudeai'])],
        cwd: homedir(), cols: 4000, rows: 50, env: opts.ownBrowser ? ownBrowserEnv(opts.configDir) : loginEnv(opts.configDir),
      }, onData, onExit).then((p) => { l.proc = p; }, (err) => {
        l.out += `\n${String((err as Error).message ?? err)}`;
        if (!done) { done = true; resolve(null); }
        void this.finish(l, 'failed', { error: `Claude Code не запустился: ${String((err as Error).message ?? err)}` });
      });
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, opts.urlTimeoutMs ?? 30_000).unref?.();
    });
    const url = await urlReady;
    if (l.finished) return { loginId: l.id };
    if (!url) {
      await this.finish(l, 'failed', { error: `Claude Code не выдал ссылку входа${tail(l.out)}` });
      return { loginId: l.id };
    }
    l.url = url;
    l.timer = setTimeout(() => { void this.cancel(l.id, 'вход не завершён за 15 минут'); }, this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
    l.timer.unref?.();
    let rbError: string | undefined;
    if (opts.ownBrowser) {
      // браузер открыл сам Claude Code; ссылка — для «не открылся? открыть самому»
    } else if (this.deps.openTab) {
      try {
        const { rbId } = await this.deps.openTab({ url, width: opts.width, height: opts.height, subscriber: this.watcher(l) });
        l.rbId = rbId;
      } catch (err) {
        rbError = String((err as Error).message ?? err);
      }
    } else {
      rbError = 'браузер на сервере недоступен';
    }
    this.emit(l, 'waiting', { url, ...(l.rbId ? { rbId: l.rbId } : {}), ...(rbError ? { rbError } : {}) });
    return { loginId: l.id, url, ...(l.rbId ? { rbId: l.rbId } : {}) };
  }

  /** Пойманный результат входа (capture) — один раз; потом его здесь нет. */
  take(loginId: string): string | undefined {
    const l = this.logins.get(loginId);
    const v = l?.captured;
    if (l) delete l.captured;
    return v;
  }

  /** Код руками (запасной путь) — или со страницы-ответа во вкладке. */
  submitCode(loginId: string, code: string): void {
    const l = this.logins.get(loginId);
    if (!l || l.finished) throw new Error('вход уже завершён или не найден');
    if (!l.proc) throw new Error('процесс входа ещё не запустился');
    const clean = code.trim();
    if (!clean) throw new Error('пустой код');
    l.codeSent = true;
    // в PTY Enter — \r (терминал сам превратит в конец строки); на пайпах — \n
    l.proc.write(`${clean}${l.proc.mode === 'pty' ? '\r' : '\n'}`);
    this.emit(l, 'verifying');
  }

  async cancel(loginId: string, reason?: string): Promise<void> {
    const l = this.logins.get(loginId);
    if (!l || l.finished) return;
    await this.finish(l, reason ? 'failed' : 'cancelled', reason ? { error: reason } : {});
  }

  async stopAll(): Promise<void> {
    for (const l of [...this.logins.values()]) await this.cancel(l.id);
  }

  /** Подписчик вкладки входа: следит за адресом; кадры не нужны (ack не шлём — браузер не рисует впустую). */
  private watcher(l: Login): RbSubscriber {
    return {
      send: (raw, kind) => {
        if (kind !== 'state' || l.codeSent || l.finished) return;
        let url = '';
        try { url = String((JSON.parse(raw) as { url?: unknown }).url ?? ''); } catch { return; }
        const code = (l.opts.extractCode ?? extractCallbackCode)(url);
        if (code) {
          try { this.submitCode(l.id, code); } catch { /* процесс ещё не готов — код можно ввести руками */ }
        }
      },
    };
  }

  private async onExit(l: Login, code: number | null): Promise<void> {
    if (l.finished) return;
    if (l.opts.capture) {
      const why = l.codeSent ? 'код не подошёл или устарел — начните заново' : `Claude Code завершился (код ${code ?? '—'}), токена нет`;
      await this.finish(l, 'failed', { error: `${why}${tail(l.out)}` });
      return;
    }
    const st: { loggedIn: boolean; email?: string; plan?: string } = await (l.opts.check ?? (() => this.status(l.opts.configDir)))().catch(() => ({ loggedIn: false }));
    if (st.loggedIn) {
      try {
        const profile = await l.opts.onDone({ ...(st.email ? { email: st.email } : {}), ...(st.plan ? { plan: st.plan } : {}) });
        await this.finish(l, 'done', { profile, ...(st.email ? { email: st.email } : {}), ...(st.plan ? { plan: st.plan } : {}) }, true);
      } catch (err) {
        await this.finish(l, 'failed', { error: `вход прошёл, но аккаунт не сохранён: ${String((err as Error).message ?? err)}` }, true);
      }
      return;
    }
    const why = l.codeSent ? 'код не подошёл или устарел — начните вход заново' : `Claude Code завершился (код ${code ?? '—'})`;
    await this.finish(l, 'failed', { error: `${why}${tail(l.out)}` });
  }

  private async finish(l: Login, state: LoginState, extra: Partial<LoginEvent>, keepDir = false): Promise<void> {
    if (l.finished) return;
    l.finished = true;
    if (l.timer) clearTimeout(l.timer);
    killHard(l.proc);
    if (l.rbId && this.deps.closeTab) await this.deps.closeTab(l.rbId).catch(() => undefined);
    if (l.opts.fresh && !keepDir && l.opts.configDir) removeAccountDirIfUnused(l.opts.configDir);
    try { l.opts.cleanup?.(); } catch { /* уборка не главное */ }
    this.emit(l, state, extra);
    // запись о входе держим недолго — повторный cancel/code получат понятную ошибку
    setTimeout(() => this.logins.delete(l.id), 60_000).unref?.();
  }

  private emit(l: Login, state: LoginState, extra: Partial<LoginEvent> = {}): void {
    try { this.deps.emit({ loginId: l.id, state, ...extra }); } catch { /* адресат умер */ }
  }
}

/** Окружение входа, где браузер открывает сам Claude Code (не глушим BROWSER, как для сервера). */
function ownBrowserEnv(configDir: string | undefined): Record<string, string> {
  const env = loginEnv(configDir);
  if (process.env['BROWSER'] !== undefined) env['BROWSER'] = process.env['BROWSER'];
  else delete env['BROWSER'];
  return env;
}

/** Хвост вывода процесса входа для текста ошибки (без кодов терминала). */
function tail(out: string): string {
  const lines = stripAnsi(out).split('\n').map((x) => x.trim()).filter(Boolean).slice(-3).join(' · ');
  return lines ? `: ${lines.slice(0, 300)}` : '';
}

// ─── проверка ключа ──────────────────────────────────────────────────────────

export interface KeyCheckResult { ok: boolean; ms: number; status?: number; message?: string }

/** Мини-запрос (max_tokens 1) к Messages API: ключ живой и подходит к адресу. */
/**
 * Проверить токен подписки Claude (`claude setup-token`): он работает только внутри Claude Code, поэтому —
 * один короткий запрос через сам Claude Code (`claude -p`, 1 ход) во временной папке. Тратит пару токенов подписки.
 */
export function checkToken(bin: string[], token: string, timeoutMs = 90_000): Promise<KeyCheckResult> {
  const dir = mkdtempSync(join(tmpdir(), 'cc-tok-'));
  const env = { ...loginEnv(join(dir, '.claude')), CLAUDE_CODE_OAUTH_TOKEN: token };
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(bin[0]!, [...bin.slice(1), '-p', 'Ответь одним словом: ок', '--output-format', 'json', '--max-turns', '1'],
      { env, cwd: dir, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true });
        const ms = Date.now() - started;
        const out = String(stdout ?? '');
        try {
          const j = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '') as { is_error?: boolean; result?: string; subtype?: string; api_error_status?: number };
          // subtype у Claude Code «success» даже при отказе API — смотрим только на is_error
          if (j.is_error === false) { resolve({ ok: true, ms }); return; }
          resolve({ ok: false, ms, ...(typeof j.api_error_status === 'number' ? { status: j.api_error_status } : {}), message: String(j.result ?? j.subtype ?? 'ошибка').slice(0, 300) });
          return;
        } catch { /* не JSON — ниже */ }
        const killed = (err as { killed?: boolean } | null)?.killed;
        const text = stripAnsi(`${String(stderr ?? '')}\n${out}`).split('\n').map((x) => x.trim()).filter(Boolean).slice(-2).join(' · ');
        resolve({ ok: false, ms, message: killed ? `Claude Code не ответил за ${Math.round(timeoutMs / 1000)} с` : (text || `Claude Code завершился с ошибкой`).slice(0, 300) });
      });
  });
}

export async function checkKey(p: { baseUrl?: string; keyVar: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'; apiKey: string; model: string },
  fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Promise<KeyCheckResult> {
  const base = (p.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (p.keyVar === 'ANTHROPIC_API_KEY') headers['x-api-key'] = p.apiKey;
  else headers['authorization'] = `Bearer ${p.apiKey}`;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${base}/v1/messages`, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({ model: p.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    const ms = Date.now() - started;
    if (r.ok) return { ok: true, ms, status: r.status };
    const text = await r.text().catch(() => '');
    return { ok: false, ms, status: r.status, message: apiMessage(text) };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return { ok: false, ms: Date.now() - started, message: aborted ? `нет ответа за ${Math.round(timeoutMs / 1000)} с` : `адрес недоступен: ${String((err as Error).message ?? err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Текст ошибки из ответа API (Anthropic: error.message; z.ai: error.code + message); ключ в текст не попадает. */
function apiMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; code?: string | number; type?: string } | string; message?: string };
    if (typeof j.error === 'object' && j.error) {
      const code = j.error.code !== undefined ? `${j.error.code} ` : '';
      return `${code}${j.error.message ?? j.error.type ?? ''}`.trim().slice(0, 300);
    }
    if (typeof j.error === 'string') return j.error.slice(0, 300);
    if (j.message) return j.message.slice(0, 300);
  } catch { /* не JSON */ }
  return text.slice(0, 300);
}
