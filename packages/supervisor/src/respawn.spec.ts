// Инвариант 2 (respawn): смерть процесса → dead → сообщение в сессию возрождает
// её через resumeFactory(sessionId); seq продолжается без сброса.
import { describe, expect, it } from 'vitest';
import type { Event } from '@perimeter/protocol';
import { SessionManager } from './session/manager.js';
import type { EngineHooks } from './session/engine.js';
import type { QueryLike, SdkMsg, SdkUserInput } from './session/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function queryLike(script: (hooks: EngineHooks) => AsyncGenerator<SdkMsg>): QueryLike {
  const g = script({ canUseTool: async () => ({ behavior: 'deny' as const, message: 'нет' }) });
  return { [Symbol.asyncIterator]: () => g, interrupt: async () => undefined };
}

describe('respawn после смерти процесса', () => {
  it('dead → send → resumeFactory(sid) → сессия жива, seq продолжается', async () => {
    const events: Event[] = [];
    const m1 = new SessionManager();
    m1.subscribe((e) => events.push(e));
    const resumeArgs: string[] = [];

    const id = m1.create({
      name: 'первая жизнь',
      cwd: '/opt/x',
      factory: () => queryLike(async function* () {
        yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
        yield { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'жил' }] } } as SdkMsg;
        // процесс умирает сразу после первого хода
      }),
      resumeFactory: (sid) => {
        resumeArgs.push(sid);
        return (input) => {
          void (async () => { for await (const _ of input) void _; })().catch(() => undefined);
          return queryLike(async function* () {
            yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
            yield { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'возрождён' }] } } as SdkMsg;
            await sleep(500);
          });
        };
      },
    });
    m1.send(id, 'первое сообщение');
    await sleep(80);
    expect(m1.get(id)?.state).toBe('dead'); // процесс завершился → dead (resumable)

    const seqBefore = m1.snapshot()[0]!.lastSeq;

    // рестарт supervisor'а: новый менеджер, реестр восстановлен из снимка
    const m2 = new SessionManager();
    const events2: Event[] = [];
    m2.subscribe((e) => events2.push(e));
    m2.restore(m1.snapshot(), (sid) => {
      resumeArgs.push(sid);
      return () => queryLike(async function* () {
        yield { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' } as SdkMsg;
        yield { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'после рестарта' }] } } as SdkMsg;
        await sleep(300);
      });
    });
    expect(m2.get(id)?.state).toBe('dead');
    expect(m2.seqLast(id)).toBe(seqBefore); // seq продолжает, не с нуля

    m2.send(id, 'второе сообщение');
    await sleep(100);
    expect(resumeArgs).toContain(id);
    expect(m2.get(id)?.state).not.toBe('dead');
    const texts = events2.map((e) => e.type === 'event:message.assistant' && e.block.type === 'text' ? e.block.text : null).filter(Boolean);
    expect(texts).toContain('после рестарта');
    // seq продолжает без сброса: новые события выше seqBefore
    const newSeqs = events2.filter((e) => e.type === 'event:message.assistant').map((e) => e.seq);
    for (const s of newSeqs) expect(s).toBeGreaterThan(seqBefore);
  });
});
