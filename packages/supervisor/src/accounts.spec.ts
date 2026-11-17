// Аккаунты из UI: разбор вывода/адресов, папка аккаунта, вход на поддельном Claude Code (scripts/fake-claude.mjs),
// проверка ключа, шаблоны профилей и команды через WSS.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Frame } from '@perimeter/protocol';
import {
  LoginManager, checkKey, checkToken, extractCallbackCode, findLoginUrl, findOAuthToken, parseAuthStatus, prepareAccountDir,
  removeAccountDirIfUnused, splitCmd, stripAnsi, type LoginEvent,
} from './accounts.js';
import { ProfileRegistry, gatewayModels, keyHint, keyVar, profileFromTemplate, slugify, usesKey, usesSubToken } from './profiles.js';
import type { RbSubscriber } from './panels/rbrowser.js';
import { SessionManager } from './session/manager.js';
import { WssServer } from './wss.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fake-claude.mjs');
const BIN = [process.execPath, FAKE];
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cc-acc-')); dirs.push(d); return d; };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const waitFor = async (pred: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('не дождались');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// та же ссылка, что печатает scripts/fake-claude.mjs
const URL_OK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code'
  + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=st1';

describe('токен из вывода setup-token', () => {
  const TOK = 'sk-ant-oat01-abcDEF_123-xyz7890abcdefghij_KLMNOP-qrstuvAA';
  const OUT = `\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n\x1b[33m${TOK}\x1b[39m\r\n\r\n\x1b[2mStore this token securely. You won't be able to see it again.\x1b[22m\r\n`;
  it('ищется среди кодов терминала; пока пояснения под ним нет — не берём (мог дойти не целиком)', () => {
    expect(findOAuthToken(OUT)).toBe(TOK);
    expect(findOAuthToken('Paste code here if prompted >')).toBeNull();
    // кусок вывода оборвался посреди токена — начало похоже на токен, но брать рано
    expect(findOAuthToken(OUT.slice(0, OUT.indexOf(TOK) + 30))).toBeNull();
    expect(findOAuthToken(OUT.slice(0, OUT.indexOf('Store')))).toBeNull();
  });
  it('перенос строки терминала внутри токена склеивается; хвост перерисовки отрезается', () => {
    expect(findOAuthToken(OUT.replace(TOK, `${TOK.slice(0, 40)}\r\n${TOK.slice(40)}`))).toBe(TOK);
    expect(findOAuthToken(OUT.replace(`${TOK}\x1b[39m`, `${TOK}\x1b[39m\x1b[12;1H\x1b(B   ~~~`))).toBe(TOK);
  });
});

describe('разбор вывода и адресов', () => {
  it('ссылка входа из вывода с OSC 8, \\r и цветом', () => {
    const out = `\x1b[1mOpening browser…\x1b[0m\r\nIf the browser didn't open, visit: \x1b]8;;${URL_OK}\x07${URL_OK}\x1b]8;;\x07\r\nPaste code here if prompted > `;
    expect(findLoginUrl(out)).toBe(URL_OK);
    expect(stripAnsi('\x1b]8;;http://x\x07a\x1b]8;;\x07\x1b[31mb\x1b[0m\r')).toBe('ab');
    expect(findLoginUrl('ничего нет')).toBeNull();
  });

  it('код со страницы-ответа: code#state, только наши адреса', () => {
    expect(extractCallbackCode('https://platform.claude.com/oauth/code/callback?code=abc&state=st1')).toBe('abc#st1');
    expect(extractCallbackCode('https://console.anthropic.com/oauth/code/callback?code=abc')).toBe('abc');
    expect(extractCallbackCode('https://evil.example.com/oauth/code/callback?code=abc&state=s')).toBeNull();
    expect(extractCallbackCode('http://platform.claude.com/oauth/code/callback?code=abc')).toBeNull();
    expect(extractCallbackCode('https://claude.ai/oauth/authorize?code=true')).toBeNull();
    expect(extractCallbackCode('https://platform.claude.com/oauth/code/callback')).toBeNull();
    expect(extractCallbackCode('не адрес')).toBeNull();
  });

  it('auth status: вошёл/нет, почта и тариф из разных полей', () => {
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({ loggedIn: false });
    expect(parseAuthStatus('{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}')).toEqual({ loggedIn: true, email: 'a@b.c', plan: 'Claude Max' });
    expect(parseAuthStatus('{"loggedIn":true,"account":{"emailAddress":"x@y.z"},"subscriptionType":"pro"}')).toEqual({ loggedIn: true, email: 'x@y.z', plan: 'Claude Pro' });
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"api_key"}')).toEqual({ loggedIn: true, plan: 'api_key' });
    expect(parseAuthStatus('мусор')).toEqual({ loggedIn: false });
  });

  it('команда из переменной: кавычки для путей с пробелами', () => {
    expect(splitCmd('node "C:/a b/fake.mjs" --x')).toEqual(['node', 'C:/a b/fake.mjs', '--x']);
    expect(splitCmd('/usr/bin/claude')).toEqual(['/usr/bin/claude']);
  });
});

