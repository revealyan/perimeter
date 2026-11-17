// Кэш подключения в store: список и лента из кэша до hello, догон по seq кэша, ресинк без лавины транскриптов.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachOrphanResults, feedsToEvict, feedSignature, mergeCachedFeed, type CachedFeed } from './lib/cacheModel';

class FakeWS {
  static all: FakeWS[] = [];
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWS.all.push(this); }
  send(d: string) { this.sent.push(JSON.parse(d) as Record<string, unknown>); }
  close() { this.onclose?.(); }
  open() { this.onopen?.(); }
  recv(f: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ v: 1, ts: Date.now(), ...f }) }); }
  all(type: string) { return this.sent.filter((f) => f['type'] === type); }
}

const ls: Record<string, string> = {};
vi.stubGlobal('localStorage', { getItem: (k: string) => ls[k] ?? null, setItem: (k: string, v: string) => { ls[k] = v; }, removeItem: (k: string) => { delete ls[k]; } });
vi.stubGlobal('WebSocket', FakeWS);
vi.stubGlobal('requestAnimationFrame', () => 0);
// store проверяет только наличие IndexedDB; само хранилище подменено ниже
vi.stubGlobal('indexedDB', {});

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
type Item = { id: string; kind: string; data: Record<string, unknown> };
const feeds = new Map<string, CachedFeed<Item>>();
const saved: Array<{ sid: string; lastSeq: number; n: number }> = [];
const dropped: string[] = [];
let meta: Record<string, unknown> | null = null;

vi.mock('./cache', () => ({
  cacheStore: {
    load: async () => (meta ? { meta, heads: new Map([...feeds].map(([sid, f]) => [sid, f.lastSeq])) } : null),
    saveMeta: async (_env: string, m: Record<string, unknown>) => { meta = m; },
    loadFeed: async (_env: string, sid: string) => feeds.get(sid) ?? null,
    saveFeed: async (_env: string, sid: string, f: CachedFeed<Item>) => { feeds.set(sid, f); saved.push({ sid, lastSeq: f.lastSeq, n: f.items.length }); },
    dropFeed: async (_env: string, sid: string) => { feeds.delete(sid); dropped.push(sid); },
    dropEnv: async () => undefined,
  },
}));

