// Усилие, ultracode и модели по аккаунтам (макет A1): профили, команды WSS, менеджер, адаптер SDK.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Frame, ModelInfoFrame } from '@perimeter/protocol';
import { PROTOCOL_VERSION } from '@perimeter/protocol';
import { SessionManager } from './session/manager.js';
import type { EngineHooks } from './session/engine.js';
import type { QueryLike, SdkMsg, SdkUserInput } from './session/types.js';
import { BASE_PROFILE, ProfileRegistry, isGateway, seedModels, settingsBaseUrl } from './profiles.js';
import { WssServer } from './wss.js';
import { flagSettings, toModelInfo } from './session/sdk.js';
import { claimSettings } from './pool.js';
import { StateStore } from './state-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_SID = '33333333-3333-4333-8333-333333333333';
const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const ZAI_ENV = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'секрет' };

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cc-models-')); dirs.push(d); return d; };

// ─── профили ────────────────────────────────────────────────────────────────

describe('профили: модели, усилие, ultracode', () => {
  it('новые поля из profiles.json проверяются, мусор отбрасывается', () => {
    const f = join(tmp(), 'profiles.json');
    writeFileSync(f, JSON.stringify({ version: 1, profiles: [
      {
        name: 'yan', defaultEffort: 'high', ultracode: true, modelsSource: 'auto',
        models: [{ id: 'sonnet', efforts: ['low', 'max'] }, { id: '' }, { efforts: 'много' }, 'мусор'],
      },
      { name: 'b', defaultEffort: 'огромное', ultracode: 'да', modelsSource: 'кто-то' },
    ] }), 'utf8');
    const reg = ProfileRegistry.load(f);
    expect(reg.get('yan')).toEqual({ name: 'yan', defaultEffort: 'high', ultracode: true, modelsSource: 'auto', models: [{ id: 'sonnet', efforts: ['low', 'max'] }] });
    expect(reg.get('b')).toEqual({ name: 'b' });
  });

  it('шлюз (z.ai): список у провайдера по умолчанию, ручной — из model; ultracode выключен; Anthropic — auto и ultracode', () => {
    const reg = new ProfileRegistry([
      { name: 'zai', env: ZAI_ENV, model: 'glm-5.3[1m]', modelsSource: 'manual' },
      { name: 'zai2', env: ZAI_ENV, model: 'glm-5.3' },
      { name: 'yan', model: 'sonnet' },
      { name: 'anth', env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } },
    ]);
    expect(isGateway(reg.get('zai')!)).toBe(true);
    expect(reg.modelsSource('zai2')).toBe('auto'); // спросим /v1/models у z.ai
    expect(reg.models('zai2')).toBeUndefined();
    expect(reg.modelsSource('zai')).toBe('manual');
    expect(reg.models('zai')).toEqual([{ id: 'glm-5.3[1m]', efforts: [] }]);
    expect(reg.ultracodeAllowed('zai')).toBe(false);
    expect(reg.effortsFor('zai', 'glm-5.3[1m]')).toEqual([]);
    expect(reg.modelsSource('yan')).toBe('auto');
    expect(reg.models('yan')).toBeUndefined(); // ещё не спрашивали Claude Code
    expect(reg.effortsFor('yan', 'sonnet')).toBeNull(); // неизвестно — не проверяем
    expect(reg.ultracodeAllowed('yan')).toBe(true);
    expect(reg.modelsSource('anth')).toBe('auto');
  });

  it('аккаунт supervisor\'а виден клиенту как `default`; внутри сессия без профиля', () => {
    const reg = new ProfileRegistry([{ name: 'yan' }]);
    expect(reg.list().map((p) => p.name)).toEqual(['yan']);
    expect(reg.publicList().map((p) => p.name)).toEqual(['yan', BASE_PROFILE]);
    expect(reg.get(BASE_PROFILE)?.displayName).toBe('По умолчанию');
    expect(reg.internal(BASE_PROFILE)).toBeUndefined();
    expect(reg.internal('yan')).toBe('yan');
    expect(reg.external(undefined)).toBe(BASE_PROFILE);
    // настоящий профиль `default` со своим env — это отдельный аккаунт, не supervisor
    const real = new ProfileRegistry([{ name: BASE_PROFILE, env: { X: '1' } }]);
    expect(real.baseName()).toBeUndefined();
    expect(real.external(undefined)).toBeUndefined();
    expect(real.internal(BASE_PROFILE)).toBe(BASE_PROFILE);
  });

  it('правка из UI пишет profiles.json атомарно: env и незнакомые поля на месте', () => {
    const dir = tmp();
    const f = join(dir, 'profiles.json');
    writeFileSync(f, JSON.stringify({ version: 1, note: 'руками', profiles: [
      { name: 'zai', env: ZAI_ENV, model: 'glm-5.3[1m]', custom: { a: 1 } },
    ] }), 'utf8');
    const reg = ProfileRegistry.load(f);
    reg.update('zai', { models: [{ id: 'glm-5.3' }, { id: 'glm-4.7-air', label: 'GLM 4.7 Air' }], defaultEffort: 'low', ultracode: false });
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    expect(raw.note).toBe('руками');
    expect(raw.profiles[0]).toMatchObject({ name: 'zai', env: ZAI_ENV, custom: { a: 1 }, modelsSource: 'manual', defaultEffort: 'low', ultracode: false });
    expect(raw.profiles[0].models).toHaveLength(2);
    expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([]); // временный файл не остался
    // снять значение — null
    reg.update('zai', { defaultEffort: null, model: null });
    const raw2 = JSON.parse(readFileSync(f, 'utf8'));
    expect(raw2.profiles[0].defaultEffort).toBeUndefined();
    expect(raw2.profiles[0].model).toBeUndefined();
    expect(reg.get('zai')?.env).toEqual(ZAI_ENV);
  });

  it('правка `default` добавляет запись без env; файла нет — создаётся', () => {
    const f = join(tmp(), 'profiles.json');
    const reg = ProfileRegistry.load(f);
    reg.update(BASE_PROFILE, { defaultEffort: 'medium' });
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    expect(raw).toEqual({ version: 1, profiles: [{ name: BASE_PROFILE, defaultEffort: 'medium' }] });
    expect(reg.baseName()).toBe(BASE_PROFILE); // запись без env — всё ещё аккаунт supervisor'а
    expect(reg.info(BASE_PROFILE)?.defaultEffort).toBe('medium');
  });

  it('битый profiles.json правкой не затирается', () => {
    const f = join(tmp(), 'profiles.json');
    writeFileSync(f, JSON.stringify({ version: 1, profiles: [{ name: 'yan' }] }), 'utf8');
    const reg = ProfileRegistry.load(f);
    writeFileSync(f, '{{{ руками сломали', 'utf8');
    expect(() => reg.update('yan', { ultracode: false })).toThrow();
    expect(readFileSync(f, 'utf8')).toBe('{{{ руками сломали');
  });

  it('список из Claude Code — в отдельном кэше, profiles.json не трогается; кэш переживает перезагрузку', () => {
    const dir = tmp();
    const f = join(dir, 'profiles.json');
    const original = JSON.stringify({ version: 1, profiles: [{ name: 'yan', env: { T: 'токен' } }] });
    writeFileSync(f, original, 'utf8');
    const reg = ProfileRegistry.load(f);
    reg.setAutoModels('yan', [{ id: 'sonnet', label: 'Sonnet', efforts: [...ALL] }], 1000);
    expect(readFileSync(f, 'utf8')).toBe(original);
    expect(existsSync(join(dir, 'profiles-cache.json'))).toBe(true);
    const again = ProfileRegistry.load(f);
    expect(again.info('yan')).toMatchObject({ modelsSource: 'auto', modelsAt: 1000, models: [{ id: 'sonnet', efforts: [...ALL] }] });
    expect(again.effortsFor('yan', 'sonnet')).toEqual([...ALL]);
    expect(again.staleAuto(60_000, 1000 + 120_000)).toEqual(['yan', BASE_PROFILE]);
    expect(again.staleAuto(60_000, 1000 + 1_000)).toEqual([BASE_PROFILE]); // у default списка ещё нет
  });
});