describe('папка аккаунта', () => {
  it('симлинки общего, без settings.json; пустая — убирается', () => {
    const base = tmp();
    mkdirSync(join(base, 'plugins'));
    mkdirSync(join(base, 'skills'));
    writeFileSync(join(base, 'settings.json'), '{"env":{"ANTHROPIC_BASE_URL":"https://api.z.ai/api/anthropic"}}');
    const root = tmp();
    const dir = prepareAccountDir(root, 'acc-1', base);
    expect(dir).toBe(join(root, 'acc-1', '.claude'));
    expect(lstatSync(join(dir, 'plugins')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, 'skills'))).toBe(true);
    expect(existsSync(join(dir, 'commands'))).toBe(false); // нет в базовой — не создаём
    expect(existsSync(join(dir, 'settings.json'))).toBe(false); // шлюз базовой папки новому аккаунту не нужен
    removeAccountDirIfUnused(dir);
    expect(existsSync(join(root, 'acc-1'))).toBe(false);
    expect(existsSync(join(base, 'plugins'))).toBe(true); // общее не задето
  });

  it('неудачная попытка: служебные файлы Claude Code не мешают убрать папку', () => {
    const root = tmp();
    const dir = prepareAccountDir(root, 'acc-3', tmp());
    writeFileSync(join(dir, '.claude.json'), '{}');
    mkdirSync(join(dir, 'backups'));
    removeAccountDirIfUnused(dir);
    expect(existsSync(join(root, 'acc-3'))).toBe(false);
  });

  it('папка с входом не убирается', () => {
    const root = tmp();
    const dir = prepareAccountDir(root, 'acc-2', tmp());
    writeFileSync(join(dir, '.credentials.json'), '{}');
    removeAccountDirIfUnused(dir);
    expect(existsSync(dir)).toBe(true);
  });
});

/** Вход на поддельном Claude Code: вкладка — заглушка, её «адрес» меняем сами через подписчика. */
function loginHarness(opts: { fresh?: boolean; env?: Record<string, string> } = {}) {
  const events: LoginEvent[] = [];
  const tabs: Array<{ url: string; sub: RbSubscriber; closed: boolean }> = [];
  for (const [k, v] of Object.entries(opts.env ?? {})) { const old = process.env[k]; process.env[k] = v; cleanups.push(() => { if (old === undefined) delete process.env[k]; else process.env[k] = old; }); }
  const m = new LoginManager({
    bin: BIN, backend: 'pipe',
    openTab: async (p) => { tabs.push({ url: p.url, sub: p.subscriber, closed: false }); return { rbId: `rb${tabs.length}` }; },
    closeTab: async (id) => { const t = tabs[Number(id.slice(2)) - 1]; if (t) t.closed = true; },
    emit: (e) => events.push(e),
  });
  cleanups.push(() => m.stopAll());
  const configDir = prepareAccountDir(tmp(), 'acc-t', tmp());
  return { m, events, tabs, configDir, states: () => events.map((e) => e.state) };
}

