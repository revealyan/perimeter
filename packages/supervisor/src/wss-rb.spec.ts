// Удалённый браузер и сжатие через сокет: кадры только подписанному сокету и без сжатия,
// отписка при обрыве, attach с другого сокета; permessage-deflate для обычных ответов и его отключение.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EventSchema, PROTOCOL_VERSION } from '@perimeter/protocol';
import { SessionManager, type SessionCreateOptions } from './session/manager.js';
import type { SdkMsg, SdkUserInput } from './session/types.js';
import { fakeCdp } from './panels/fake-cdp.js';
import { RemoteBrowserManager } from './panels/rbrowser.js';
import { WssServer } from './wss.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000, what = 'условие'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await sleep(15);
  }
}

type AnyFrame = Record<string, unknown> & { type?: string; id?: string; ok?: boolean; code?: string; data?: unknown; rbId?: string };

class Client {
  frames: AnyFrame[] = [];
  private n = 0;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(String(d)) as AnyFrame));
  }
  /** Сколько байт пришло по TCP (после сжатия). */
  get wire(): number { return (this.ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead; }
  async req(f: Record<string, unknown>, ms = 5000): Promise<AnyFrame> {
    const id = `r${++this.n}`;
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), id, ...f }));
    await until(() => this.frames.some((x) => x.id === id && x.ok !== undefined), ms, `ответ на ${String(f['type'])}`);
    return this.frames.find((x) => x.id === id && x.ok !== undefined)!;
  }
  rb(type: string): AnyFrame[] { return this.frames.filter((f) => f.type === type); }
}

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); // клиент ws по умолчанию предлагает permessage-deflate
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const c = new Client(ws);
  await c.req({ type: 'cmd:hello', lastSeq: {} });
  return c;
}

