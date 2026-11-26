// Пробуждение заранее (cmd:session.wake): остывшая сессия поднимается без хода и сама становится «готова»
// (initializationResult — init CLI без ввода не шлёт); живых процессов не больше maxLive — сверх лимита гасится
// давно не тронутая простаивающая, занятые не трогаем; разбуженная без хода гаснет по короткому простою.
import { describe, expect, it } from 'vitest';
import { SessionManager, type LiveLimits, type SavedSession } from './session/manager.js';
import type { QueryLike, SdkMsg, SdkUserInput } from './session/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Процесс как у CLI в стриминговом режиме: initialize отвечен через readyMs, без ввода ничего не шлёт; на каждое
 * сообщение — init (первый раз), ответ и итог хода. hold — ход не заканчивается (сессия занята).
 */
function cli(log: string[], name: string, opts: { readyMs?: number; hold?: boolean } = {}) {
  return (input: AsyncIterable<SdkUserInput>): QueryLike => {
    log.push(`start ${name}`);
    async function* run(): AsyncGenerator<SdkMsg> {
      let first = true;
      for await (const m of input) {
        log.push(`${name} ← ${String(m.message.content)}`);
        if (first) yield { type: 'system', subtype: 'init', session_id: `c-${name}`, tools: [], mcp_servers: [], model: 'm', permissionMode: 'default' } as SdkMsg;
        first = false;
        yield { type: 'assistant', message: { id: `a-${name}`, content: [{ type: 'text', text: 'ок' }] } } as SdkMsg;
        if (opts.hold) await new Promise(() => undefined);
        yield { type: 'result', subtype: 'success' } as SdkMsg;
      }
    }
    const g = run();
    return {
      [Symbol.asyncIterator]: () => g,
      interrupt: async () => undefined,
      close: async () => { log.push(`close ${name}`); await g.return(undefined); },
      initializationResult: () => sleep(opts.readyMs ?? 5).then(() => ({})),
    };
  };
}

function restored(ids: string[], limits: LiveLimits = {}, idleTimeoutMs = 0, hold: string[] = []) {
  const log: string[] = [];
  const m = new SessionManager(idleTimeoutMs, limits);
  const saved: SavedSession[] = ids.map((id) => ({ id, name: id, claudeSessionId: `c-${id}`, cwd: '/tmp', lastSeq: -1 }));
  m.restore(saved, (sid) => cli(log, sid, { hold: hold.includes(sid) }));
  return { m, log };
}

describe('пробуждение заранее', () => {
  it('остывшую: процесс с resume без хода → «готова» по initialize; сообщение идёт в тот же процесс', async () => {
    const { m, log } = restored(['a']);
    expect(m.get('a')?.state).toBe('dead');
    expect(m.wake('a')).toBe('woken');
    expect(m.get('a')?.state).toBe('initializing');
    await sleep(30);
    expect(m.get('a')?.state).toBe('idle'); // без единого хода
    expect(log).toEqual(['start a']);
    m.send('a', 'привет');
    await sleep(30);
    expect(log).toEqual(['start a', 'a ← привет']); // второй процесс не поднимали
    expect(m.get('a')?.state).toBe('idle');
  });

  it('живую — только «потрогать»: alive, процесс не перезапускается', async () => {
    const { m, log } = restored(['a']);
    m.wake('a');
    await sleep(30);
    expect(m.wake('a')).toBe('alive');
    expect(log).toEqual(['start a']);
  });

  it('лимит: сверх maxLive гасится давно не тронутая простаивающая, остальные живы', async () => {
    const { m, log } = restored(['a', 'b', 'c'], { maxLive: 2 });
    m.wake('a');
    await sleep(15);
    m.wake('b');
    await sleep(30);
    m.wake('a'); // a тронули позже b — первой гасить b
    expect(m.wake('c')).toBe('woken');
    await sleep(30);
    expect(m.get('b')?.state).toBe('dead');
    expect(m.get('a')?.state).toBe('idle');
    expect(m.get('c')?.state).toBe('idle');
    expect(log).toContain('close b');
    expect(m.liveCount()).toBe(2);
  });

  it('гасить некого (живые заняты ходом) — limit; сообщение всё равно будит (лимит для отправки мягкий)', async () => {
    const { m } = restored(['a', 'b'], { maxLive: 1 }, 0, ['a']);
    m.send('a', 'долгий ход');
    await sleep(30);
    expect(m.get('a')?.state).toBe('working');
    expect(m.wake('b')).toBe('limit');
    expect(m.get('b')?.state).toBe('dead');
    m.send('b', 'всё равно ответь');
    await sleep(30);
    expect(m.get('b')?.state).toBe('idle');
    expect(m.get('a')?.state).toBe('working'); // занятую не тронули
  });

  it('мало свободной памяти — заранее не будим', () => {
    const { m } = restored(['a'], { freeMem: () => 100, minFreeBytes: 1000 });
    expect(m.wake('a')).toBe('limit');
    expect(m.get('a')?.state).toBe('dead');
  });

  it('разбуженная без хода гаснет по короткому простою; после хода — обычный простой', async () => {
    const { m } = restored(['a', 'b'], { wakeIdleMs: 60 }, 10_000);
    m.wake('a');
    m.wake('b');
    await sleep(20);
    m.send('b', 'ход');
    await sleep(150);
    expect(m.get('a')?.state).toBe('dead');
    expect(m.get('b')?.state).toBe('idle');
    await m.stop('b');
  });
});