describe('вход в подписку (поддельный Claude Code)', () => {
  it('ссылка → вкладка; страница-ответ → код уходит сам → готово, аккаунт сохранён', async () => {
    const h = loginHarness();
    let done: { email?: string; plan?: string } | null = null;
    const r = await h.m.start({ configDir: h.configDir, fresh: true, width: 1280, height: 800, onDone: (a) => { done = a; return 'alex'; } });
    expect(r.url).toBe(URL_OK);
    expect(r.rbId).toBe('rb1');
    expect(h.tabs[0]!.url).toBe(URL_OK);
    expect(h.states()).toEqual(['starting', 'waiting']);
    // кадры и чужие адреса подписчик игнорирует
    h.tabs[0]!.sub.send('{"type":"event:rb.frame"}', 'frame');
    h.tabs[0]!.sub.send(JSON.stringify({ url: 'https://claude.ai/login' }), 'state');
    expect(h.states()).toEqual(['starting', 'waiting']);
    // Anthropic перебросил на страницу с кодом
    h.tabs[0]!.sub.send(JSON.stringify({ url: 'https://platform.claude.com/oauth/code/callback?code=goodcode&state=st1' }), 'state');
    await waitFor(() => h.states().includes('done'));
    expect(h.states()).toEqual(['starting', 'waiting', 'verifying', 'done']);
    expect(h.events.at(-1)).toMatchObject({ state: 'done', profile: 'alex', email: 'alex@example.com', plan: 'Claude Max' });
    expect(done).toEqual({ email: 'alex@example.com', plan: 'Claude Max' });
    expect(existsSync(join(h.configDir, '.credentials.json'))).toBe(true);
    expect(h.tabs[0]!.closed).toBe(true); // вкладку входа закрыли
  });

  it('код руками (запасной путь); неверный — понятная ошибка, новая папка убирается', async () => {
    const h = loginHarness();
    const r = await h.m.start({ configDir: h.configDir, fresh: true, width: 800, height: 600, onDone: () => 'x' });
    h.m.submitCode(r.loginId, 'wrong#st1');
    await waitFor(() => h.states().includes('failed'));
    expect(h.events.at(-1)!.error).toMatch(/код не подошёл/);
    expect(existsSync(dirname(h.configDir))).toBe(false);
    expect(() => h.m.submitCode(r.loginId, 'goodcode#st1')).toThrow(/завершён/);
  });

  it('код руками верный — вход проходит и без вкладки', async () => {
    const h = loginHarness();
    const r = await h.m.start({ configDir: h.configDir, fresh: false, width: 800, height: 600, onDone: () => 'default' });
    h.m.submitCode(r.loginId, '  goodcode#st1  ');
    await waitFor(() => h.states().includes('done'));
    expect(h.events.at(-1)).toMatchObject({ profile: 'default' });
  });

  it('отмена: процесс и вкладка закрываются, новая папка убирается', async () => {
    const h = loginHarness();
    const r = await h.m.start({ configDir: h.configDir, fresh: true, width: 800, height: 600, onDone: () => 'x' });
    await h.m.cancel(r.loginId);
    expect(h.states().at(-1)).toBe('cancelled');
    expect(h.tabs[0]!.closed).toBe(true);
    expect(existsSync(dirname(h.configDir))).toBe(false);
    expect(h.m.active).toBe(0);
  });

  it('браузера на сервере нет — waiting с rbError (UI покажет код руками)', async () => {
    const events: LoginEvent[] = [];
    const m = new LoginManager({ bin: BIN, backend: 'pipe', emit: (e) => events.push(e),
      openTab: async () => { throw new Error('браузер не найден'); } });
    cleanups.push(() => m.stopAll());
    const r = await m.start({ configDir: prepareAccountDir(tmp(), 'a', tmp()), fresh: true, width: 800, height: 600, onDone: () => 'x' });
    expect(r.rbId).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ state: 'waiting', url: URL_OK, rbError: 'браузер не найден' });
  });

  it('Claude Code не выдал ссылку — failed с хвостом вывода', async () => {
    const h = loginHarness({ env: { FAKE_CLAUDE_NO_URL: '1' } });
    await h.m.start({ configDir: h.configDir, fresh: true, width: 800, height: 600, onDone: () => 'x' });
    await waitFor(() => h.states().includes('failed'));
    expect(h.events.at(-1)!.error).toMatch(/Something went wrong/);
  });

  it('статус входа папки', async () => {
    const h = loginHarness();
    expect(await h.m.status(h.configDir)).toEqual({ loggedIn: false });
    writeFileSync(join(h.configDir, '.credentials.json'), '{}');
    expect(await h.m.status(h.configDir)).toEqual({ loggedIn: true, email: 'alex@example.com', plan: 'Claude Max' });
  });
});

