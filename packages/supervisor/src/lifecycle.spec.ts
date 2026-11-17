// Жизненный цикл: idle-reaping (простой → dead, сообщение → resume) и форк истории.

import { describe, expect, it } from 'vitest';
import type { Event } from '@perimeter/protocol';
import { SessionManager } from './session/manager.js';
import type { EngineHooks } from './session/engine.js';
import type { QueryLike, SdkMsg, SdkUserInput } from './session/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_SID = '11111111-1114-4111-8111-111111111111';

type AssistantEvent = Extract<Event, { type: 'event:message.assistant' }>;
const textsOf = (events: Event[]): string[] =>
  events
    .filter((e): e is AssistantEvent => e.type === 'event:message.assistant')
    .map((e) => e.block)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text);

function queryLike(script: (hooks: EngineHooks) => AsyncGenerator<SdkMsg>): QueryLike {
  const g = script({ canUseTool: async () => ({ behavior: 'deny' as const, message: 'нет' }) });
  return {
    [Symbol.asyncIterator]: () => g,
    interrupt: async () => undefined,
    close: async () => undefined,
  };
}

const initMsg = (): SdkMsg => ({
  type: 'system', subtype: 'init', session_id: CLAUDE_SID,
  tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto',
});

describe('idle-reaping', () => {
  it('простой 80 мс → dead; сообщение возрождает через resumeFactory', async () => {
    const resumedWith: string[] = [];
    const m = new SessionManager(80);
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      factory: () => queryLike(async function* () {
        yield initMsg();
        yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'жил' }] } } as SdkMsg;
        yield { type: 'result', subtype: 'success' } as SdkMsg;
        await sleep(600);
      }),
      resumeFactory: (_sid, info) => {
        resumedWith.push(info.claudeSessionId ?? '');
        return () => queryLike(async function* () {
          yield initMsg();
          yield { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'возрождён' }] } } as SdkMsg;
          yield { type: 'result', subtype: 'success' } as SdkMsg;
          await sleep(300);
        });
      },
    });
    m.send(id, 'ход');
    await sleep(60);
    expect(m.get(id)?.state).toBe('idle'); // ход прошёл, сессия жива-простаивает

    await sleep(200); // таймер 80 мс должен был сработать
    expect(m.get(id)?.state).toBe('dead'); // процесс скошен, память освобождена

    m.send(id, 'ещё');
    await sleep(80);
    expect(resumedWith).toContain(CLAUDE_SID); // респаун именно через resume
    expect(m.get(id)?.state).not.toBe('dead');
    expect(textsOf(events)).toContain('возрождён');
  });

  it('idleTimeoutMs=0 — не скашивает', async () => {
    const m = new SessionManager(0);
    const id = m.create({
      factory: () => queryLike(async function* () {
        yield initMsg();
        // ход, начатый send до init, заканчивается result'ом (init сам по себе ход не завершает)
        yield { type: 'result', subtype: 'success' } as SdkMsg;
        await sleep(250);
      }),
    });
    m.send(id, 'ход');
    await sleep(150);
    expect(m.get(id)?.state).toBe('idle');
  });
});

describe('форк', () => {
  it('fork(): новая сессия с историей до момента форка, под тем же профилем', async () => {
    const forkArgs: string[] = [];
    const m = new SessionManager();
    const events: Event[] = [];
    m.subscribe((e) => events.push(e));
    const id = m.create({
      cwd: '/opt/x',
      profile: 'zai',
      factory: () => queryLike(async function* () {
        yield initMsg();
        yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'оригинал' }] } } as SdkMsg;
        await sleep(400);
      }),
      forkFactory: (claudeSessionId, info) => {
        forkArgs.push(claudeSessionId, info.profile ?? '');
        return () => queryLike(async function* () {
          yield initMsg();
          yield { type: 'assistant', message: { id: 'f1', content: [{ type: 'text', text: 'ветка форка' }] } } as SdkMsg;
          await sleep(300);
        });
      },
    });
    m.send(id, 'ход');
    await sleep(60);

    const forkId = m.fork(id);
    expect(forkId).toBeTruthy();
    expect(forkId).not.toBe(id);
    expect(forkArgs).toEqual([CLAUDE_SID, 'zai']);
    expect(m.get(forkId!)?.name).toContain('форк');
    expect(m.get(forkId!)?.cwd).toBe('/opt/x');

    m.send(forkId!, 'работаем в ветке');
    await sleep(80);
    expect(textsOf(events)).toContain('ветка форка');
    // оригинал жив своей жизнью
    expect(m.get(id)?.state).not.toBe('dead');
  });

  it('fork() до init (нет claudeSessionId) → null', () => {
    const m = new SessionManager();
    const id = m.create({
      factory: () => queryLike(async function* () { await sleep(50); }),
      forkFactory: () => () => queryLike(async function* () { await sleep(10); }),
    });
    expect(m.fork(id)).toBeNull();
  });
});
