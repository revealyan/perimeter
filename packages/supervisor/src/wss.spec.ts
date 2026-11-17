// Интеграционные инварианты WSS (p0-design §5): seq без дыр (1), догон после обрыва (3),
// разрешение через сокет (4), неизвестный кадр игнорируется (5), хост 127.0.0.1 (6).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Frame } from '@perimeter/protocol';
import { PROTOCOL_VERSION } from '@perimeter/protocol';
import { SessionManager, type SessionCreateOptions } from './session/manager.js';
import { transcriptPath } from './transcript.js';
import type { EngineHooks } from './session/engine.js';
import type { SdkMsg, SdkUserInput } from './session/types.js';
import { ProfileRegistry } from './profiles.js';
import { WssServer } from './wss.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PARENT_SID = '4265f11d-e860-47ad-9b54-306e22e68390';

class Client {
  frames: Frame[] = [];
  private pending = new Map<string, Array<(f: Frame) => void>>();
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as Frame;
      this.frames.push(f);
      const t = this.typeOf(f);
      if (!t) return;
      const list = this.pending.get(t);
      if (list && list.length) {
        const resolve = list.shift()!;
        resolve(f);
        if (!list.length) this.pending.delete(t);
      }
    });
  }
  send(f: unknown): void { this.ws.send(JSON.stringify(f)); }
  private typeOf(f: Frame): string | undefined {
    return 'type' in f ? f.type : undefined;
  }
  async wait<T = Frame>(type: string, ms = 4000): Promise<T> {
    const found = this.frames.find((f) => this.typeOf(f) === type);
    if (found) return found as T;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`нет кадра ${type}; есть: ${this.frames.map((f) => this.typeOf(f)).join(',')}`)), ms);
      const list = this.pending.get(type) ?? [];
      list.push((f) => { clearTimeout(timer); resolve(f as T); });
      this.pending.set(type, list);
    });
  }
  ackOf(id: string): Frame | undefined {
    return this.frames.find((f) => 'id' in f && f.id === id);
  }
  close(): void { this.ws.close(); }
}

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return new Client(ws);
}

const running: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of running.splice(0)) await stop(); });