describe('проверка ключа', () => {
  const fakeFetch = (status: number, body: string, seen: Array<{ url: string; headers: Record<string, string>; body: string }>) =>
    (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return new Response(body, { status });
    }) as unknown as typeof fetch;

  it('Anthropic: x-api-key, мини-запрос max_tokens 1', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const r = await checkKey({ keyVar: 'ANTHROPIC_API_KEY', apiKey: 'sk-ant-xxxxxxxx', model: 'claude-haiku-5-5' }, fakeFetch(200, '{}', seen));
    expect(r.ok).toBe(true);
    expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0]!.headers['x-api-key']).toBe('sk-ant-xxxxxxxx');
    expect(seen[0]!.headers['authorization']).toBeUndefined();
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ max_tokens: 1, model: 'claude-haiku-5-5' });
  });

  it('шлюз: Bearer и свой адрес; ошибка API — статус и текст сервиса (z.ai 1113)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const r = await checkKey({ baseUrl: 'https://api.z.ai/api/anthropic/', keyVar: 'ANTHROPIC_AUTH_TOKEN', apiKey: 'zai-key-123', model: 'glm-4.7-air' },
      fakeFetch(429, '{"error":{"code":"1113","message":"Insufficient balance"}}', seen));
    expect(seen[0]!.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
    expect(seen[0]!.headers['authorization']).toBe('Bearer zai-key-123');
    expect(r).toMatchObject({ ok: false, status: 429, message: '1113 Insufficient balance' });
  });

  it('адрес недоступен — ok:false с объяснением', async () => {
    const r = await checkKey({ baseUrl: 'https://x', keyVar: 'ANTHROPIC_AUTH_TOKEN', apiKey: 'k-12345678', model: 'm' },
      (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/недоступен.*ECONNREFUSED/);
  });
});

describe('модели аккаунта-шлюза (z.ai): только подменяемые на GLM', () => {
  it('fable и прочие неподменяемые убираются, opus/sonnet/haiku подписаны моделью шлюза', () => {
    const p = { name: 'zai', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]' } };
    const claude = [
      { id: 'default', label: 'По умолчанию · Sonnet 5.5', efforts: [] }, { id: 'opus', label: 'Opus 5.5', efforts: [] },
      { id: 'fable', label: 'Fable 5.1', efforts: [] }, { id: 'sonnet', label: 'Sonnet 5.5', efforts: [] }, { id: 'haiku', label: 'Haiku 5.5', efforts: [] },
      { id: 'glm-5.3-air', label: 'GLM 5.3 Air', efforts: [] },
    ];
    expect(gatewayModels(p, claude)).toEqual([
      { id: 'default', label: 'По умолчанию', efforts: [] },
      { id: 'opus', label: 'glm-5.3 · 1M', description: 'вместо Opus 5.5', efforts: [] },
      { id: 'haiku', label: 'glm-5.3-flash · 1M', description: 'вместо Haiku 5.5', efforts: [] },
      { id: 'glm-5.3-air', label: 'GLM 5.3 Air', efforts: [] },
    ]);
    // не шлюз — список как есть
    expect(gatewayModels({ name: 'sub', configDir: '/x' }, claude)).toBe(claude);
  });
});

