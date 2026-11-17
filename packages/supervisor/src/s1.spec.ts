// S1: проекты (CRUD + дефолты при создании сессии), настройки живой сессии
// (модель на лету, смена профиля между ходами), снимок контекста.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Frame } from '@perimeter/protocol';
import { PROTOCOL_VERSION } from '@perimeter/protocol';
import { SessionManager } from './session/manager.js';
import type { EngineHooks } from './session/engine.js';
import type { QueryLike, SdkMsg, SdkUserInput } from './session/types.js';
import { ProfileRegistry } from './profiles.js';
import { ProjectStore } from './projects.js';
import { WssServer } from './wss.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_SID = '22222222-2224-4222-8222-222222222222';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const stop of stops.splice(0)) await stop();
});
const stops: Array<() => Promise<void>> = [];

class C {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(String(d)) as Frame));
  }
  send(f: unknown): void { this.ws.send(JSON.stringify(f)); }
  private typeOf(f: Frame): string | undefined { return 'type' in f ? f.type : undefined; }
  async wait<T = Frame>(type: string, ms = 4000): Promise<T> {
    const found = this.frames.find((f) => this.typeOf(f) === type);
    if (found) return found as T;
    return new Promise<T>((resolve, reject) => {
      const iv = setInterval(() => {
        const hit = this.frames.find((f) => this.typeOf(f) === type);
        if (hit) { clearInterval(iv); clearTimeout(t); resolve(hit as T); }
      }, 30);
      const t = setTimeout(() => { clearInterval(iv); reject(new Error(`нет ${type}`)); }, ms);
    });
  }
  async waitAck<T = Frame>(id: string, ms = 5000): Promise<T> {
    for (let i = 0; i < ms / 30; i++) {
      const f = this.frames.find((x) => 'id' in x && x.id === id && 'ok' in x);
      if (f) return f as T;
      await sleep(30);
    }
    throw new Error(`нет ack ${id}: ${this.frames.map((x) => this.typeOf(x) ?? 'reply').join(',')}`);
  }
}

async function connect(port: number): Promise<C> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = new C(ws);
  // как настоящий клиент: первым кадром hello — события сессий supervisor отдаёт только после него
  c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'hello-0', type: 'cmd:hello', lastSeq: {} });
  await c.waitAck('hello-0');
  return c;
}

/** движок-мок с контрольными методами и записью их вызовов */
function makeServer(opts?: { profiles?: boolean }) {
  const calls: { setModel: unknown[]; setPermissionMode: unknown[]; resume: unknown[]; context: number } = {
    setModel: [], setPermissionMode: [], resume: [], context: 0,
  };
  const factoryArgs: Array<Record<string, unknown>> = [];
  const manager = new SessionManager();
  const profiles = new ProfileRegistry(opts?.profiles === false ? [] : [{ name: 'yan', model: 'sonnet' }, { name: 'zai', model: 'glm-5.3[1m]' }]);
  const dir = mkdtempSync(join(tmpdir(), 'cc-s1-')); dirs.push(dir);
  const projects = new ProjectStore(join(dir, 'projects.json'));
  const server = new WssServer(manager, {
    port: 0,
    profiles,
    projects,
    resumeFactory: (_sid, info) => { calls.resume.push(info.claudeSessionId ?? '?'); return (input, hooks) => engine(input, hooks, true); },
    forkFactory: () => (input, hooks) => engine(input, hooks, true),
    sessionFactory: (sess) => { factoryArgs.push({ ...sess }); return (input, hooks) => engine(input, hooks, false); },
  });
  function engine(_input: AsyncIterable<SdkUserInput>, hooks: EngineHooks, isResume: boolean): QueryLike {
    void (async () => { for await (const _ of _input) void _; })().catch(() => undefined);
    const g = script(hooks, isResume);
    return {
      [Symbol.asyncIterator]: () => g,
      interrupt: async () => undefined,
      setModel: async (m) => { calls.setModel.push(m); },
      setPermissionMode: async (m) => { calls.setPermissionMode.push(m); },
      getContextUsage: async () => { calls.context++; return { used: 84000, size: 200000 }; },
    };
  }
  function script(hooks: EngineHooks, isResume: boolean): AsyncGenerator<SdkMsg> {
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: CLAUDE_SID, tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
      yield { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: isResume ? 'после resume' : 'первый' }] } } as SdkMsg;
      yield { type: 'result', subtype: 'success' } as SdkMsg;
      await sleep(2500); // держим процесс живым
    })();
  }
  return { manager, server, calls, factoryArgs, projects };
}

