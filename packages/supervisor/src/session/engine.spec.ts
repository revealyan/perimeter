// Инвариант АДР 002: мок SDK-событий → обёртка выдаёт наш протокол.
// Плюс: поток разрешений (карточка → ответ), субагенты, метрики, seq.
import { describe, expect, it } from 'vitest';
import type { Event } from '@perimeter/protocol';
import { SessionManager } from './manager.js';
import type { EngineHooks } from './engine.js';
import type { QueryLike, SdkMsg, SdkUserInput } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fake {
  received: SdkUserInput[];
  resolved: string[]; // behavior разрешений, увиденных фейком
  interrupted: number;
}

// Фабрика-мок: перехватывает вход (send) и хуки движка (canUseTool),
// а сценарий — генератор SDK-сообщений, как их отдаёт реальный query().
function managerWith(script: (hooks: EngineHooks, fake: Fake) => AsyncGenerator<SdkMsg>) {
  const fake: Fake = { received: [], resolved: [], interrupted: 0 };
  const events: Event[] = [];
  const m = new SessionManager();
  m.subscribe((e) => events.push(e));
  const factory = (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks): QueryLike => {
    void (async () => { for await (const x of input) fake.received.push(x); })().catch(() => undefined);
    return {
      [Symbol.asyncIterator]: () => script(hooks, fake),
      interrupt: async () => { fake.interrupted++; },
    };
  };
  return { m, events, fake, factory };
}

