// Лимиты аккаунта: разбор rate_limit_event Claude Code, /usage, квоты z.ai (форма — из живого ответа 23.11).
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileRegistry } from './profiles.js';
import { fetchZaiUsage, isZaiHost, usageFromRateLimit, usageFromUsageApi, usageFromZai } from './usage.js';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Frame } from '@perimeter/protocol';
import { SessionManager } from './session/manager.js';
import { WssServer } from './wss.js';
import type { QueryLike, SdkMsg, SdkUserInput } from './session/types.js';

describe('usage: разбор источников', () => {
  it('rate_limit_event: окна unifiedWindows (доля → %, секунды → мс), порядок 5 ч → неделя', () => {
    const u = usageFromRateLimit({ status: 'allowed', unifiedWindows: {
      seven_day: { utilization: 0.17, resetsAt: 1_795_713_360, status: 'allowed' },
      five_hour: { utilization: 0.42, resetsAt: 1_795_457_760, status: 'allowed_warning' },
    } }, 1)!;
    expect(u).toEqual({ source: 'claude', at: 1, windows: [
      { id: 'five_hour', label: '5 часов', pct: 42, resetsAt: 1_795_457_760_000, status: 'allowed_warning' },
      { id: 'seven_day', label: 'неделя', pct: 17, resetsAt: 1_795_713_360_000, status: 'allowed' },
    ] });
    expect(usageFromRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 10 })!.windows).toEqual([{ id: 'five_hour', label: '5 часов', pct: 50, resetsAt: 10_000, status: 'allowed' }]);
    expect(usageFromRateLimit({ status: 'allowed' })).toBeNull();
    expect(usageFromRateLimit(null)).toBeNull();
  });

  it('/usage: проценты 0–100, ISO-время, окна по моделям; недоступно — null', () => {
    const u = usageFromUsageApi({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 12, resets_at: '2026-11-23T20:00:00Z' }, seven_day: { utilization: 30, resets_at: null }, seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: '2026-11-25T00:00:00Z' }],
    } }, 1)!;
    expect(u.plan).toBe('max');
    expect(u.windows.map((w) => [w.id, w.label, w.pct])).toEqual([['five_hour', '5 часов', 12], ['seven_day', 'неделя', 30], ['model:Fable', 'неделя · Fable', 5]]);
    expect(u.windows[0]!.resetsAt).toBe(Date.parse('2026-11-23T20:00:00Z'));
    expect(usageFromUsageApi({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toBeNull();
  });

  it('z.ai: кредиты по окнам (unit 3/5 — 5 часов, 6/1 — неделя), MCP — отдельно; короткое окно первым', () => {
    const live = { code: 200, success: true, data: { level: 'max', limits: [
      { type: 'CREDIT_LIMIT', percentage: 25, nextResetTime: 1_795_984_056_999, unit: 6, number: 1, usage: 140000, currentValue: 35455 },
      { type: 'CREDIT_LIMIT', percentage: 2, nextResetTime: 1_795_471_631_385, unit: 3, number: 5, usage: 28000, currentValue: 780 },
      { type: 'TIME_LIMIT', percentage: 10, unit: 5, number: 1, usage: 4000, currentValue: 400 },
    ] } };
    const u = usageFromZai(live, 1)!;
    expect(u.plan).toBe('max');
    expect(u.windows.map((w) => [w.label, w.pct, w.used, w.limit])).toEqual([['5 часов', 2, 780, 28000], ['неделя', 25, 35455, 140000], ['MCP · месяц', 10, 400, 4000]]);
    expect(usageFromZai({ code: 401, success: false, msg: 'bad key' })).toBeNull();
  });

  it('z.ai: запрос квоты — домен шлюза, ключ в Authorization как есть (без Bearer)', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ success: true, data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', percentage: 7, unit: 3, number: 5 }] } }), { status: 200 });
    }) as typeof fetch;
    const u = await fetchZaiUsage('https://api.z.ai/api/anthropic', 'zai-key-123', fake);
    expect(calls).toEqual([{ url: 'https://api.z.ai/api/monitor/usage/quota/limit', auth: 'zai-key-123' }]);
    expect(u.windows[0]).toMatchObject({ label: '5 часов', pct: 7 });
    expect(isZaiHost('api.z.ai')).toBe(true);
    expect(isZaiHost('open.bigmodel.cn')).toBe(true);
    expect(isZaiHost('api.anthropic.com')).toBe(false);
  });

  it('источник лимитов у аккаунта: z.ai, подписка Claude (вход или токен подписки); ключ API — нет; показ — настройкой', () => {
    const reg = new ProfileRegistry([
      { name: 'zai', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k' } },
      { name: 'sub', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } },
      { name: 'login', configDir: '/tmp/nope-login' },
      { name: 'api', env: { ANTHROPIC_API_KEY: 'sk-ant-api' } },
      { name: 'other', env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'k' } },
      { name: 'hidden', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-y' }, usage: false },
    ]);
    expect(['zai', 'sub', 'login', 'api', 'other'].map((n) => reg.usageSource(n))).toEqual(['zai', 'claude', 'claude', undefined, undefined]);
    expect(reg.usageShown('sub')).toBe(true);
    expect(reg.usageShown('api')).toBe(false);
    expect(reg.usageShown('hidden')).toBe(false);
    expect(reg.info('zai')).toMatchObject({ usageSource: 'zai', usage: true });
    expect(reg.info('api')?.usageSource).toBeUndefined();
  });
});