describe('токен подписки Claude (claude setup-token)', () => {
  it('шаблон: CLAUDE_CODE_OAUTH_TOKEN, своя папка, модели из Claude Code, ultracode есть', () => {
    const t = profileFromTemplate({ name: 'claude', template: 'claude-token', apiKey: 'sk-ant-oat01-abcdefghijkl', configDir: '/x/.claude' });
    expect(t.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abcdefghijkl' });
    expect(t).toMatchObject({ configDir: '/x/.claude', modelsSource: 'auto', ultracode: true });
    expect(usesKey(t) && usesSubToken(t)).toBe(true);
    expect(keyVar(t.env)).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(keyHint(t)).toBe('…ijkl');
  });

  it('проверка через сам Claude Code: верный токен — ok, неверный — текст ошибки', async () => {
    expect(await checkToken(BIN, 'sk-ant-oat-good-12345')).toMatchObject({ ok: true });
    // настоящий Claude Code при отказе отвечает subtype «success» и кодом 0 — признак только is_error
    expect(await checkToken(BIN, 'sk-ant-oat-bad-12345')).toMatchObject({ ok: false, status: 401, message: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' });
  });
});

describe('шаблоны и реестр', () => {
  it('z.ai: Bearer-ключ, адрес, модели у провайдера с 1M у GLM 5.3, без ultracode; Anthropic: x-api-key, модели у провайдера', () => {
    const z = profileFromTemplate({ name: 'zai', template: 'zai', apiKey: 'k-12345678' });
    expect(z.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k-12345678' });
    expect(z).toMatchObject({ modelsSource: 'auto', ultracode: false, model: 'glm-5.3', long: ['glm-5.3', 'glm-5.3-flash'] });
    expect(z.models).toBeUndefined();
    const a = profileFromTemplate({ name: 'api', template: 'anthropic', apiKey: 'sk-ant-12345678' });
    expect(a.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-12345678' });
    expect(a).toMatchObject({ modelsSource: 'auto', ultracode: true });
    expect(() => profileFromTemplate({ name: 'c', template: 'custom', apiKey: 'k-12345678' })).toThrow(/адрес/);
    expect(usesKey(z) && usesKey(a)).toBe(true);
    expect(usesKey({ name: 'sub', configDir: '/x' })).toBe(false);
  });

  it('create пишет в profiles.json рядом с существующими (права и чужие поля целы); имя из почты — свободное', () => {
    const d = tmp();
    const file = join(d, 'profiles.json');
    writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ name: 'alex', configDir: '/a', custom: 1 }] }));
    const reg = ProfileRegistry.load(file);
    expect(reg.freeName('alex@example.com')).toBe('alex-2');
    expect(slugify('Ivan.Petrov+x@mail.ru')).toBe('ivan-petrov-x');
    reg.create({ name: 'alex-2', configDir: '/b', displayName: 'alex@example.com' });
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { profiles: Array<Record<string, unknown>> };
    expect(raw.profiles).toEqual([{ name: 'alex', configDir: '/a', custom: 1 }, { name: 'alex-2', configDir: '/b', displayName: 'alex@example.com' }]);
    expect(() => reg.create({ name: 'alex' })).toThrow(/уже есть/);
  });

  it('не вошедший аккаунт supervisor’а клиенту не показывается (но вход у него проверяется)', () => {
    const reg = new ProfileRegistry([{ name: 'claude', configDir: '/c', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxxxxxxxxxxx' } }]);
    expect(reg.infos().map((p) => p.name)).toEqual(['claude', 'default']); // вход ещё не проверен — виден
    reg.setAuth('default', { loggedIn: false });
    expect(reg.infos().map((p) => p.name)).toEqual(['claude']);
    expect(reg.subscriptionNames()).toContain('default');
    expect(reg.get('default')).toBeDefined(); // сессии без профиля по-прежнему работают
    reg.setAuth('default', { loggedIn: true, email: 'yan@x.y' });
    expect(reg.infos().map((p) => p.name)).toEqual(['claude', 'default']);
  });

  it('состояние входа уходит клиенту только у подписок', () => {
    const reg = new ProfileRegistry([{ name: 'sub', configDir: '/s' }, { name: 'zai', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k-1234567890abcdef' } }]);
    expect(reg.subscriptionNames()).toEqual(['sub', 'default']);
    reg.setAuth('sub', { loggedIn: false });
    reg.setAuth('zai', { loggedIn: true });
    expect(reg.info('sub')!.auth).toEqual({ loggedIn: false });
    expect(reg.info('zai')!.auth).toBeUndefined();
  });
});

describe('команды аккаунтов через WSS', () => {
  async function boot() {
    const d = tmp();
    const profiles = ProfileRegistry.load(join(d, 'profiles.json'));
    const tabs: RbSubscriber[] = [];
    const server = new WssServer(new SessionManager(0), {
      port: 0, profiles, sessionFactory: () => { throw new Error('не нужно'); },
      accounts: {
        root: join(d, 'accounts'),
        login: { bin: BIN, backend: 'pipe', openTab: async (p) => { tabs.push(p.subscriber); return { rbId: `rb${tabs.length}` }; }, closeTab: async () => undefined },
        checkKey: async (p) => ({ ok: p.apiKey === 'good-key-123', ms: 5, ...(p.apiKey === 'good-key-123' ? {} : { status: 401, message: 'invalid x-api-key' }) }),
        checkToken: async (t) => ({ ok: t.startsWith('sk-ant-oat-good'), ms: 5 }),
      },
    });
    const port = await server.start();
    cleanups.push(() => server.stop());
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
    cleanups.push(() => ws.close());
    const frames: Frame[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame));
    let n = 0;
    const call = async (f: Record<string, unknown>) => {
      const id = `c${++n}`;
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), id, ...f }));
      await waitFor(() => frames.some((x) => 'id' in x && x.id === id && 'ok' in x));
      return frames.find((x) => 'id' in x && x.id === id && 'ok' in x) as unknown as { ok: boolean; data?: Record<string, unknown>; code?: string; message?: string };
    };
    await call({ type: 'cmd:hello', lastSeq: {} });
    return { d, call, frames, tabs, file: join(d, 'profiles.json') };
  }

  it('profile.add (z.ai) → в profiles.json, ключ клиенту не уходит; занятое имя — PROFILE_EXISTS; проверка ключа', async () => {
    const b = await boot();
    const r = await b.call({ type: 'cmd:profile.add', name: 'zai', template: 'zai', apiKey: 'zai-secret-key-ABCD' });
    expect(r.ok).toBe(true);
    expect(r.data!['profile']).toMatchObject({ name: 'zai', keyHint: '…ABCD', ultracode: false, modelsSource: 'auto', long: ['glm-5.3', 'glm-5.3-flash'] });
    expect(JSON.stringify(b.frames)).not.toContain('zai-secret-key');
    expect(readFileSync(b.file, 'utf8')).toContain('zai-secret-key-ABCD');
    await waitFor(() => b.frames.some((f) => 'type' in f && f.type === 'event:profiles'));
    expect((await b.call({ type: 'cmd:profile.add', name: 'zai', template: 'zai', apiKey: 'zai-other-key' })).code).toBe('PROFILE_EXISTS');
    expect((await b.call({ type: 'cmd:profile.check', template: 'zai', apiKey: 'bad-key-12345' })).data).toMatchObject({ ok: false, status: 401 });
    expect((await b.call({ type: 'cmd:profile.check', template: 'anthropic', apiKey: 'good-key-123' })).data).toMatchObject({ ok: true });
    expect((await b.call({ type: 'cmd:profile.check', template: 'custom', apiKey: 'good-key-123' })).code).toBe('NO_URL');
  });

  it('login.start нового аккаунта → event:profile.login waiting → код со страницы → done, аккаунт с почтой', async () => {
    const b = await boot();
    const r = await b.call({ type: 'cmd:profile.login.start', width: 1280, height: 800 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ rbId: 'rb1', url: URL_OK });
    const loginId = r.data!['loginId'] as string;
    b.tabs[0]!.send(JSON.stringify({ url: 'https://platform.claude.com/oauth/code/callback?code=goodcode&state=st1' }), 'state');
    const ev = () => b.frames.filter((f) => 'type' in f && f.type === 'event:profile.login') as unknown as LoginEvent[];
    await waitFor(() => ev().some((e) => e.state === 'done'));
    expect(ev().every((e) => e.loginId === loginId)).toBe(true);
    expect(ev().at(-1)).toMatchObject({ state: 'done', profile: 'alex', email: 'alex@example.com', plan: 'Claude Max' });
    const saved = JSON.parse(readFileSync(b.file, 'utf8')) as { profiles: Array<{ name: string; configDir: string; displayName: string }> };
    expect(saved.profiles[0]).toMatchObject({ name: 'alex', displayName: 'alex@example.com' });
    expect(saved.profiles[0]!.configDir.startsWith(join(b.d, 'accounts'))).toBe(true);
    const profilesEv = b.frames.filter((f) => 'type' in f && f.type === 'event:profiles').at(-1) as unknown as { profiles: Array<{ name: string; auth?: unknown }> };
    expect(profilesEv.profiles.find((p) => p.name === 'alex')!.auth).toEqual({ loggedIn: true, email: 'alex@example.com', plan: 'Claude Max' });
  });

  it('profile.add токена подписки: своя папка tok-*, вход виден клиенту, проверка — через Claude Code', async () => {
    const b = await boot();
    const r = await b.call({ type: 'cmd:profile.add', name: 'claude', template: 'claude-token', apiKey: 'sk-ant-oat-good-1234WXYZ' });
    expect(r.ok).toBe(true);
    expect(r.data!['profile']).toMatchObject({ name: 'claude', keyHint: '…WXYZ', ultracode: true, modelsSource: 'auto' });
    const saved = JSON.parse(readFileSync(b.file, 'utf8')) as { profiles: Array<{ configDir: string; env: Record<string, string> }> };
    expect(saved.profiles[0]!.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-good-1234WXYZ' });
    expect(saved.profiles[0]!.configDir.replace(/\\/g, '/')).toMatch(/\/tok-[a-z0-9]+\/\.claude$/);
    await waitFor(() => b.frames.some((f) => 'type' in f && f.type === 'event:profiles'
      && (f as unknown as { profiles: Array<{ name: string; auth?: { loggedIn: boolean } }> }).profiles.some((p) => p.name === 'claude' && p.auth?.loggedIn === true)));
    expect(JSON.stringify(b.frames)).not.toContain('sk-ant-oat-good-1234WXYZ');
    expect((await b.call({ type: 'cmd:profile.check', template: 'claude-token', apiKey: 'sk-ant-oat-good-777' })).data).toMatchObject({ ok: true });
    expect((await b.call({ type: 'cmd:profile.check', profile: 'claude' })).data).toMatchObject({ ok: true });
    expect((await b.call({ type: 'cmd:profile.login.start', profile: 'claude', width: 800, height: 600 })).code).toBe('LOGIN_NOT_NEEDED');
  });

  it('выпуск токена подписки: ссылка без вкладки, код → done без токена в событиях, токен забирается один раз', async () => {
    const b = await boot();
    const r = await b.call({ type: 'cmd:profile.token.start' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ url: URL_OK });
    expect(b.tabs.length).toBe(0); // вкладку на сервере не открываем — браузер открывает сам Claude Code
    const loginId = r.data!['loginId'] as string;
    expect((await b.call({ type: 'cmd:profile.token.take', loginId })).code).toBe('NO_TOKEN');
    expect((await b.call({ type: 'cmd:profile.login.code', loginId, code: 'goodcode#st1' })).ok).toBe(true);
    const ev = () => b.frames.filter((f) => 'type' in f && f.type === 'event:profile.login') as unknown as LoginEvent[];
    await waitFor(() => ev().some((e) => e.loginId === loginId && e.state === 'done'));
    const t = await b.call({ type: 'cmd:profile.token.take', loginId });
    expect(t.data).toEqual({ token: 'sk-ant-oat-good-setup_0123456789abcdefghijklmnopqrstuvwxyz-AAAA' });
    // в рассылке событий токена нет; второй раз не отдаётся
    expect(JSON.stringify(ev())).not.toContain('sk-ant-oat-good-setup');
    expect((await b.call({ type: 'cmd:profile.token.take', loginId })).code).toBe('NO_TOKEN');
  });

  it('вход в аккаунт по ключу не нужен; неизвестный — UNKNOWN_PROFILE; отмена', async () => {
    const b = await boot();
    await b.call({ type: 'cmd:profile.add', name: 'zai', template: 'zai', apiKey: 'zai-secret-key-ABCD' });
    expect((await b.call({ type: 'cmd:profile.login.start', profile: 'zai', width: 800, height: 600 })).code).toBe('LOGIN_NOT_NEEDED');
    expect((await b.call({ type: 'cmd:profile.login.start', profile: 'nope', width: 800, height: 600 })).code).toBe('UNKNOWN_PROFILE');
    const r = await b.call({ type: 'cmd:profile.login.start', width: 800, height: 600 });
    expect((await b.call({ type: 'cmd:profile.login.cancel', loginId: r.data!['loginId'] })).ok).toBe(true);
    await waitFor(() => b.frames.some((f) => 'type' in f && f.type === 'event:profile.login' && (f as unknown as LoginEvent).state === 'cancelled'));
    expect((await b.call({ type: 'cmd:profile.login.code', loginId: r.data!['loginId'], code: 'goodcode#st1' })).code).toBe('LOGIN_FAILED');
  });
});