/** Фабрика-мок: возвращает QueryLike (генератор сценария + interrupt). */
function queryLike(script: (hooks: EngineHooks) => AsyncGenerator<SdkMsg>) {
  return (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => {
    void (async () => { for await (const _ of input) void _; })().catch(() => undefined);
    const g = script(hooks);
    return {
      [Symbol.asyncIterator]: () => g,
      interrupt: async () => undefined,
      close: async () => { /* генератор доедет сам */ },
    };
  };
}

describe('WSS-сервер', () => {
  it('инварианты 1/3/5/6: hello, поток, обрыв → догон без потерь, неизвестный кадр игнорируется, хост 127.0.0.1', async () => {
    const manager = new SessionManager();
    const server = new WssServer(manager, { port: 0, sessionFactory: () => queryLike(async function* () {
      yield { type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
      // темп как у живого хода: обрыв ловит середину, хвост идёт уже без клиента
      for (let i = 0; i < 5; i++) {
        await sleep(80);
        yield { type: 'assistant', message: { id: `msg_${i}`, content: [{ type: 'text', text: `кусок-${i}` }] } } as SdkMsg;
      }
      await sleep(80);
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, duration_ms: 10 } as SdkMsg;
      await sleep(1500); // держим процесс живым, пока тест переподключается
    }) });
    const port = await server.start();
    running.push(() => server.stop());

    // инвариант 6: слушаем только loopback
    expect(port).toBeGreaterThan(0);
    expect(server.boundHost).toBe('127.0.0.1');

    const c1 = await connect(port);
    c1.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h1', type: 'cmd:hello', lastSeq: {} });
    await c1.wait('event:hello');

    // неизвестный кадр не роняет и не отвечает (инвариант 5)
    c1.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'f1', type: 'cmd:из-будущего' });
    await sleep(150);
    expect(c1.frames.some((f) => 'id' in f && f.id === 'f1')).toBe(false);

    // создаём сессию
    c1.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new', name: 'тест' });
    const ack = await c1.wait('event:session.state'); // initializing
    expect((ack as { type?: string }).type).toBe('event:session.state');

    // ловим первые 3 события сессии и рвём соединение
    await c1.wait('event:message.assistant');
    await sleep(50);
    const seenBefore = c1.frames.filter((f) => 'type' in f && f.type === 'event:message.assistant');
    const sidFrame = c1.frames.find((f) => 'sessionId' in f && f.sessionId);
    const sid = (sidFrame as { sessionId?: string })?.sessionId ?? '';
    expect(sid).not.toBe('');
    const lastSeq = Math.max(...c1.frames.filter((f) => 'seq' in f).map((f) => (f as { seq: number }).seq));
    c1.close();

    await sleep(300); // пусть накопится хвост

    // переподключаемся с догоном (инвариант 3)
    const c2 = await connect(port);
    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h2', type: 'cmd:hello', lastSeq: { [sid]: lastSeq } });
    await c2.wait('event:hello');
    await c2.wait('event:turn.result');
    await sleep(100);

    const all = c2.frames.filter((f) => 'seq' in f && (f as { sessionId?: string }).sessionId === sid);
    const seqs = all.map((f) => (f as { seq: number }).seq);
    // без дыр и строго восходящие
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    // всё, что было до обрыва, не дублируется
    expect(seqs[0]).toBe(lastSeq + 1);
    // суммарно видны те же события, что шли живьём + хвост
    const assistantTotal = c2.frames.filter((f) => 'type' in f && f.type === 'event:message.assistant').length;
    expect(assistantTotal).toBeGreaterThanOrEqual(5 - seenBefore.length);
    c2.close();
  });

  it('RESYNC_NEEDED при дыре глубже ринг-буфера', async () => {
    const manager = new SessionManager();
    const server = new WssServer(manager, { port: 0, ringCapacity: 4, sessionFactory: () => queryLike(async function* () {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
      for (let i = 0; i < 10; i++) {
        yield { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: `${i}` }] } } as SdkMsg;
      }
      await sleep(1500);
    }) });
    const port = await server.start();
    running.push(() => server.stop());

    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h1', type: 'cmd:hello', lastSeq: {} });
    await c.wait('event:hello');
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new' });
    await c.wait('event:message.assistant');
    const sidFrame = c.frames.find((f) => 'sessionId' in f && f.sessionId);
    const sid = (sidFrame as { sessionId?: string })?.sessionId ?? '';
    c.close();

    await sleep(300);
    const c2 = await connect(port);
    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h2', type: 'cmd:hello', lastSeq: { [sid]: 0 } });
    const errFrame = await c2.wait('event:error');
    expect((errFrame as { code?: string }).code).toBe('RESYNC_NEEDED');
    c2.close();
  });

  it('мультиакк: профиль доходит до фабрики,Unknown профиль отклоняется,hello отдаёт профили', async () => {
    const manager = new SessionManager();
    const factoryArgs: Array<Record<string, unknown>> = [];
    const profiles = new ProfileRegistry([
      { name: 'yan', model: 'sonnet', description: 'подписка yan' },
      { name: 'acc2', configDir: '/home/yan/.perimeter/accounts/acc2/.claude' },
    ]);
    const server = new WssServer(manager, {
      port: 0,
      profiles,
      sessionFactory: (sess) => {
        factoryArgs.push({ ...sess });
        return queryLike(async function* () {
          yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
          await sleep(800);
        });
      },
    });
    const port = await server.start();
    running.push(() => server.stop());

    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h1', type: 'cmd:hello', lastSeq: {} });
    const hello = await c.wait('event:hello');
    const prof = (hello as unknown as { profiles?: Array<{ name: string }> }).profiles ?? [];
    // + аккаунт самого supervisor'а (сессии без профиля) — `default`
    expect(prof.map((p) => p.name)).toEqual(['yan', 'acc2', 'default']);

    // сессия под профилем
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new', profile: 'yan' });
    await c.wait('event:session.state');
    expect(factoryArgs.some((a) => a['profile'] === 'yan')).toBe(true);

    // Unknown профиль → err
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n2', type: 'cmd:session.new', profile: 'нет' });
    await sleep(150);
    const reply = c.frames.find((x) => 'id' in x && x.id === 'n2' && 'ok' in x) as unknown as { code?: string };
    expect(reply?.code).toBe('UNKNOWN_PROFILE');
    c.close();
  });

  it('инвариант 4: карточка разрешения и ответ уходят через сокет; pending ждёт реконнекта', async () => {
    const manager = new SessionManager();
    const server = new WssServer(manager, { port: 0, sessionFactory: () => queryLike(async function* (hooks) {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default' } as SdkMsg;
      const decision = hooks.canUseTool('Bash', { command: 'npm test' });
      yield { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'жду одобрения' }] } } as SdkMsg;
      const r = await decision;
      yield { type: 'result', subtype: 'success', result: r.behavior } as SdkMsg;
      await sleep(1000);
    }) });
    const port = await server.start();
    running.push(() => server.stop());

    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h1', type: 'cmd:hello', lastSeq: {} });
    await c.wait('event:hello');
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new' });
    const req = await c.wait('event:permission.request');
    const sid = (req as { sessionId?: string }).sessionId ?? '';
    const requestId = (req as { requestId: string }).requestId;

    // рвём соединение ДО ответа — запрос висит (pending)
    c.close();
    await sleep(150);

    // реконнект, догон, ответ
    const c2 = await connect(port);
    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h2', type: 'cmd:hello', lastSeq: {} });
    await c2.wait('event:hello');
    // карточка всё ещё видна в списке сессий с needs
    const hello = c2.frames.find((f) => 'type' in f && f.type === 'event:hello') as { sessions?: Array<{ state?: string }> } | undefined;
    expect(hello?.sessions?.[0]?.state).toBe('waiting_permission');

    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 'p1', type: 'cmd:permission.respond', requestId, behavior: 'allow' });
    const doneFrame = await c2.wait('event:turn.result');
    expect((doneFrame as { result?: string }).result).toBe('allow');
    c2.close();
  });
});