// ─── WSS: лимиты из сессии → event:usage → profile.usage ─────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const s of stops.splice(0).reverse()) await s(); });

async function wssWith(opts: { usageFetcher?: (p: string) => Promise<import('@perimeter/protocol').UsageInfo | null> } = {}) {
  const profiles = new ProfileRegistry([
    { name: 'sub', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } },
    { name: 'zai', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k' } },
    { name: 'api', env: { ANTHROPIC_API_KEY: 'sk-ant-api' } },
  ]);
  const manager = new SessionManager();
  const factory = (input: AsyncIterable<SdkUserInput>): QueryLike => {
    void (async () => { for await (const _ of input) void _; })().catch(() => undefined);
    const g = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: '33333333-3333-4333-8333-333333333333', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 100 }, seven_day: { utilization: 0.17, resetsAt: 200 } } } } as SdkMsg;
      yield { type: 'result', subtype: 'success' } as SdkMsg;
      await sleep(2000);
    })();
    return { [Symbol.asyncIterator]: () => g, interrupt: async () => undefined, close: async () => { await g.return(undefined); } };
  };
  const server = new WssServer(manager, { port: 0, profiles, sessionFactory: () => factory, resumeFactory: () => factory, ...(opts.usageFetcher ? { usageFetcher: opts.usageFetcher } : {}) });
  const port = await server.start();
  stops.push(() => server.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  stops.push(() => ws.close());
  const frames: Frame[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Frame));
  const send = (f: Record<string, unknown>) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...f }));
  const wait = async <T>(pred: (f: Record<string, unknown>) => boolean): Promise<T> => {
    for (let i = 0; i < 200; i++) { const f = frames.find((x) => pred(x as unknown as Record<string, unknown>)); if (f) return f as T; await sleep(20); }
    throw new Error('нет кадра');
  };
  send({ id: 'h', type: 'cmd:hello', lastSeq: {} });
  await wait((f) => f['id'] === 'h');
  return { send, wait };
}

describe('WSS: лимиты аккаунта', () => {
  it('лимиты из ответа API в сессии рассылаются (event:usage) и отдаются по profile.usage без похода к источнику', async () => {
    let fetched = 0;
    const { send, wait } = await wssWith({ usageFetcher: async () => { fetched++; return null; } });
    send({ id: 'n', type: 'cmd:session.new', profile: 'sub' });
    const ev = await wait<{ profile: string; usage: { windows: Array<{ id: string; pct: number }> } }>((f) => f['type'] === 'event:usage');
    expect(ev.profile).toBe('sub');
    expect(ev.usage.windows.map((w) => [w.id, w.pct])).toEqual([['five_hour', 42], ['seven_day', 17]]);
    send({ id: 'u', type: 'cmd:profile.usage', profile: 'sub' });
    const r = await wait<{ ok: boolean; data: { usage: { windows: unknown[] } } }>((f) => f['id'] === 'u');
    expect(r.data.usage.windows).toHaveLength(2);
    expect(fetched).toBe(0); // свежее минуты — источник не дёргаем
  });

  it('z.ai — через фетчер; ключ API — лимитов нет (null с пояснением)', async () => {
    const { send, wait } = await wssWith({ usageFetcher: async (p) => (p === 'zai' ? { source: 'zai', windows: [{ id: 'z', label: '5 часов', pct: 3 }], at: Date.now() } : null) });
    send({ id: 'z', type: 'cmd:profile.usage', profile: 'zai', refresh: true });
    const z = await wait<{ data: { usage: { source: string; windows: Array<{ pct: number }> } } }>((f) => f['id'] === 'z');
    expect(z.data.usage).toMatchObject({ source: 'zai', windows: [{ pct: 3 }] });
    send({ id: 'a', type: 'cmd:profile.usage', profile: 'api' });
    const a = await wait<{ data: { usage: null; note: string } }>((f) => f['id'] === 'a');
    expect(a.data.usage).toBeNull();
    expect(a.data.note).toMatch(/нет лимитов/);
  });

  it('подписка без событий и без /usage — пояснение «появятся после первого хода»', async () => {
    const { send, wait } = await wssWith({ usageFetcher: async () => null });
    send({ id: 's', type: 'cmd:profile.usage', profile: 'sub', refresh: true });
    const s = await wait<{ data: { usage: null; note: string } }>((f) => f['id'] === 's');
    expect(s.data.usage).toBeNull();
    expect(s.data.note).toMatch(/после первого хода/);
  });
});
