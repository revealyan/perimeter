// Панели через сокет: fs/git/порты (ack/err-коды), терминал (адресность потока, attach, отписка при обрыве,
// мимо ринг-буфера сессии), гашение терминалов при остановке сессии и supervisor'а.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EventSchema, PROTOCOL_VERSION } from '@perimeter/protocol';
import { SessionManager, type SessionCreateOptions } from './session/manager.js';
import type { SdkMsg, SdkUserInput } from './session/types.js';
import { TerminalManager } from './panels/terminal.js';
import { WssServer } from './wss.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 15_000, what = 'условие'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`не дождались: ${what}`);
    await sleep(25);
  }
}

type AnyFrame = Record<string, unknown> & { type?: string; id?: string; ok?: boolean; code?: string; data?: unknown; termId?: string };

class Client {
  frames: AnyFrame[] = [];
  private n = 0;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(String(d)) as AnyFrame));
  }
  send(f: Record<string, unknown>): void { this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...f })); }
  /** Команда → её ack/err. */
  async req(f: Record<string, unknown>, ms = 15_000): Promise<AnyFrame> {
    const id = `r${++this.n}`;
    this.send({ id, ...f });
    await until(() => this.frames.some((x) => x.id === id && x.ok !== undefined), ms, `ответ на ${String(f.type)}`);
    return this.frames.find((x) => x.id === id && x.ok !== undefined)!;
  }
  term(type: 'event:term.output' | 'event:term.exit', termId?: string): AnyFrame[] {
    return this.frames.filter((f) => f.type === type && (!termId || f.termId === termId));
  }
  out(termId?: string): string { return this.term('event:term.output', termId).map((f) => String(f.data)).join(''); }
  close(): void { this.ws.close(); }
}

async function connect(port: number, hello = true, lastSeq: Record<string, number> = {}): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const c = new Client(ws);
  if (hello) await c.req({ type: 'cmd:hello', lastSeq });
  return c;
}

/** Движок-заглушка: init и тишина до close (сессии нужны панелям только ради cwd). */
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

const HI_LINE = /(^|\n)hi\r?\n/;

const tmps: string[] = [];
const running: Array<() => Promise<void>> = [];
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cc-wssp-'));
  tmps.push(root);
  process.env.GIT_CEILING_DIRECTORIES = dirname(root); // временная папка — точно не git
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'a.txt'), 'A');
  writeFileSync(join(root, 'sub', 'b.txt'), 'содержимое b');
  const manager = new SessionManager();
  const terminals = new TerminalManager({ backend: 'pipe' });
  const server = new WssServer(manager, {
    port: 0,
    sessionFactory: () => idleFactory(),
    terminals,
    ports: async () => [{ port: 5173, host: '::1', process: 'node' }],
  });
  const port = await server.start();
  running.push(() => server.stop());
  const sid = manager.create({ name: 'панели', cwd: root, factory: idleFactory() });
  const noCwd = manager.create({ name: 'без папки', factory: idleFactory() });
  return { root, manager, terminals, server, port, sid, noCwd };
}

/** Дождаться стартового приглашения шелла (вывод есть и 200 мс тишины). */
async function prompt(c: Client, termId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let last = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const n = c.term('event:term.output', termId).length;
    if (n !== last) { last = n; quietSince = Date.now(); }
    if (n > 0 && Date.now() - quietSince >= 200) return;
    await sleep(25);
  }
}