// ─── аудит WSS: живучесть демона, порядок кадров при hello, карточки свежему клиенту, ресинк ─────

const AUDIT_CLAUDE_SID = '66666666-6664-4666-8666-666666666666';
const auditInit = (): SdkMsg => ({ type: 'system', subtype: 'init', session_id: AUDIT_CLAUDE_SID, tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' });

async function waitReply(c: Client, id: string, ms = 3000): Promise<{ ok: boolean; code?: string; data?: Record<string, unknown> }> {
  for (let i = 0; i < ms / 20; i++) {
    const f = c.frames.find((x) => 'id' in x && x.id === id && 'ok' in x);
    if (f) return f as unknown as { ok: boolean; code?: string; data?: Record<string, unknown> };
    await sleep(20);
  }
  throw new Error(`нет ответа на ${id}`);
}

const sidOf = (c: Client): string => (c.frames.find((f) => 'sessionId' in f && f.sessionId) as { sessionId?: string } | undefined)?.sessionId ?? '';
const framesOf = (c: Client, sid: string) => c.frames.filter((f) => 'seq' in f && (f as { sessionId?: string }).sessionId === sid) as Array<Frame & { seq: number; type: string }>;

describe('аудит WSS', () => {
  it('ошибка внутри команды не роняет демон: permission.respond по несуществующей сессии → err', async () => {
    const manager = new SessionManager();
    const server = new WssServer(manager, { port: 0, sessionFactory: () => queryLike(async function* () { yield auditInit(); await sleep(300); }) });
    const port = await server.start();
    running.push(() => server.stop());
    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h', type: 'cmd:hello', lastSeq: {} });
    await c.wait('event:hello');
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: '77777777-7777-4777-8777-777777777777', id: 'p1', type: 'cmd:permission.respond', requestId: 'нет', behavior: 'allow' });
    const r = await waitReply(c, 'p1');
    expect(r.ok).toBe(false);
    // демон жив и отвечает дальше
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'l1', type: 'cmd:session.list' });
    expect((await waitReply(c, 'l1')).ok).toBe(true);
    c.close();
  });

  it('до hello клиент не получает событий сессий: догон идёт строго по порядку, без дублей', async () => {
    const manager = new SessionManager();
    const server = new WssServer(manager, { port: 0, sessionFactory: () => queryLike(async function* () {
      yield auditInit();
      for (let i = 0; i < 40; i++) {
        await sleep(15);
        yield { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: `${i}` }] } } as SdkMsg;
      }
      await sleep(1000);
    }) });
    const port = await server.start();
    running.push(() => server.stop());

    const c1 = await connect(port);
    c1.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h1', type: 'cmd:hello', lastSeq: {} });
    await c1.wait('event:hello');
    c1.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new' });
    await c1.wait('event:message.assistant');
    await sleep(60);
    const sid = sidOf(c1);
    const lastSeq = Math.max(...framesOf(c1, sid).map((f) => f.seq));
    c1.close();

    // реконнект через туннель: между open и hello — RTT, ход в это время стримит
    const c2 = await connect(port);
    await sleep(120);
    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h2', type: 'cmd:hello', lastSeq: { [sid]: lastSeq } });
    await c2.wait('event:hello');
    await sleep(150);
    const helloAt = c2.frames.findIndex((f) => 'type' in f && f.type === 'event:hello');
    expect(c2.frames.slice(0, helloAt).filter((f) => (f as { sessionId?: string }).sessionId === sid)).toEqual([]);
    const seqs = framesOf(c2, sid).map((f) => f.seq);
    expect(seqs[0]).toBe(lastSeq + 1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    c2.close();
  });

  it('висящая карточка разрешения досылается свежему клиенту (hello без lastSeq); ответ двигает сессию дальше', async () => {
    const manager = new SessionManager();
    const server = new WssServer(manager, { port: 0, sessionFactory: () => queryLike(async function* (hooks) {
      yield auditInit();
      const r = await hooks.canUseTool('Bash', { command: 'rm -rf dist' });
      yield { type: 'result', subtype: 'success', result: r.behavior } as SdkMsg;
      await sleep(1000);
    }) });
    const port = await server.start();
    running.push(() => server.stop());

    const c1 = await connect(port);
    c1.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h1', type: 'cmd:hello', lastSeq: {} });
    await c1.wait('event:hello');
    c1.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new' });
    const req1 = await c1.wait<{ requestId: string; seq: number; sessionId: string }>('event:permission.request');
    const sid = req1.sessionId;
    c1.close();
    await sleep(50);

    // клиент, который карточку уже видел (lastSeq покрывает её) — дубля не получает
    const c3 = await connect(port);
    c3.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h3', type: 'cmd:hello', lastSeq: { [sid]: req1.seq } });
    await waitReply(c3, 'h3');
    expect(c3.frames.filter((f) => 'type' in f && f.type === 'event:permission.request')).toEqual([]);

    // свежий клиент (перезапуск приложения): lastSeq пустой — карточку получает с исходным seq
    const c2 = await connect(port);
    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h2', type: 'cmd:hello', lastSeq: {} });
    const req2 = await c2.wait<{ requestId: string; seq: number }>('event:permission.request');
    expect(req2.requestId).toBe(req1.requestId);
    expect(req2.seq).toBe(req1.seq);
    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 'p1', type: 'cmd:permission.respond', requestId: req2.requestId, behavior: 'allow' });
    const done = await c2.wait<{ result?: string }>('event:turn.result');
    expect(done.result).toBe('allow');
    c2.close();
    c3.close();
  });

  it('после рестарта клиент «впереди» сервера (персист отстал) → RESYNC_NEEDED; неизвестные сессии игнорируются', async () => {
    const manager = new SessionManager();
    const sid = '88888888-8888-4888-8888-888888888888';
    manager.restore([{ id: sid, name: 'до рестарта', claudeSessionId: AUDIT_CLAUDE_SID, cwd: '/opt/x', lastSeq: 5 }], undefined);
    const server = new WssServer(manager, { port: 0, sessionFactory: () => queryLike(async function* () { yield auditInit(); }) });
    const port = await server.start();
    running.push(() => server.stop());
    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h', type: 'cmd:hello', lastSeq: { [sid]: 9, 'не-uuid': 3 } });
    await waitReply(c, 'h');
    const errs = c.frames.filter((f) => 'type' in f && f.type === 'event:error') as Array<{ code: string; sessionId?: string }>;
    expect(errs.map((e) => [e.code, e.sessionId])).toEqual([['RESYNC_NEEDED', sid]]);
    c.close();
  });
});

