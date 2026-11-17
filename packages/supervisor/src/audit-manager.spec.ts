// Аудит менеджера/движка: гонки жизненного цикла, дыры seq, переходы §4, pending-разрешения,
// маппинг полей настоящего SDK. Каждый тест — воспроизведение конкретного дефекта.

import { describe, expect, it } from 'vitest';
import type { Event } from '@perimeter/protocol';
import { SessionManager } from './session/manager.js';
import type { EngineHooks } from './session/engine.js';
import type { QueryLike, SdkMsg, SdkUserInput } from './session/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_SID = '33333333-3334-4333-8333-333333333333';

const initMsg = (): SdkMsg => ({
  type: 'system', subtype: 'init', session_id: CLAUDE_SID,
  tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto',
});
const assistant = (id: string, text: string): SdkMsg =>
  ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } }) as SdkMsg;
const result = (): SdkMsg => ({ type: 'result', subtype: 'success' }) as SdkMsg;

/** Мок-фабрика: сценарий получает хуки движка; вход пишется в received. */
function mock(script: (hooks: EngineHooks) => AsyncGenerator<SdkMsg>, received: string[] = []) {
  return (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks): QueryLike => {
    void (async () => {
      for await (const x of input) received.push(typeof x.message.content === 'string' ? x.message.content : '[blocks]');
    })().catch(() => undefined);
    const g = script(hooks);
    return { [Symbol.asyncIterator]: () => g, interrupt: async () => undefined, close: async () => undefined };
  };
}

const statesOf = (events: Event[], sid: string): string[] =>
  events.filter((e) => e.sessionId === sid && e.type === 'event:session.state').map((e) => (e as { state: string }).state);

describe('аудит: жизненный цикл движка', () => {
  it('смена профиля в idle: хвост старого движка (ENGINE_EXIT) не роняет возрождённую сессию в dead', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    let resumed = 0;
    const id = m.create({
      // первый процесс: живёт, пока его не закроют; close() завершает поток (как у настоящего SDK)
      factory: () => {
        let release!: () => void;
        const closed = new Promise<void>((r) => { release = r; });
        const g = (async function* () { yield initMsg(); yield result(); await closed; })();
        return { [Symbol.asyncIterator]: () => g, interrupt: async () => undefined, close: async () => { release(); } };
      },
      resumeFactory: () => { resumed++; return mock(async function* () { yield initMsg(); await sleep(400); }); },
    });
    await sleep(30);
    expect(m.get(id)?.state).toBe('idle');

    expect(m.switchProfile(id, 'zai')).toBe('ok');
    await sleep(60);
    expect(resumed).toBe(1);
    // новый процесс жив — сессия не должна числиться мёртвой (иначе следующий send плодит третий процесс)
    expect(m.get(id)?.state).not.toBe('dead');
    // осознанная остановка старого процесса — не ошибка для UI
    expect(events.filter((e) => e.type === 'event:error').map((e) => (e as { code: string }).code)).toEqual([]);
  });

  it('stop(): осознанная остановка не шлёт event:error ENGINE_EXIT/ENGINE_CRASH', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      factory: () => {
        let release!: () => void;
        const closed = new Promise<void>((r) => { release = r; });
        const g = (async function* () { yield initMsg(); await closed; throw new Error('AbortError: процесс закрыт'); })();
        return { [Symbol.asyncIterator]: () => g, interrupt: async () => undefined, close: async () => { release(); } };
      },
    });
    await sleep(30);
    await m.stop(id);
    await sleep(30);
    expect(m.get(id)?.state).toBe('dead');
    expect(events.filter((e) => e.type === 'event:error')).toEqual([]);
  });
});

describe('аудит: seq без дыр (инвариант 1)', () => {
  it('кадр, не прошедший схему, не оставляет дыру в seq', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      factory: mock(async function* () {
        // mcp-сервер без status — кадр session.init не пройдёт схему
        yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'x' }], model: 'm', permissionMode: 'auto' } as unknown as SdkMsg;
        yield assistant('m1', 'дальше');
        await sleep(200);
      }),
    });
    await sleep(40);
    const mine = events.filter((e) => e.sessionId === id);
    expect(mine.some((e) => e.type === 'event:error' && e.code === 'FRAME_SCHEMA')).toBe(true);
    const seqs = mine.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });
});