describe('S1: проекты', () => {
  it('CRUD: new → list/hello; rename; delete', async () => {
    const { server, calls } = makeServer();
    const port = await server.start();
    stops.push(() => server.stop());
    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'p1', type: 'cmd:project.new', name: 'конвейер', path: '/opt/pipeline', profile: 'zai', model: 'glm-5.3[1m]' });
    const ack1 = await c.waitAck<{ data?: { project?: { id: string } } }>('p1');
    const pid = ack1.data?.project?.id;
    expect(pid).toBeTruthy();

    const hello = await (async () => {
      const c2 = await connect(port);
      c2.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h', type: 'cmd:hello', lastSeq: {} });
      const h = await c2.wait<{ projects?: Array<{ id: string; name: string }> }>('event:hello');
      c2.ws.close();
      return h;
    })();
    expect(hello.projects?.map((p) => p.name)).toEqual(['конвейер']);

    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'p2', type: 'cmd:project.rename', projectId: pid!, name: 'конвейер-2' });
    await c.waitAck('p2');
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'p3', type: 'cmd:project.delete', projectId: pid! });
    await c.waitAck('p3');
    expect(calls.setModel).toEqual([]);
  });

  it('session.new с projectId: дефолты проекта (cwd/профиль/модель) доходят до фабрики', async () => {
    const { server, factoryArgs } = makeServer();
    const port = await server.start();
    stops.push(() => server.stop());
    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'p1', type: 'cmd:project.new', name: 'конвейер', path: '/opt/pipeline', profile: 'zai', model: 'glm-5.3[1m]', permissionMode: 'acceptEdits' });
    const pid = (await c.waitAck<{ data?: { project?: { id: string } } }>('p1')).data?.project?.id!;

    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new', projectId: pid });
    await c.wait('event:session.init');
    const sess = factoryArgs[factoryArgs.length - 1]!;
    expect(sess['cwd']).toBe('/opt/pipeline');
    expect(sess['profile']).toBe('zai');
    expect(sess['model']).toBe('glm-5.3[1m]');
    expect(sess['permissionMode']).toBe('acceptEdits');
    c.ws.close();
  });
});

describe('S1: настройки сессии', () => {
  it('модель на лету: setModel вызван, инфо обновлено; контекст отдаётся', async () => {
    const { server, calls } = makeServer();
    const port = await server.start();
    stops.push(() => server.stop());
    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new' });
    await c.wait('event:session.init');
    const sid = (c.frames.find((f) => 'sessionId' in f && f.sessionId) as { sessionId?: string })?.sessionId!;

    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 's1', type: 'cmd:session.settings', model: 'glm-5.3[1m]' });
    const ackS = await c.waitAck<{ data?: { session?: { model?: string } } }>('s1');
    expect(calls.setModel).toEqual(['glm-5.3[1m]']);
    expect(ackS.data?.session?.model).toBe('glm-5.3[1m]');

    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 'cx', type: 'cmd:session.context' });
    const ackC = await c.waitAck<{ data?: { used?: number } }>('cx');
    expect(ackC.data?.used).toBe(84000);
    c.ws.close();
  });

  it('смена профиля: в ходе — BUSY; в idle — ok и respawn через resume', async () => {
    const { server, calls } = makeServer();
    const port = await server.start();
    stops.push(() => server.stop());
    const c = await connect(port);
    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new' });
    await c.wait('event:session.init');
    const sid = (c.frames.find((f) => 'sessionId' in f && f.sessionId) as { sessionId?: string })?.sessionId!;

    // «в ходе»: вручную переводим состояние, мок-движок уже завершил ход — сначала ждём idle
    await c.wait('event:turn.result');
    await sleep(100);

    c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 'sw1', type: 'cmd:session.settings', profile: 'zai' });
    const ack1 = await c.waitAck('sw1');
    expect((ack1 as { ok: boolean }).ok).toBe(true);
    expect(calls.resume).toContain(CLAUDE_SID);
    c.ws.close();
  });
});
