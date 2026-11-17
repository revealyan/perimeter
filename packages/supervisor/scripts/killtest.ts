// T7 kill-тест: живой e2e инвариантов 2 и 3 (docs/p0-design.md §5).
// Сценарий: ход → kill -9 supervisor → рестарт → hello с lastSeq → RESYNC →
// transcript.get → лента восстановлена → второе сообщение = respawn через --resume.
// Запуск: npm run killtest   (два маленьких хода claude, ~$0.05)

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Frame } from '@perimeter/protocol';

const PORT = Number(process.env.KILLTEST_PORT ?? 8791);
const REPO = join(import.meta.dirname, '..', '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'cc-kill-'));
const stateFile = join(dir, 'state.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startSupervisor(): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'packages/supervisor/src/main.ts'], {
    cwd: REPO,
    env: { ...process.env, PERIMETER_PORT: String(PORT), PERIMETER_STATE: stateFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitPort(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        ws.once('open', () => { ws.close(); resolve(); });
        ws.once('error', reject);
      });
      return;
    } catch { await sleep(500); }
  }
  throw new Error('supervisor не поднялся за 30 с');
}

class C {
  frames: Frame[] = [];
  private pending = new Map<string, Array<(f: Frame) => void>>();
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as Frame;
      this.frames.push(f);
      const t = 'type' in f ? f.type : undefined;
      if (!t) return;
      const list = this.pending.get(t);
      if (list?.length) { const r = list.shift()!; r(f); if (!list.length) this.pending.delete(t); }
    });
  }
  send(f: Record<string, unknown>): void { this.ws.send(JSON.stringify(f)); }
  async wait<T = Frame>(type: string, ms = 120_000): Promise<T> {
    const found = this.frames.find((f) => 'type' in f && f.type === type);
    if (found) return found as T;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`нет ${type}; есть: ${this.frames.map((f) => ('type' in f ? f.type : 'ack')).join(',')}`)), ms);
      const list = this.pending.get(type) ?? [];
      list.push((f) => { clearTimeout(timer); resolve(f as T); });
      this.pending.set(type, list);
    });
  }
  waitAck(id: string): Frame {
    const f = this.frames.find((x) => 'id' in x && x.id === id && 'ok' in x);
    if (!f) throw new Error(`нет ack ${id}`);
    return f;
  }
  get lastSeq(): number {
    return Math.max(-1, ...this.frames.filter((f) => 'seq' in f).map((f) => (f as { seq: number }).seq));
  }
}

async function connect(): Promise<C> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return new C(ws);
}

const step = (s: string) => console.log(`\n== ${s}`);

async function waitAck<T = Frame>(c: C, id: string, ms = 10_000): Promise<T> {
  for (let i = 0; i < ms / 50; i++) {
    const f = c.frames.find((x) => 'id' in x && x.id === id && 'ok' in x);
    if (f) return f as T;
    await sleep(50);
  }
  throw new Error(`нет ack ${id}`);
}

// ─── прогон ─────────────────────────────────────────────────────────────────

step('1. первый запуск supervisor + ход');
let sup = startSupervisor();
await waitPort();
let c = await connect();
c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h1', type: 'cmd:hello', lastSeq: {} });
await c.wait('event:hello');
c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n1', type: 'cmd:session.new', name: 'killtest', cwd: dir });
const ack = await waitAck<{ data?: { sessionId?: string } }>(c, 'n1');
const sid = ack?.data?.sessionId;
if (!sid) throw new Error('нет sessionId в ack');
console.log(`сессия ${sid}`);

c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 'm1', type: 'cmd:message.send', text: 'Ответь одним словом: ок' });
const turn1 = await c.wait('event:turn.result');
console.log('ход 1 завершён:', (turn1 as unknown as { subtype?: string }).subtype);
const seqBefore = c.lastSeq;
c.ws.close();

step('2. kill -9 supervisor');
sup.kill('SIGKILL');
await sleep(1500);

step('3. рестарт → свежий клиент → реестр dead → ресинк из транскрипта');
sup = startSupervisor();
await waitPort();
c = await connect();
// свежий клиент: память пуста, lastSeq по сессии не знает
c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h2', type: 'cmd:hello', lastSeq: {} });
const hello2 = await c.wait('event:hello');
const sessions = (hello2 as unknown as { sessions?: Array<{ id: string; state: string }> }).sessions ?? [];
const restored = sessions.find((s) => s.id === sid);
if (!restored) throw new Error('сессия не восстановлена в реестре');
console.log(`реестр восстановлен, состояние: ${restored.state}`);
if (restored.state !== 'dead') throw new Error(`ожидали dead, получили ${restored.state}`);

c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 't1', type: 'cmd:transcript.get' });
const tack = await waitAck<{ data?: { items?: Array<{ kind: string; data: Record<string, unknown> }> } }>(c, 't1');
const transcriptItems = tack?.data?.items;
if (!transcriptItems?.length) throw new Error('ресинк не вернул элементы ленты');
const texts = transcriptItems!.filter((i) => i.kind === 'text').map((i) => String(i.data['text']));
console.log(`ресинк: ${transcriptItems!.length} элементов, текст: ${texts.join(' / ').slice(0, 80)}`);

step('4. respawn через --resume: второе сообщение в мёртвую сессию');
c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 'm2', type: 'cmd:message.send', text: 'Ещё раз одним словом: готово' });
const turn2 = await c.wait('event:turn.result');
console.log('ход 2 завершён (respawn сработал):', (turn2 as unknown as { subtype?: string }).subtype);

const seqAfter = c.lastSeq;
if (seqAfter < seqBefore) throw new Error(`seq скатился: ${seqBefore} → ${seqAfter}`);
console.log(`seq продолжился: ${seqBefore} → ${seqAfter}`);

step('PASS: kill -9 пережит, лента восстановлена, сессия возрождена через resume');
c.ws.close();
sup.kill();
process.exit(0);