describe('аудит: переходы состояний §4', () => {
  it('send до system/init (ленивый старт SDK): init не сбрасывает идущий ход в idle', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      factory: mock(async function* () {
        yield initMsg();
        await sleep(80); // модель думает, событий ещё нет
        yield assistant('m1', 'ответ');
        yield result();
        await sleep(300);
      }),
    });
    m.send(id, 'ход');
    await sleep(40);
    expect(m.get(id)?.state).toBe('working');
    await sleep(100);
    // между working и концом хода idle не мигает
    expect(statesOf(events, id)).toEqual(['initializing', 'working', 'idle']);
  });

  it('send после interrupt: не бросает (сообщение уже ушло в claude) и не ломает машину состояний', async () => {
    const m = new SessionManager();
    const received: string[] = [];
    const id = m.create({
      factory: mock(async function* () { yield initMsg(); await sleep(400); }, received),
    });
    await sleep(20);
    m.send(id, 'долгий ход');
    await m.interrupt(id);
    expect(m.get(id)?.state).toBe('interrupted');
    expect(() => m.send(id, 'вдогонку')).not.toThrow();
    await sleep(20);
    expect(received).toContain('вдогонку');
    expect(m.get(id)?.state).toBe('interrupted');
  });

  it('interrupt на стыке с концом хода (сессия уже idle) — не ошибка и не запрещённый переход', async () => {
    const m = new SessionManager();
    const id = m.create({ factory: mock(async function* () { yield initMsg(); await sleep(300); }) });
    await sleep(30);
    expect(m.get(id)?.state).toBe('idle');
    await expect(m.interrupt(id)).resolves.toBeUndefined();
    expect(m.get(id)?.state).toBe('idle');
  });

  it('send во время карточки разрешения: состояние остаётся waiting_permission с needs', async () => {
    const m = new SessionManager();
    const id = m.create({
      factory: mock(async function* (hooks) {
        yield initMsg();
        void hooks.canUseTool('Bash', { command: 'rm -rf dist' });
        await sleep(400);
      }),
    });
    await sleep(30);
    expect(m.get(id)?.state).toBe('waiting_permission');
    m.send(id, 'уточнение, пока карточка висит');
    expect(m.get(id)?.state).toBe('waiting_permission');
    expect(m.get(id)?.needs).toBe('разрешение: Bash');
  });
});

describe('аудит: pending-разрешения', () => {
  it('две карточки: ответ на первую оставляет waiting_permission и needs второй', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      factory: mock(async function* (hooks) {
        yield initMsg();
        void hooks.canUseTool('Bash', { command: 'a' });
        void hooks.canUseTool('Write', { file_path: 'b' });
        await sleep(400);
      }),
    });
    await sleep(30);
    const reqs = events.filter((e): e is Extract<Event, { type: 'event:permission.request' }> => e.type === 'event:permission.request');
    expect(reqs).toHaveLength(2);
    expect(m.respondPermission(id, reqs[0]!.requestId, 'allow')).toBe(true);
    expect(m.get(id)?.state).toBe('waiting_permission');
    expect(m.get(id)?.needs).toBe('разрешение: Write');
    expect(m.respondPermission(id, reqs[1]!.requestId, 'deny')).toBe(true);
    expect(m.get(id)?.state).toBe('working');
  });

  it('ответ на карточку после конца хода не залипает в working', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      factory: mock(async function* (hooks) {
        yield initMsg();
        void hooks.canUseTool('Bash', { command: 'x' }); // CLI ушёл дальше, не дождавшись (старый CLI без отмены)
        yield result();
        await sleep(400);
      }),
    });
    await sleep(30);
    expect(m.get(id)?.state).toBe('idle');
    const req = events.find((e): e is Extract<Event, { type: 'event:permission.request' }> => e.type === 'event:permission.request')!;
    m.respondPermission(id, req.requestId, 'allow');
    expect(m.get(id)?.state).toBe('idle');
  });

  it('ответ на карточку после interrupt не бросает (раньше: interrupted → working запрещён)', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      factory: mock(async function* (hooks) {
        yield initMsg();
        void hooks.canUseTool('Bash', { command: 'x' });
        await sleep(400);
      }),
    });
    await sleep(30);
    await m.interrupt(id);
    const req = events.find((e): e is Extract<Event, { type: 'event:permission.request' }> => e.type === 'event:permission.request')!;
    expect(() => m.respondPermission(id, req.requestId, 'allow')).not.toThrow();
    expect(m.get(id)?.state).toBe('interrupted');
  });

  it('отмена canUseTool со стороны SDK (signal.abort при interrupt) гасит карточку', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const ac = new AbortController();
    let decided: string | null = null;
    const id = m.create({
      factory: mock(async function* (hooks) {
        yield initMsg();
        void hooks.canUseTool('Bash', { command: 'x' }, { signal: ac.signal }).then((r) => { decided = r.behavior; });
        await sleep(400);
      }),
    });
    await sleep(30);
    expect(m.get(id)?.state).toBe('waiting_permission');
    ac.abort();
    await sleep(10);
    const res = events.filter((e) => e.type === 'event:permission.result');
    expect(res).toHaveLength(1);
    expect(decided).toBe('deny');
    expect(m.get(id)?.state).not.toBe('waiting_permission');
    expect(m.pendingPermissionFrames(id)).toEqual([]);
  });
});