describe('engine+manager: маппинг SDK → протокол', () => {
  it('реплика человека — по контракту SDKUserMessage (parent_tool_use_id: null): иначе Claude Code не подмешивает её в идущий ход', async () => {
    const { m, fake, factory } = managerWith(async function* () {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default' };
      await sleep(300);
    });
    const id = m.create({ factory });
    await sleep(30);
    m.send(id, 'два');
    await sleep(30);
    expect(fake.received.at(-1)).toMatchObject({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'два' } });
    await m.stop(id);
  });

  it('пустая картинка (data URL без данных) не уходит в Claude Code; есть данные — блок image, пусто всё — просто текст', async () => {
    const { m, fake, factory } = managerWith(async function* () {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default' };
      await sleep(300);
    });
    const id = m.create({ factory });
    await sleep(30);
    m.send(id, 'смотри', ['data:image/png;base64,', 'data:image/png;base64,iVBORw0KGgo=']);
    m.send(id, 'только пустая', ['data:image/png;base64,']);
    await sleep(30);
    const [a, b] = fake.received.slice(-2);
    expect(a!.message.content).toEqual([{ type: 'text', text: 'смотри' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]);
    expect(b!.message.content).toBe('только пустая');
    await m.stop(id);
  });

  it('thinking: текст с подписью уходит в журнал (транскрипт его не хранит); пустой — добирается из дельт потока', async () => {
    const { m, events, factory } = managerWith(async function* () {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'claude-opus-5-5', permissionMode: 'default' };
      yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'полный текст', signature: 'SIG-1' }] } };
      // текста в итоговом блоке нет — только дельты потока
      yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'из ' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'дельт' } } };
      yield { type: 'assistant', message: { id: 'm2', content: [{ type: 'thinking', thinking: '', signature: 'SIG-2' }] } };
      // пусто и без дельт (скрытое размышление) — в журнал не пишем
      yield { type: 'assistant', message: { id: 'm3', content: [{ type: 'thinking', thinking: '', signature: 'SIG-3' }] } };
      await sleep(200);
    });
    const saved: Array<[string, string]> = [];
    m.thinkingSink = (sig, text) => saved.push([sig, text]);
    const id = m.create({ factory });
    await sleep(80);
    expect(saved).toEqual([['SIG-1', 'полный текст'], ['SIG-2', 'из дельт']]);
    const th = events.filter((e) => e.type === 'event:message.assistant') as Array<Extract<Event, { type: 'event:message.assistant' }>>;
    expect(th.map((e) => (e.block.type === 'thinking' ? e.block.thinking : null))).toEqual(['полный текст', 'из дельт', '']);
    await m.stop(id);
  });

  it('system/api_retry → event:api.retry: попытка, лимит, пауза, статус и категория ошибки', async () => {
    const { m, events, factory } = managerWith(async function* () {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'glm-5.3[1m]', permissionMode: 'auto' };
      yield { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 8200, error_status: 429, error: 'rate_limit' };
      yield { type: 'system', subtype: 'api_retry', attempt: 4, max_retries: 10, retry_delay_ms: 16000, error_status: null, error: 'unknown' };
      await sleep(200);
    });
    const id = m.create({ factory });
    await sleep(80);
    const r = events.filter((e) => e.type === 'event:api.retry') as Array<Extract<Event, { type: 'event:api.retry' }>>;
    expect(r.map((e) => [e.attempt, e.maxRetries, e.delayMs, e.status, e.error])).toEqual([[3, 10, 8200, 429, 'rate_limit'], [4, 10, 16000, null, 'unknown']]);
    expect(r.every((e) => e.sessionId === id && e.seq > 0)).toBe(true);
    await m.stop(id);
  });

  it('init → session.init, ассистент текстом, result с метриками; seq монотонный', async () => {
    const { m, events, factory } = managerWith(async function* () {
      yield { type: 'system', subtype: 'init', tools: ['Bash', 'Read'], mcp_servers: [{ name: 'serena', status: 'pending' }], model: 'glm-5.3[1m]', permissionMode: 'auto', skills: ['rolik'] };
      yield { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'привет' }] } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'при' } } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] }, toolUseResult: { exitCode: 0 } };
      yield { type: 'result', subtype: 'success', result: 'готово', total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 }, model_usage: { 'glm-5.3[1m]': { input_tokens: 10, output_tokens: 5 } }, num_turns: 1, duration_ms: 900 };
      await sleep(300); // держим генератор живым: реальный query() в стриминговом режиме не заканчивается
    });
    const id = m.create({ factory });
    await sleep(80);

    const types = events.map((e) => e.type);
    expect(types).toContain('event:session.init');
    expect(types).toContain('event:message.assistant');
    expect(types).toContain('event:stream.delta');
    expect(types).toContain('event:message.user');
    const turn = events.find((e) => e.type === 'event:turn.result');
    expect(turn && turn.type === 'event:turn.result' && turn.totalCostUsd).toBe(0.02);

    // состояния выведены: initializing→idle (по init), затем idle (по result)
    const states = events.filter((e) => e.type === 'event:session.state').map((e) => (e as { state: string }).state);
    expect(states[0]).toBe('initializing');
    expect(states.at(-1)).toBe('idle');

    // seq монотонный без дыр (инвариант 1)
    const seqs = events.filter((e) => 'seq' in e).map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));

    expect(m.get(id)?.state).toBe('idle');
  });

  it('разрешение: карточка → respond(allow+updatedInput) → движок получил allow, состояние вернулось в working', async () => {
    const { m, events, fake, factory } = managerWith(async function* (hooks, fk) {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' };
      const decision = hooks.canUseTool('Bash', { command: 'git push' });
      yield { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'жду' }] } };
      fk.resolved.push((await decision).behavior);
      yield { type: 'result', subtype: 'success' };
      await sleep(300);
    });
    m.create({ factory });
    await sleep(30);

    const req = events.find((e) => e.type === 'event:permission.request');
    expect(req?.type).toBe('event:permission.request');
    const states = events.filter((e) => e.type === 'event:session.state').map((e) => (e as { state: string }).state);
    expect(states).toContain('waiting_permission');

    const requestId = req && req.type === 'event:permission.request' ? req.requestId : '';
    const sid = req?.sessionId ?? '';
    const ok = m.respondPermission(sid, requestId, 'allow', { command: 'git push --force-with-lease' });
    expect(ok).toBe(true);
    await sleep(50);

    expect(fake.resolved).toEqual(['allow']);
    const resTypes = events.filter((e) => e.type === 'event:permission.result');
    expect(resTypes.length).toBe(1);
    expect(m.get(sid)?.state).toBe('idle'); // после result → idle
  });

  it('таймаут карточки: deny по таймеру, behavior=timeout в протокол', async () => {
    const { m, events, factory } = managerWith(async function* (hooks) {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' };
      const d = hooks.canUseTool('Bash', { command: 'x' });
      yield { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: '.' }] } };
      await d;
      yield { type: 'result', subtype: 'success' };
      await sleep(300);
    });
    m.create({ factory, permissionTimeoutMs: 30 });
    await sleep(120);
    const res = events.find((e) => e.type === 'event:permission.result');
    expect(res && res.type === 'event:permission.result' && res.behavior).toBe('timeout');
  });

  it('субагент: start → message → stop по tool_result родителя', async () => {
    const { m, events, factory } = managerWith(async function* () {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' };
      yield { type: 'assistant', message: { id: 'msg', content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: {} }] } };
      yield { type: 'assistant', message: { id: 'msg_s', content: [{ type: 'text', text: 'субагент ищет' }] }, parent_tool_use_id: 'task1' };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'task1' }] } };
      yield { type: 'result', subtype: 'success' };
    });
    m.create({ factory });
    await sleep(60);
    const sub = events.filter((e) => e.type.startsWith('event:subagent.')).map((e) => e.type);
    expect(sub).toEqual(['event:subagent.start', 'event:subagent.message', 'event:subagent.stop']);
  });

  it('send() доходит в стриминговый вход, interrupt вызван', async () => {
    const { m, fake, factory } = managerWith(async function* () {
      yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' };
      yield { type: 'result', subtype: 'success' };
      await sleep(200); // держим процесс живым
    });
    const id = m.create({ factory });
    await sleep(30);
    m.send(id, 'погнали');
    await m.interrupt(id);
    await sleep(30);
    expect(fake.received.map((x) => x.message.content)).toContain('погнали');
    expect(fake.interrupted).toBe(1);
  });
});