const { SupervisorClient } = await import('./supervisor');
const hello = (sessions: Array<Record<string, unknown>>) => ({ type: 'event:hello', seq: 0, server: { version: 't', uptimeMs: 1 }, sessions });
const text = (sid: string, seq: number, t: string) => ({ type: 'event:message.assistant', sessionId: sid, seq, messageId: `m${seq}`, block: { type: 'text', text: t } });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  FakeWS.all = [];
  feeds.clear();
  saved.length = 0;
  dropped.length = 0;
  meta = {
    savedAt: 1, activeId: S1, profiles: [], projects: [], storage: null,
    sessions: [{ id: S1, name: 'из кэша', state: 'idle', needs: null, lastActivity: 1 }, { id: S2, name: 'вторая', state: 'idle', needs: null, lastActivity: 1 }],
  };
  feeds.set(S1, { lastSeq: 5, savedAt: 1, items: [{ id: 't0', kind: 'user', data: { text: 'привет' } }, { id: 'i5', kind: 'text', data: { text: 'старый ответ' } }] });
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('кэш подключения', () => {
  it('до hello: список и лента открытой сессии — из кэша, без сети', async () => {
    const c = new SupervisorClient('vps', 'ws://x');
    await flush();
    expect(c.fromCache).toBe(true);
    expect([...c.sessions.keys()]).toEqual([S1, S2]);
    expect(c.activeId).toBe(S1);
    await flush();
    const s = c.sessions.get(S1)!;
    expect(s.historyLoaded).toBe(true);
    expect(s.items.map((i) => i.id)).toEqual(['t0', 'i5']);
  });

  it('hello уносит seq кэша; сервер досылает только новое, транскрипт не запрашивается', async () => {
    const c = new SupervisorClient('vps', 'ws://x');
    c.connect();
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    await flush();
    expect(ws.all('cmd:hello')[0]!['lastSeq']).toEqual({ [S1]: 5 });
    ws.recv(hello([{ id: S1, name: 'из кэша', state: 'idle' }, { id: S2, name: 'вторая', state: 'idle' }]));
    ws.recv(text(S1, 6, 'новый ответ'));
    await flush();
    expect(c.fromCache).toBe(false);
    expect(ws.all('cmd:transcript.get')).toHaveLength(0);
    expect(c.sessions.get(S1)!.items.map((i) => i.id)).toEqual(['t0', 'i5', 'i6']);
  });

  it('догон пришёл раньше, чем прочиталась лента из кэша, — склейка без дублей', () => {
    const merged = mergeCachedFeed({ lastSeq: 5, savedAt: 1, items: [{ id: 'i4' }, { id: 'i5' }] }, [{ id: 'i5' }, { id: 'i6' }, { id: 'u1' }]);
    expect(merged.map((i) => i.id)).toEqual(['i4', 'i5', 'i6', 'u1']);
  });

  it('кэш отстал от буфера (RESYNC_NEEDED): лента забывается, транскрипт — только у открытой', async () => {
    feeds.set(S2, { lastSeq: 3, savedAt: 1, items: [{ id: 'i3', kind: 'text', data: {} }] });
    const c = new SupervisorClient('vps', 'ws://x');
    c.connect();
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    await flush();
    ws.recv(hello([{ id: S1, name: 'a', state: 'idle' }, { id: S2, name: 'b', state: 'idle' }]));
    ws.recv({ type: 'event:error', sessionId: S2, seq: 0, code: 'RESYNC_NEEDED', message: 'x' });
    await flush();
    expect(dropped).toContain(S2);
    expect(ws.all('cmd:transcript.get')).toHaveLength(0); // S2 не открыта — транскрипт подождёт
    expect(c.sessions.get(S2)!.historyLoaded).toBe(false);
    c.select(S2);
    expect(ws.all('cmd:transcript.get').map((f) => f['sessionId'])).toEqual([S2]);
  });

  it('ленты нет в кэше, а seq ушёл в hello — открытие тянет полный транскрипт', async () => {
    const c = new SupervisorClient('vps', 'ws://x');
    feeds.delete(S1); // голова прочиталась, ленту вытеснили между чтениями
    c.connect();
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    await flush();
    ws.recv(hello([{ id: S1, name: 'a', state: 'idle' }]));
    await flush();
    expect(ws.all('cmd:transcript.get').map((f) => f['sessionId'])).toEqual([S1]);
  });

  it('сохраняет полные ленты с их seq; неизменную ленту второй раз не пишет', async () => {
    meta = null;
    feeds.clear();
    const c = new SupervisorClient('vps', 'ws://x');
    c.connect();
    const ws = FakeWS.all.at(-1)!;
    ws.open();
    await flush();
    ws.recv(hello([{ id: S1, name: 'a', state: 'idle' }]));
    const get = ws.all('cmd:transcript.get')[0]!;
    ws.recv({ id: get['id'], ok: true, data: { items: [{ kind: 'user', data: { text: 'x' } }], lastSeq: 9 } });
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved).toEqual([{ sid: S1, lastSeq: 9, n: 1 }]);
    expect((meta as { sessions: unknown[] } | null)?.sessions).toHaveLength(1);
    c.showError('перерисовка'); // notify без изменений ленты
    await vi.advanceTimersByTimeAsync(2500);
    expect(saved).toHaveLength(1);
  });
});

describe('кэш: чистые функции', () => {
  it('подпись ленты меняется от длины, последнего элемента и seq', () => {
    expect(feedSignature([{ id: 'a' }], 1)).not.toBe(feedSignature([{ id: 'a' }], 2));
    expect(feedSignature([{ id: 'a' }], 1)).toBe(feedSignature([{ id: 'a' }], 1));
  });
  it('результат инструмента из догона приклеивается к вызову из кэша', () => {
    const items = [
      { id: 'i1', kind: 'tool-use', data: { id: 'tu1', name: 'Bash', done: false } as Record<string, unknown> },
      { id: 'i2', kind: 'tool-result', data: { toolUseId: 'tu1', result: 'ok', isError: false } as Record<string, unknown> },
      { id: 'i3', kind: 'tool-result', data: { toolUseId: 'нет-такого', result: 'x' } as Record<string, unknown> },
    ];
    const out = attachOrphanResults(items);
    expect(out.map((i) => i.id)).toEqual(['i1', 'i3']);
    expect(out[0]!.data).toMatchObject({ result: 'ok', done: true, isError: false });
  });
  it('лишние ленты — сначала самые старые', () => {
    const heads = [{ sid: 'a', savedAt: 3 }, { sid: 'b', savedAt: 1 }, { sid: 'c', savedAt: 2 }];
    expect(feedsToEvict(heads, 2)).toEqual(['b']);
    expect(feedsToEvict(heads, 5)).toEqual([]);
  });
});