describe('панели через WSS', () => {
  it('fs/git/порты: ack с данными; OUTSIDE_ROOT, NO_CWD, SESSION_NOT_FOUND — err с кодом', async () => {
    const { port, sid, noCwd, root } = await setup();
    const c = await connect(port);

    const list = await c.req({ type: 'cmd:fs.list', sessionId: sid, path: '' });
    expect(list.ok).toBe(true);
    const ld = list.data as { root: string; path: string; entries: Array<{ name: string; kind: string }>; truncated: boolean };
    expect(ld.root).toBe(root);
    expect(ld.entries.map((e) => `${e.kind}:${e.name}`)).toEqual(['dir:sub', 'file:a.txt']);

    // path по умолчанию '' (схема протокола)
    const listDefault = await c.req({ type: 'cmd:fs.list', sessionId: sid });
    expect((listDefault.data as { entries: unknown[] }).entries).toHaveLength(2);

    const read = await c.req({ type: 'cmd:fs.read', sessionId: sid, path: 'sub/b.txt' });
    expect(read.data).toMatchObject({ path: 'sub/b.txt', binary: false, truncated: false, content: 'содержимое b' });

    expect(await c.req({ type: 'cmd:fs.read', sessionId: sid, path: '../a.txt' })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOT' });
    expect(await c.req({ type: 'cmd:fs.list', sessionId: sid, path: root })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOT' });
    expect(await c.req({ type: 'cmd:fs.read', sessionId: sid, path: 'нет.txt' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await c.req({ type: 'cmd:fs.list', sessionId: noCwd })).toMatchObject({ ok: false, code: 'NO_CWD' });
    expect(await c.req({ type: 'cmd:fs.list', sessionId: randomUUID() })).toMatchObject({ ok: false, code: 'SESSION_NOT_FOUND' });
    expect(await c.req({ type: 'cmd:fs.list' })).toMatchObject({ ok: false, code: 'SESSION_NOT_FOUND' });

    const git = await c.req({ type: 'cmd:git.status', sessionId: sid });
    expect(git).toMatchObject({ ok: true, data: { branch: null, files: [] } });

    const ports = await c.req({ type: 'cmd:net.ports' });
    expect(ports).toMatchObject({ ok: true, data: { ports: [{ port: 5173, host: '::1', process: 'node' }] } });

    expect(await c.req({ type: 'cmd:term.list', sessionId: randomUUID() })).toMatchObject({ ok: false, code: 'SESSION_NOT_FOUND' });
    expect(await c.req({ type: 'cmd:term.input', sessionId: sid, termId: 'нет', data: 'x' })).toMatchObject({ ok: false, code: 'TERM_NOT_FOUND' });
    c.close();
  });

  it('терминал: поток только подписанным, attach со scrollback, обрыв — отписка (терминал жив), мимо ринга', async () => {
    const { port, sid, terminals } = await setup();
    const c1 = await connect(port);
    const c2 = await connect(port);

    const open = await c1.req({ type: 'cmd:term.open', sessionId: sid, cols: 80, rows: 24, cwd: 'sub' });
    expect(open).toMatchObject({ ok: true, data: { mode: 'pipe', cwd: 'sub' } });
    const termId = (open.data as { termId: string }).termId;
    await prompt(c1, termId);
    expect(await c1.req({ type: 'cmd:term.input', sessionId: sid, termId, data: 'echo hi\r' })).toMatchObject({ ok: true });
    await until(() => HI_LINE.test(c1.out(termId)), 20_000, 'hi у c1');
    await sleep(100);
    expect(c2.term('event:term.output')).toEqual([]); // не подписан — ничего

    const listed = await c2.req({ type: 'cmd:term.list', sessionId: sid });
    expect(listed.data).toEqual({ terms: [expect.objectContaining({ termId, mode: 'pipe', alive: true, cwd: 'sub' })] });

    const att = await c2.req({ type: 'cmd:term.attach', sessionId: sid, termId });
    expect(att.ok).toBe(true);
    expect((att.data as { scrollback: string }).scrollback).toMatch(HI_LINE);

    await c1.req({ type: 'cmd:term.input', sessionId: sid, termId, data: 'echo bye\r' });
    await until(() => /(^|\n)bye\r?\n/.test(c2.out(termId)) && /(^|\n)bye\r?\n/.test(c1.out(termId)), 20_000, 'bye у обоих');

    // формы кадров: схема событий, seq 0, без sessionId
    for (const f of [...c1.term('event:term.output'), ...c2.term('event:term.output')]) {
      EventSchema.parse(f);
      expect(f.seq).toBe(0);
      expect(f.sessionId).toBeUndefined();
    }

    // обрыв c1: терминал живёт, c2 по-прежнему получает поток
    c1.close();
    await sleep(150);
    expect(terminals.size).toBe(1);
    await c2.req({ type: 'cmd:term.resize', sessionId: sid, termId, cols: 100, rows: 30 });
    await c2.req({ type: 'cmd:term.input', sessionId: sid, termId, data: 'echo again\r' });
    await until(() => /(^|\n)again\r?\n/.test(c2.out(termId)), 20_000, 'again у c2');

    // переподключение с догоном: из ринга сессии приходят только её события — терминальных там нет
    const c3 = await connect(port, true, { [sid]: 0 });
    await sleep(150);
    expect(c3.frames.some((f) => typeof f.type === 'string' && f.type.startsWith('event:term.'))).toBe(false);
    expect(c3.frames.some((f) => f.type === 'event:session.state')).toBe(true);

    expect(await c2.req({ type: 'cmd:term.close', sessionId: sid, termId })).toMatchObject({ ok: true });
    await until(() => c2.term('event:term.exit', termId).length === 1, 10_000, 'exit у c2');
    EventSchema.parse(c2.term('event:term.exit', termId)[0]);
    expect(c3.term('event:term.exit')).toEqual([]);
    const after = await c2.req({ type: 'cmd:term.list', sessionId: sid });
    expect(after.data).toEqual({ terms: [] });
    c2.close();
    c3.close();
  }, 60_000);

  it('остановка сессии гасит её терминалы; остановка supervisor\'а — все', async () => {
    const { port, sid, terminals, server } = await setup();
    const c = await connect(port);
    const t1 = await c.req({ type: 'cmd:term.open', sessionId: sid, cols: 80, rows: 24 });
    const termId = (t1.data as { termId: string }).termId;
    expect(await c.req({ type: 'cmd:session.stop', sessionId: sid })).toMatchObject({ ok: true });
    await until(() => c.term('event:term.exit', termId).length === 1, 10_000, 'exit после session.stop');
    expect((await c.req({ type: 'cmd:term.list', sessionId: sid })).data).toEqual({ terms: [] });

    // остановленная сессия — всё ещё сессия: терминал открыть можно; stop supervisor'а его гасит
    await c.req({ type: 'cmd:term.open', sessionId: sid, cols: 80, rows: 24 });
    expect(terminals.size).toBe(1);
    await server.stop();
    expect(terminals.size).toBe(0);
  }, 40_000);
});