/** Движок-заглушка: init и тишина до close (сессия нужна только ради cwd). */
function idleFactory(): SessionCreateOptions['factory'] {
  return (input: AsyncIterable<SdkUserInput>) => {
    void (async () => { for await (const _ of input) void _; })().catch(() => undefined);
    let stop: () => void = () => undefined;
    const done = new Promise<void>((r) => { stop = r; });
    async function* g(): AsyncGenerator<SdkMsg> {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default' } as SdkMsg;
      await done;
    }
    const it = g();
    return { [Symbol.asyncIterator]: () => it, interrupt: async () => undefined, close: async () => { stop(); } };
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
// обратный порядок: сперва сервер (гасит менеджер и CDP), потом фейковый CDP
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function setup(compress?: boolean) {
  const cdp = await fakeCdp();
  cleanups.push(cdp.close);
  const manager = new SessionManager();
  const rbrowser = new RemoteBrowserManager({ launcher: cdp.launcher, idleMs: 0 });
  const server = new WssServer(manager, { port: 0, sessionFactory: () => idleFactory(), rbrowser, ...(compress !== undefined ? { compress } : {}) });
  const port = await server.start();
  cleanups.push(() => server.stop());
  return { cdp, manager, rbrowser, server, port };
}

describe('удалённый браузер через WSS', () => {
  it('кадры — только подписанному сокету, по схеме, seq 0; attach с другого сокета — последний кадр; обрыв — отписка', async () => {
    const { cdp, port, rbrowser } = await setup();
    const a = await connect(port);
    const b = await connect(port);
    const open = await a.req({ type: 'cmd:rb.open', url: 'example.com', width: 800, height: 600 });
    expect(open).toMatchObject({ ok: true });
    const rbId = (open.data as { rbId: string }).rbId;
    const sid = cdp.calls.find((c) => c.method === 'Page.startScreencast')!.sessionId!;

    cdp.frame(sid, 1);
    await until(() => a.rb('event:rb.frame').length === 1, 3000, 'кадр у A');
    await until(() => a.rb('event:rb.state').length > 0, 3000, 'state у A');
    await sleep(50);
    expect(b.rb('event:rb.frame')).toHaveLength(0); // B не подписан
    for (const f of [...a.rb('event:rb.frame'), ...a.rb('event:rb.state')]) {
      expect(EventSchema.safeParse(f).success).toBe(true);
      expect(f['seq']).toBe(0);
    }

    expect((await b.req({ type: 'cmd:rb.list' })).data).toMatchObject({ browsers: [{ rbId, width: 800, height: 600 }] });
    expect(await b.req({ type: 'cmd:rb.attach', rbId })).toMatchObject({ ok: true });
    await until(() => b.rb('event:rb.frame').length === 1, 3000, 'последний кадр у B');

    expect(await b.req({ type: 'cmd:rb.input', rbId, input: { kind: 'text', text: 'привет' } })).toMatchObject({ ok: true });
    expect(cdp.calls.find((c) => c.method === 'Input.insertText')!.params['text']).toBe('привет');
    expect(await b.req({ type: 'cmd:rb.resize', rbId, width: 1024, height: 700 })).toMatchObject({ ok: true });
    expect(await b.req({ type: 'cmd:rb.navigate', rbId, url: 'javascript:alert(1)' })).toMatchObject({ ok: false, code: 'RB_BAD_URL' });

    // A ушёл — кадры только B; вкладка жива, пока B смотрит
    a.ws.close();
    await sleep(100);
    cdp.frame(sid, 2);
    await until(() => b.rb('event:rb.frame').length === 2, 3000, 'второй кадр у B');
    expect(rbrowser.list()).toHaveLength(1);

    expect(await b.req({ type: 'cmd:rb.close', rbId })).toMatchObject({ ok: true });
    expect(b.rb('event:rb.exit')).toHaveLength(1);
    expect(await b.req({ type: 'cmd:rb.attach', rbId })).toMatchObject({ ok: false, code: 'RB_NOT_FOUND' });
    b.ws.close();
  });

  it('кадр уходит без сжатия даже при включённом deflate', async () => {
    const { cdp, port } = await setup();
    const a = await connect(port);
    expect(a.ws.extensions).toContain('permessage-deflate');
    await a.req({ type: 'cmd:rb.open', width: 800, height: 600 });
    const sid = cdp.calls.find((c) => c.method === 'Page.startScreencast')!.sessionId!;
    const big = 'A'.repeat(200_000); // жмётся в сотни раз — если бы сжимали, было бы видно
    const before = a.wire;
    cdp.frame(sid, 1, big);
    await until(() => a.rb('event:rb.frame').length === 1, 3000, 'большой кадр');
    expect(a.wire - before).toBeGreaterThan(big.length);
    a.ws.close();
  });
});

describe('сжатие permessage-deflate', () => {
  function bigFile(): string {
    const root = mkdtempSync(join(tmpdir(), 'cc-deflate-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'big.log'), 'строка лога: всё хорошо, повторяем много раз\n'.repeat(4000)); // ~300 КБ
    return root;
  }

  it('по умолчанию: расширение согласовано, большой ответ на проводе в разы меньше', async () => {
    const { manager, port } = await setup();
    const sid = manager.create({ name: 'жмём', cwd: bigFile(), factory: idleFactory() });
    const c = await connect(port);
    expect(c.ws.extensions).toContain('permessage-deflate');
    const before = c.wire;
    const r = await c.req({ type: 'cmd:fs.read', sessionId: sid, path: 'big.log' });
    expect(r.ok).toBe(true);
    const json = Buffer.byteLength(JSON.stringify(r));
    const wire = c.wire - before;
    expect(json).toBeGreaterThan(200_000);
    expect(wire).toBeLessThan(json / 10);
    c.ws.close();
  });

  it('compress:false — расширения нет, байты как есть', async () => {
    const { manager, port } = await setup(false);
    const sid = manager.create({ name: 'не жмём', cwd: bigFile(), factory: idleFactory() });
    const c = await connect(port);
    expect(c.ws.extensions).toBe('');
    const before = c.wire;
    const r = await c.req({ type: 'cmd:fs.read', sessionId: sid, path: 'big.log' });
    expect(c.wire - before).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(r)) - 64);
    c.ws.close();
  });
});