// ─── чистые функции адаптера SDK и пула ─────────────────────────────────────

describe('адаптер SDK: флаги старта и модели', () => {
  it('ultracode и слово-триггер в оверлей настроек; пусто — без оверлея', () => {
    expect(flagSettings({})).toBeUndefined();
    expect(flagSettings({ ultracode: true })).toEqual({ ultracode: true });
    expect(flagSettings({ ultracode: true, ultracodeKeyword: false })).toEqual({ workflowKeywordTriggerEnabled: false });
    expect(claimSettings({ effort: 'max', ultracode: true })).toEqual({ effortLevel: 'max', ultracode: true });
    expect(claimSettings({ cwd: '/x' })).toBeUndefined();
  });

  it('ModelInfo SDK → модель клиента: без усилия — пустой список', () => {
    expect(toModelInfo({ value: 'opus', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }))
      .toEqual({ id: 'opus', label: 'Opus', efforts: ['low', 'high'] });
    expect(toModelInfo({ value: 'x', displayName: '', supportsEffort: false })).toEqual({ id: 'x', efforts: [] });
  });

  it('подписи как в Claude Code Desktop: версия из description, пояснение — после « · »', () => {
    // так отдаёт supportedModels() Claude Code 2.1.319 (проверено на Velohost)
    expect(toModelInfo({ value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: false }))
      .toEqual({ id: 'opus', label: 'Opus 5.5', description: 'Best for everyday, complex tasks', efforts: [] });
    expect(toModelInfo({ value: 'fable', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', supportsEffort: false }))
      .toMatchObject({ label: 'Fable 5.1' });
    expect(toModelInfo({ value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 5.5 · Efficient for routine tasks', supportsEffort: false }))
      .toEqual({ id: 'default', label: 'По умолчанию · Sonnet 5.5', description: 'Efficient for routine tasks', efforts: [] });
    // вход по ключу API: в описаниях цены и «currently …» — цены убираем, модель берём из скобок
    expect(toModelInfo({ value: 'default', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', supportsEffort: false }))
      .toEqual({ id: 'default', label: 'По умолчанию · Opus 5.5', efforts: [] });
    expect(toModelInfo({ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks · $3/$15 per Mtok', supportsEffort: false }))
      .toEqual({ id: 'sonnet', label: 'Sonnet 5.5', description: 'Efficient for routine tasks', efforts: [] });
    // описание без версии модели — подпись остаётся displayName, описание целиком
    expect(toModelInfo({ value: 'glm', displayName: 'GLM', description: 'шлюз z.ai', supportsEffort: false }))
      .toEqual({ id: 'glm', label: 'GLM', description: 'шлюз z.ai', efforts: [] });
  });
});

describe('реестр сессий: усилие и ultracode переживают рестарт', () => {
  it('state-store сохраняет и проверяет поля', () => {
    const store = new StateStore(join(tmp(), 'state.json'));
    store.save([
      { id: CLAUDE_SID, name: 'a', lastSeq: 3, effort: 'xhigh', ultracode: true },
      { id: '44444444-4444-4444-8444-444444444444', name: 'b', lastSeq: 0, effort: 'бешеное' as never },
    ]);
    const [a, b] = store.load();
    expect(a).toMatchObject({ effort: 'xhigh', ultracode: true });
    expect(b?.effort).toBeUndefined();
  });

  it('мёртвая сессия: усилие запоминается и уходит в respawn; snapshot/restore', async () => {
    const resumed: Array<Record<string, unknown>> = [];
    const m = new SessionManager();
    m.restore(
      [{ id: CLAUDE_SID, name: 'a', lastSeq: 0, claudeSessionId: 'c1', cwd: '/x', profile: 'yan' }],
      (_sid, info) => { resumed.push({ ...info }); return holdEngine([]).factory; },
    );
    expect(await m.setFlags(CLAUDE_SID, { effort: 'max', ultracode: true })).toBe(true);
    expect(m.get(CLAUDE_SID)).toMatchObject({ effort: 'max', ultracode: true });
    expect(m.snapshot()[0]).toMatchObject({ effort: 'max', ultracode: true });
    m.send(CLAUDE_SID, 'привет');
    expect(resumed[0]).toMatchObject({ claudeSessionId: 'c1', profile: 'yan', effort: 'max', ultracode: true });
    await m.stop(CLAUDE_SID);
  });

  it('смена аккаунта переносит усилие; на аккаунт supervisor\'а — без профиля', () => {
    const m = new SessionManager();
    m.restore([{ id: CLAUDE_SID, name: 'a', lastSeq: 0, profile: 'yan', effort: 'high' }], () => holdEngine([]).factory);
    expect(m.switchProfile(CLAUDE_SID, undefined, { effort: null, ultracode: false })).toBe('ok');
    const s = m.get(CLAUDE_SID)!;
    expect(s.profile).toBeUndefined();
    expect(s.effort).toBeUndefined();
  });
});

// ─── WSS ────────────────────────────────────────────────────────────────────

/** движок-мок: init → результат → держим процесс; пишем вызовы applyFlagSettings */
function holdEngine(flags: Array<Record<string, unknown>>, models?: string[]) {
  const factory = (input: AsyncIterable<SdkUserInput>, _hooks: EngineHooks): QueryLike => {
    void (async () => { for await (const _ of input) void _; })().catch(() => undefined);
    const g = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: CLAUDE_SID, tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
      yield { type: 'result', subtype: 'success' } as SdkMsg;
      await sleep(3000);
    })();
    return {
      [Symbol.asyncIterator]: () => g,
      interrupt: async () => undefined,
      close: async () => { await g.return(undefined); },
      setModel: async (m: string) => { models?.push(m); },
      applyFlagSettings: async (s) => { flags.push({ ...s }); },
    };
  };
  return { factory };
}

class C {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(String(d)) as Frame));
  }
  send(f: Record<string, unknown>): void { this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...f })); }
  private typeOf(f: Frame): string | undefined { return 'type' in f ? f.type : undefined; }
  async waitType<T = Frame>(type: string, pred: (f: T) => boolean = () => true, ms = 4000): Promise<T> {
    for (let i = 0; i < ms / 25; i++) {
      const f = this.frames.find((x) => this.typeOf(x) === type && pred(x as T));
      if (f) return f as T;
      await sleep(25);
    }
    throw new Error(`нет ${type}`);
  }
  async reply(id: string, ms = 5000): Promise<{ ok: boolean; code?: string; message?: string; data?: Record<string, unknown> }> {
    for (let i = 0; i < ms / 25; i++) {
      const f = this.frames.find((x) => 'id' in x && x.id === id && 'ok' in x);
      if (f) return f as never;
      await sleep(25);
    }
    throw new Error(`нет ответа ${id}`);
  }
}

async function setup(opts: { fetcher?: (p: string) => Promise<ModelInfoFrame[] | { models: ModelInfoFrame[]; from: 'provider' | 'claude-code' }>; file?: boolean } = {}) {
  const flags: Array<Record<string, unknown>> = [];
  const engineModels: string[] = [];
  const factoryArgs: Array<Record<string, unknown>> = [];
  const dir = tmp();
  const list = [
    { name: 'yan', model: 'sonnet', defaultEffort: 'high' as const },
    { name: 'zai', env: ZAI_ENV, model: 'glm-5.3[1m]', modelsSource: 'manual' as const },
  ];
  let profiles: ProfileRegistry;
  if (opts.file) {
    writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ version: 1, profiles: list }), 'utf8');
    profiles = ProfileRegistry.load(join(dir, 'profiles.json'));
  } else {
    profiles = new ProfileRegistry(list);
  }
  // у yan список уже известен: sonnet со всеми уровнями, haiku без усилия
  profiles.setAutoModels('yan', [{ id: 'sonnet', efforts: [...ALL] }, { id: 'haiku', efforts: [] }]);
  const manager = new SessionManager();
  const fetchCalls: string[] = [];
  const server = new WssServer(manager, {
    port: 0,
    profiles,
    sessionFactory: (sess) => { factoryArgs.push({ ...sess }); return holdEngine(flags, engineModels).factory; },
    resumeFactory: () => holdEngine(flags, engineModels).factory,
    ...(opts.fetcher ? { modelsFetcher: async (p: string) => { fetchCalls.push(p); return opts.fetcher!(p); } } : {}),
  });
  const port = await server.start();
  stops.push(() => server.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = new C(ws);
  stops.push(async () => { ws.close(); });
  c.send({ id: 'h', type: 'cmd:hello', lastSeq: {} });
  await c.reply('h');
  return { c, flags, factoryArgs, fetchCalls, profiles, manager, dir, engineModels };
}

async function newSession(c: C, id: string, extra: Record<string, unknown>): Promise<string> {
  c.send({ id, type: 'cmd:session.new', ...extra });
  const r = await c.reply(id);
  expect(r.ok).toBe(true);
  const sid = (r.data as { sessionId: string }).sessionId;
  await c.waitType<{ sessionId?: string; state?: string }>('event:session.state', (f) => f.sessionId === sid && f.state === 'idle');
  return sid;
}

describe('WSS: усилие и ultracode', () => {
  it('новая сессия берёт усилие по умолчанию аккаунта; hello отдаёт модели и поля сессии', async () => {
    const { c, factoryArgs } = await setup();
    const sid = await newSession(c, 'n1', { profile: 'yan', model: 'sonnet' });
    expect(factoryArgs[0]).toMatchObject({ profile: 'yan', effort: 'high' });

    c.send({ id: 'h2', type: 'cmd:hello', lastSeq: {} });
    const hello = await c.waitType<{ sessions: Array<Record<string, unknown>>; profiles: Array<Record<string, unknown>> }>('event:hello', (f) => f.sessions.length > 0);
    expect(hello.sessions.find((s) => s['id'] === sid)).toMatchObject({ profile: 'yan', effort: 'high' });
    const yan = hello.profiles.find((p) => p['name'] === 'yan');
    expect(yan).toMatchObject({ modelsSource: 'auto', defaultEffort: 'high', ultracode: true });
    expect(hello.profiles.find((p) => p['name'] === 'zai')).toMatchObject({ modelsSource: 'manual', ultracode: false, models: [{ id: 'glm-5.3[1m]' }] });
    expect(hello.profiles.map((p) => p['name'])).toContain('default');
  });

  it('усилие по умолчанию не уходит в модель, которая его не знает; явное — ошибка', async () => {
    const { c, factoryArgs } = await setup();
    await newSession(c, 'n1', { profile: 'yan', model: 'haiku' });
    expect(factoryArgs[0]?.['effort']).toBeUndefined();
    c.send({ id: 'n2', type: 'cmd:session.new', profile: 'zai', effort: 'high' });
    expect((await c.reply('n2')).code).toBe('EFFORT_UNSUPPORTED');
    c.send({ id: 'n3', type: 'cmd:session.new', profile: 'zai', ultracode: true });
    expect((await c.reply('n3')).code).toBe('ULTRACODE_DISABLED');
  });

  it('на лету: усилие и ultracode идут в applyFlagSettings всегда парой; null — по умолчанию модели', async () => {
    const { c, flags } = await setup();
    const sid = await newSession(c, 'n1', { profile: 'yan', model: 'sonnet' });
    c.send({ id: 's1', sessionId: sid, type: 'cmd:session.settings', effort: 'max' });
    const r1 = await c.reply('s1');
    expect(r1.ok).toBe(true);
    expect((r1.data as { session: Record<string, unknown> }).session).toMatchObject({ effort: 'max', profile: 'yan' });
    expect(flags.at(-1)).toEqual({ effortLevel: 'max', ultracode: false });

    c.send({ id: 's2', sessionId: sid, type: 'cmd:session.settings', ultracode: true });
    await c.reply('s2');
    expect(flags.at(-1)).toEqual({ effortLevel: 'max', ultracode: true });

    c.send({ id: 's3', sessionId: sid, type: 'cmd:session.settings', effort: null });
    const r3 = await c.reply('s3');
    expect(flags.at(-1)).toEqual({ effortLevel: null, ultracode: true });
    expect((r3.data as { session: Record<string, unknown> }).session['effort']).toBeUndefined();

    c.send({ id: 's4', sessionId: sid, type: 'cmd:session.settings', effort: 'max', model: 'haiku' });
    expect((await c.reply('s4')).code).toBe('EFFORT_UNSUPPORTED');
  });

  it('смена модели на ту, что не знает текущего усилия, сбрасывает его', async () => {
    const { c, flags, manager } = await setup();
    const sid = await newSession(c, 'n1', { profile: 'yan', model: 'sonnet' });
    expect(manager.get(sid)?.effort).toBe('high');
    c.send({ id: 's1', sessionId: sid, type: 'cmd:session.settings', model: 'haiku' });
    expect((await c.reply('s1')).ok).toBe(true);
    expect(manager.get(sid)?.effort).toBeUndefined();
    expect(flags.at(-1)).toEqual({ effortLevel: null, ultracode: false });
  });

  it('сессия без профиля видна как `default`, переключение на `default` — без профиля внутри', async () => {
    const { c, manager } = await setup();
    const sid = await newSession(c, 'n1', { profile: 'yan', model: 'sonnet' });
    c.send({ id: 's1', sessionId: sid, type: 'cmd:session.settings', profile: 'default' });
    const r = await c.reply('s1');
    expect(r.ok).toBe(true);
    expect(manager.get(sid)?.profile).toBeUndefined();
    expect((r.data as { session: Record<string, unknown> }).session['profile']).toBe('default');
    c.send({ id: 'l', type: 'cmd:session.list' });
    const list = (await c.reply('l')).data as { sessions: Array<Record<string, unknown>> };
    expect(list.sessions.find((s) => s['id'] === sid)?.['profile']).toBe('default');
  });
});

describe('WSS: модели и правка аккаунта', () => {
  it('profile.update сохраняет и рассылает event:profiles', async () => {
    const { c, dir } = await setup({ file: true });
    c.send({ id: 'u1', type: 'cmd:profile.update', profile: 'zai', models: [{ id: 'glm-4.7-air' }], defaultEffort: 'low' });
    const r = await c.reply('u1');
    expect(r.ok).toBe(true);
    expect((r.data as { profile: Record<string, unknown> }).profile).toMatchObject({ modelsSource: 'manual', models: [{ id: 'glm-4.7-air' }], defaultEffort: 'low' });
    const ev = await c.waitType<{ profiles: Array<Record<string, unknown>> }>('event:profiles');
    expect(ev.profiles.find((p) => p['name'] === 'zai')).toMatchObject({ defaultEffort: 'low' });
    const raw = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
    expect(raw.profiles.find((p: { name: string }) => p.name === 'zai').env).toEqual(ZAI_ENV);
    c.send({ id: 'u2', type: 'cmd:profile.update', profile: 'нет' });
    expect((await c.reply('u2')).code).toBe('UNKNOWN_PROFILE');
  });

  it('список у провайдера: id шлюза как есть (без фильтра псевдонимов), modelsFrom; 1M правится из UI', async () => {
    const { c } = await setup({ fetcher: async () => ({ models: [{ id: 'glm-5.3', efforts: [] }, { id: 'glm-4.6', efforts: [] }], from: 'provider' }) });
    c.send({ id: 'u0', type: 'cmd:profile.update', profile: 'zai', modelsSource: 'auto' });
    expect((await c.reply('u0')).ok).toBe(true);
    c.send({ id: 'm1', type: 'cmd:profile.models', profile: 'zai', refresh: true });
    const r = await c.reply('m1');
    expect((r.data as { profile: Record<string, unknown> }).profile).toMatchObject({ modelsSource: 'auto', modelsFrom: 'provider', models: [{ id: 'glm-5.3' }, { id: 'glm-4.6' }] });
    c.send({ id: 'u1', type: 'cmd:profile.update', profile: 'zai', long: ['glm-5.3'] });
    expect(((await c.reply('u1')).data as { profile: Record<string, unknown> }).profile).toMatchObject({ long: ['glm-5.3'] });
  });

  it('profile.models: refresh спрашивает Claude Code только у auto-аккаунта; ошибка — MODELS_FAILED', async () => {
    let fail = false;
    const { c, fetchCalls } = await setup({
      fetcher: async () => {
        if (fail) throw new Error('нет сети');
        return [{ id: 'opus', label: 'Opus', efforts: ['low', 'max'] }];
      },
    });
    c.send({ id: 'm1', type: 'cmd:profile.models', profile: 'yan', refresh: true });
    const r = await c.reply('m1');
    expect(r.ok).toBe(true);
    expect((r.data as { profile: Record<string, unknown> }).profile).toMatchObject({ models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'max'] }] });
    expect(fetchCalls).toEqual(['yan']);
    await c.waitType('event:profiles');

    c.send({ id: 'm2', type: 'cmd:profile.models', profile: 'zai', refresh: true });
    expect((await c.reply('m2')).ok).toBe(true);
    expect(fetchCalls).toEqual(['yan']); // ручной список у Claude Code не спрашиваем

    fail = true;
    c.send({ id: 'm3', type: 'cmd:profile.models', profile: 'default', refresh: true });
    const r3 = await c.reply('m3');
    expect(r3.code).toBe('MODELS_FAILED');
    expect(r3.message).toContain('нет сети');
  });

  it('без modelsFetcher refresh — честная ошибка, без refresh — текущий список', async () => {
    const { c } = await setup();
    c.send({ id: 'm1', type: 'cmd:profile.models', profile: 'yan', refresh: true });
    expect((await c.reply('m1')).code).toBe('MODELS_FAILED');
    c.send({ id: 'm2', type: 'cmd:profile.models', profile: 'yan' });
    const r = await c.reply('m2');
    expect((r.data as { profile: { models: unknown[] } }).profile.models).toHaveLength(2);
  });
});