describe('аудит WSS: транскрипты и профили', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const writeTranscript = (cfg: string, cwd: string, lines: unknown[]) => {
    const p = transcriptPath(cfg, cwd, AUDIT_CLAUDE_SID);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  };

  it('transcript.get: до init и без файла — ack с пустой лентой; транскрипт ищется в CLAUDE_CONFIG_DIR профиля', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'cc-cfg-')); tmpDirs.push(cfg);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const manager = new SessionManager();
    const server = new WssServer(manager, {
      port: 0,
      profiles: new ProfileRegistry([{ name: 'acc2', configDir: cfg }]),
      sessionFactory: () => queryLike(async function* () { await gate; yield auditInit(); await sleep(800); }),
    });
    const port = await server.start();
    running.push(() => server.stop());
    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h', type: 'cmd:hello', lastSeq: {} });
    await waitReply(c, 'h');
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n', type: 'cmd:session.new', profile: 'acc2', cwd: '/opt/x' });
    const sid = String((await waitReply(c, 'n')).data?.['sessionId']);

    // ещё не было ни одного сообщения: claudeSessionId нет
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 't1', type: 'cmd:transcript.get' });
    const t1 = await waitReply(c, 't1');
    expect(t1.ok).toBe(true);
    expect(t1.data?.['items']).toEqual([]);

    // init прошёл, но файла ещё нет
    release();
    await c.wait('event:session.init');
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 't2', type: 'cmd:transcript.get' });
    const t2 = await waitReply(c, 't2');
    expect(t2.ok).toBe(true);
    expect(t2.data?.['items']).toEqual([]);

    // файл в каталоге профиля (а не в ~/.claude supervisor'а)
    writeTranscript(cfg, '/opt/x', [
      { type: 'user', message: { role: 'user', content: 'привет' } },
      { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'здравствуй' }] } },
    ]);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 't3', type: 'cmd:transcript.get' });
    const t3 = await waitReply(c, 't3');
    expect((t3.data?.['items'] as unknown[]).length).toBe(2);
    c.close();
  });

  it('смена аккаунта: транскрипт переезжает в каталог нового профиля, модель уходит в respawn, а не в старый процесс', async () => {
    const cfgA = mkdtempSync(join(tmpdir(), 'cc-cfgA-')); tmpDirs.push(cfgA);
    const cfgB = mkdtempSync(join(tmpdir(), 'cc-cfgB-')); tmpDirs.push(cfgB);
    const setModelCalls: string[] = [];
    const resumed: Array<{ profile?: string; model?: string; claudeSessionId?: string }> = [];
    const engine = (): SessionCreateOptions['factory'] => (input, _hooks) => {
      void (async () => { for await (const _ of input) void _; })().catch(() => undefined);
      const g = (async function* () {
        yield auditInit();
        yield { type: 'result', subtype: 'success' } as SdkMsg;
        await sleep(800);
      })();
      return {
        [Symbol.asyncIterator]: () => g,
        interrupt: async () => undefined,
        close: async () => undefined,
        setModel: async (m: string) => { setModelCalls.push(m); },
      };
    };
    const manager = new SessionManager();
    const server = new WssServer(manager, {
      port: 0,
      profiles: new ProfileRegistry([{ name: 'a', configDir: cfgA }, { name: 'b', configDir: cfgB }]),
      sessionFactory: () => engine(),
      resumeFactory: (_sid, info) => {
        resumed.push({
          ...(info.profile !== undefined ? { profile: info.profile } : {}),
          ...(info.model !== undefined ? { model: info.model } : {}),
          ...(info.claudeSessionId !== undefined ? { claudeSessionId: info.claudeSessionId } : {}),
        });
        return engine();
      },
    });
    const port = await server.start();
    running.push(() => server.stop());
    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h', type: 'cmd:hello', lastSeq: {} });
    await waitReply(c, 'h');
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n', type: 'cmd:session.new', profile: 'a', cwd: '/opt/x' });
    const sid = String((await waitReply(c, 'n')).data?.['sessionId']);
    await c.wait('event:turn.result');
    await sleep(30);
    writeTranscript(cfgA, '/opt/x', [{ type: 'user', message: { role: 'user', content: 'история аккаунта a' } }]);

    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 's', type: 'cmd:session.settings', profile: 'b', model: 'glm-5.3[1m]' });
    const r = await waitReply(c, 's');
    expect(r.ok).toBe(true);
    expect(existsSync(transcriptPath(cfgB, '/opt/x', AUDIT_CLAUDE_SID))).toBe(true);
    expect(setModelCalls).toEqual([]);
    expect(resumed).toEqual([{ profile: 'b', model: 'glm-5.3[1m]', claudeSessionId: AUDIT_CLAUDE_SID }]);

    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 't', type: 'cmd:transcript.get' });
    const t = await waitReply(c, 't');
    expect((t.data?.['items'] as Array<{ data: { text?: string } }>).map((i) => i.data.text)).toEqual(['история аккаунта a']);
    c.close();
  });

  it('новая сессия — event:session.created всем клиентам (seq 0), hello несёт parentSessionId', async () => {
    const manager = new SessionManager();
    const server = new WssServer(manager, { port: 0, sessionFactory: (_sess, _id) => queryLike(async function* () {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default' } as SdkMsg;
      await sleep(1500);
    }) });
    const port = await server.start();
    running.push(() => server.stop());
    const c1 = await connect(port);
    c1.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h1', type: 'cmd:hello', lastSeq: {} });
    await c1.wait('event:hello');
    const c2 = await connect(port);
    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h2', type: 'cmd:hello', lastSeq: {} });
    await c2.wait('event:hello');

    // второй клиент создаёт сессию → первый (уже подключённый) узнаёт о ней без hello
    c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n', type: 'cmd:session.new', name: 'воркер', parentSessionId: PARENT_SID });
    const ack = await waitReply(c2, 'n');
    const sid = String(ack.data?.['sessionId']);
    const created = await c1.wait('event:session.created');
    expect(created).toMatchObject({ seq: 0, session: { id: sid, name: 'воркер', parentSessionId: PARENT_SID } });

    // hello после этого несёт родителя (вложенность переживает переподключение)
    const c3 = await connect(port);
    c3.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h3', type: 'cmd:hello', lastSeq: {} });
    const hello = await c3.wait('event:hello');
    expect((hello as { sessions?: unknown[] }).sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: sid, parentSessionId: PARENT_SID })]));
    c1.close(); c2.close(); c3.close();
  });
});