describe('аудит: рестарт supervisor\'а', () => {
  const saved = (id: string) => [{ id, name: 'до рестарта', claudeSessionId: CLAUDE_SID, cwd: '/opt/x', lastSeq: 3 }];

  it('восстановленная сессия форкается (forkFactory не теряется при restore)', () => {
    const m = new SessionManager();
    const id = '44444444-4444-4444-8444-444444444444';
    const forked: string[] = [];
    m.restore(saved(id), () => mock(async function* () { yield initMsg(); }), (csid) => {
      forked.push(csid);
      return mock(async function* () { yield initMsg(); await sleep(100); });
    });
    const forkId = m.fork(id);
    expect(forkId).toBeTruthy();
    expect(forked).toEqual([CLAUDE_SID]);
  });

  it('форк сессии проекта остаётся в проекте (projectId наследуется вместе с cwd/профилем)', async () => {
    const m = new SessionManager();
    const id = m.create({
      cwd: '/opt/pipeline', profile: 'zai', projectId: 'p-1',
      factory: mock(async function* () { yield initMsg(); await sleep(200); }),
      forkFactory: () => mock(async function* () { yield initMsg(); await sleep(100); }),
    });
    await sleep(30);
    const forkId = m.fork(id)!;
    expect(m.get(forkId)?.projectId).toBe('p-1');
  });

  it('смена модели у мёртвой (скошенной/восстановленной) сессии: запоминается и применяется при respawn', async () => {
    const m = new SessionManager();
    let persisted = 0;
    m.setPersistHook(() => { persisted++; });
    const id = '55555555-5555-4555-8555-555555555555';
    const resumedWith: Array<string | undefined> = [];
    m.restore(saved(id), (_sid, info) => {
      resumedWith.push(info.model);
      return mock(async function* () { yield initMsg(); await sleep(200); });
    });
    expect(await m.setModel(id, 'opus')).toBe(true);
    expect(await m.setPermissionMode(id, 'plan')).toBe(true);
    expect(m.get(id)?.model).toBe('opus');
    expect(m.get(id)?.permissionMode).toBe('plan');
    expect(persisted).toBeGreaterThan(0);
    m.send(id, 'поехали');
    await sleep(20);
    expect(resumedWith).toEqual(['opus']);
  });
});

describe('аудит: маппинг полей настоящего SDK', () => {
  it('tool_use_result (snake_case в потоке SDK) и modelUsage (camelCase) доходят до кадров', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    m.create({
      factory: mock(async function* () {
        yield initMsg();
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] }, tool_use_result: { stdout: 'ok', exitCode: 0 }, parent_tool_use_id: null } as unknown as SdkMsg;
        yield {
          type: 'result', subtype: 'success',
          usage: { input_tokens: 10, output_tokens: 5 },
          modelUsage: { 'claude-x': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
        } as unknown as SdkMsg;
        await sleep(200);
      }),
    });
    await sleep(40);
    const user = events.find((e) => e.type === 'event:message.user') as { result?: unknown } | undefined;
    expect(user?.result).toEqual({ stdout: 'ok', exitCode: 0 });
    const turn = events.find((e) => e.type === 'event:turn.result') as { modelUsage?: Record<string, { inputTokens: number; costUsd?: number }> } | undefined;
    expect(turn?.modelUsage?.['claude-x']).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  });

  it('сообщение SDK непредвиденной формы не убивает сессию (раньше: TypeError → ENGINE_CRASH → dead)', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      factory: mock(async function* () {
        yield initMsg();
        yield { type: 'assistant' } as unknown as SdkMsg; // без message — новая версия CLI/SDK
        yield assistant('m2', 'живём дальше');
        await sleep(200);
      }),
    });
    await sleep(40);
    expect(m.get(id)?.state).not.toBe('dead');
    const texts = events.filter((e) => e.type === 'event:message.assistant').map((e) => (e as { block: { text?: string } }).block.text);
    expect(texts).toEqual(['живём дальше']);
    expect(events.some((e) => e.type === 'event:error' && e.code === 'MAP_FAILED')).toBe(true);
  });

  it('stream_event субагента (parent_tool_use_id) не льётся в основной stream.delta', async () => {
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    m.create({
      factory: mock(async function* () {
        yield initMsg();
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'субагент печатает' } }, parent_tool_use_id: 'task1' } as SdkMsg;
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'главный' } }, parent_tool_use_id: null } as SdkMsg;
        await sleep(200);
      }),
    });
    await sleep(40);
    const deltas = events.filter((e) => e.type === 'event:stream.delta').map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(['главный']);
  });
});