describe('шлюз из settings.json Claude Code', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const cfg = (env: Record<string, string> | null) => {
    const d = mkdtempSync(join(tmpdir(), 'cc-cfg-'));
    dirs.push(d);
    if (env) writeFileSync(join(d, 'settings.json'), JSON.stringify({ env }));
    return d;
  };
  it('GLM в settings.json (как локально у владельца) — аккаунт считается шлюзом', () => {
    const d = cfg({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'x' });
    expect(settingsBaseUrl(d)).toBe('https://api.z.ai/api/anthropic');
    expect(isGateway({ name: 'local-glm', configDir: d })).toBe(true);
  });
  it('Anthropic в settings.json, нет файла или битый — не шлюз', () => {
    expect(isGateway({ name: 'a', configDir: cfg({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }) })).toBe(false);
    expect(isGateway({ name: 'b', configDir: cfg(null) })).toBe(false);
    const bad = cfg(null);
    writeFileSync(join(bad, 'settings.json'), '{не json');
    expect(settingsBaseUrl(bad)).toBeUndefined();
  });
  it('env профиля важнее settings.json', () => {
    const d = cfg({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' });
    expect(isGateway({ name: 'c', configDir: d, env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })).toBe(false);
  });
});

describe('ключ API аккаунта из UI', () => {
  it('записывается в env профиля, клиенту — только последние символы; подписку и default не трогаем', async () => {
    const { c, dir, manager } = await setup({ file: true });
    const sid = await newSession(c, 's1', { profile: 'zai' });
    await sleep(20);
    const key = '94b7xxxxxxxxxxxxxxxxxxxx.newKEYtail';
    c.send({ id: 'k1', type: 'cmd:profile.update', profile: 'zai', apiKey: key });
    const r = await c.reply('k1');
    expect(r.ok).toBe(true);
    const data = r.data as { profile: Record<string, unknown>; restarted: number; busy: number };
    expect(data.profile).toMatchObject({ keyHint: '…tail', keyEditable: true });
    expect(JSON.stringify(r)).not.toContain(key);
    const ev = await c.waitType<{ profiles: unknown[] }>('event:profiles');
    expect(JSON.stringify(ev)).not.toContain(key);
    // в файле — новый ключ, адрес шлюза на месте
    const raw = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
    expect(raw.profiles.find((x: { name: string }) => x.name === 'zai').env).toEqual({ ...ZAI_ENV, ANTHROPIC_AUTH_TOKEN: key });
    // простаивающая сессия аккаунта остановлена — поднимется с новым ключом
    expect(data.restarted + data.busy).toBe(1);
    // фейковый движок отдаёт управление не сразу (держит поток) — ждём остановки до 4 с
    if (data.restarted === 1) {
      for (let i = 0; i < 80 && manager.get(sid)?.state !== 'dead'; i++) await sleep(50);
      expect(manager.get(sid)?.state).toBe('dead');
    }

    c.send({ id: 'k2', type: 'cmd:profile.update', profile: 'yan', apiKey: 'sk-abcdefghijklmnop' });
    const r2 = await c.reply('k2');
    expect(r2.code).toBe('PROFILE_UPDATE_FAILED');
    expect(r2.message).toContain('подписк');
    c.send({ id: 'k3', type: 'cmd:profile.update', profile: 'default', apiKey: 'sk-abcdefghijklmnop' });
    expect((await c.reply('k3')).code).toBe('PROFILE_UPDATE_FAILED');
    c.send({ id: 'k4', type: 'cmd:profile.update', profile: 'zai', apiKey: 'с пробелом внутри' });
    expect((await c.reply('k4')).ok).toBe(false);
  });
});

describe('стартовый ручной список моделей шлюза', () => {
  it('модель профиля + модели из env (z.ai задаёт GLM вместо sonnet/opus/haiku), без дублей, без усилия', () => {
    expect(seedModels({ name: 'zai', model: 'glm-5.3[1m]', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air' } }))
      .toEqual([{ id: 'glm-5.3[1m]', efforts: [] }, { id: 'glm-5.3', efforts: [] }, { id: 'glm-4.5-air', efforts: [] }]);
  });
  it('аккаунт supervisor-а без своих полей — модели из settings.json Claude Code (как GLM у владельца локально)', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    try {
      writeFileSync(join(d, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_MODEL: 'glm-5.3[1m]' } }));
      expect(seedModels({ name: 'local', configDir: d })).toEqual([{ id: 'glm-5.3[1m]', efforts: [] }]);
      // профиль без своей папки конфигурации не читает чужой settings.json
      expect(seedModels({ name: 'x', model: 'm1' })).toEqual([{ id: 'm1', efforts: [] }]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('WSS: 1M и свои модели у идущих сессий', () => {
  it('1M у модели аккаунта включили и выключили — идущая сессия меняет модель на ходу', async () => {
    const { c, engineModels } = await setup();
    // модель аккаунта glm-5.3[1m] — 1M у glm-5.3 включён из неё, сессия стартует с [1m]
    await newSession(c, 'n1', { profile: 'zai', model: 'glm-5.3' });
    c.send({ id: 'u1', type: 'cmd:profile.update', profile: 'zai', long: [] });
    expect((await c.reply('u1')).ok).toBe(true);
    for (let i = 0; i < 40 && !engineModels.includes('glm-5.3'); i++) await sleep(25);
    expect(engineModels).toEqual(['glm-5.3']);
    c.send({ id: 'u2', type: 'cmd:profile.update', profile: 'zai', long: ['glm-5.3'] });
    expect((await c.reply('u2')).ok).toBe(true);
    for (let i = 0; i < 40 && engineModels.length < 2; i++) await sleep(25);
    expect(engineModels).toEqual(['glm-5.3', 'glm-5.3[1m]']);
  });

  it('своя модель: сохраняется у аккаунта; переход на модель с другим окном — процесс гасится между ходами, модель запоминается', async () => {
    const { c, manager } = await setup();
    c.send({ id: 'u1', type: 'cmd:profile.update', profile: 'zai', custom: [{ id: '?', base: 'glm-5.3', ctx: 400_000 }] });
    const r = await c.reply('u1');
    expect((r.data as { profile: Record<string, unknown> }).profile).toMatchObject({ custom: [{ id: 'glm-5.3@400k', base: 'glm-5.3', ctx: 400_000 }] });
    const sid = await newSession(c, 'n1', { profile: 'zai', model: 'glm-5.3@400k' });
    c.send({ id: 's1', type: 'cmd:session.settings', sessionId: sid, model: 'glm-5.3' });
    expect((await c.reply('s1')).ok).toBe(true);
    expect(manager.get(sid)).toMatchObject({ model: 'glm-5.3', state: 'dead' });
  });
});
