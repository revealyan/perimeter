// Пул тёплых процессов (prewarm/SpareProcess): дозаправка, отказ prewarm, остановка,
// canUseTool/флаги стрима на prewarm, закрытие забранного процесса, дефолты claim.
// Живой claude не нужен: prewarm подменяется фейком.

import { describe, expect, it } from 'vitest';
import type { Options, SpareProcess } from '@anthropic-ai/claude-agent-sdk/core';
import { PrewarmPool, ProfilePools, poolProfiles } from './pool.js';
import type { EngineHooks } from './session/engine.js';
import type { SdkUserInput } from './session/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeSpare {
  spare: SpareProcess;
  claims: Array<{ options: Record<string, unknown> }>;
  closed: () => number;
  queryClosed: () => number;
}

function fakeSpare(): FakeSpare {
  let exit!: () => void;
  const exited = new Promise<void>((r) => { exit = r; });
  const claims: Array<{ options: Record<string, unknown> }> = [];
  let closed = 0;
  let queryClosed = 0;
  const query = {
    next: async () => new Promise<never>(() => undefined), // поток «живого» процесса
    [Symbol.asyncIterator]() { return this; },
    close: () => { queryClosed++; exit(); },
    interrupt: async () => undefined,
  };
  const spare = {
    claimed: new Promise(() => undefined),
    exited,
    claim: (p: { options: Record<string, unknown> }) => { claims.push(p); return query; },
    close: () => { closed++; exit(); },
    [Symbol.asyncDispose]: async () => undefined,
  } as unknown as SpareProcess;
  return { spare, claims, closed: () => closed, queryClosed: () => queryClosed };
}

function fakePrewarm() {
  const made: FakeSpare[] = [];
  const options: Options[] = [];
  const fn = async (p: { options: Options }) => {
    options.push(p.options);
    const f = fakeSpare();
    made.push(f);
    return f.spare;
  };
  return { fn, made, options };
}

const noInput: AsyncIterable<SdkUserInput> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) };
const denyHooks: EngineHooks = { canUseTool: async () => ({ behavior: 'deny', message: 'нет' }) };

describe('PrewarmPool', () => {
  it('take() отдаёт тёплый слот и сразу дозаправляет пул до целевого размера', async () => {
    const pw = fakePrewarm();
    const pool = new PrewarmPool(1, {}, { prewarmFn: pw.fn });
    await pool.fill();
    expect(pool.warm).toBe(1);
    expect(pool.take({ cwd: '/x' })).not.toBeNull();
    await sleep(10);
    expect(pool.warm).toBe(1); // раньше: 0 до смерти забранного процесса
    expect(pw.made).toHaveLength(2);
    pool.stop();
  });

  it('prewarm недоступен → fill() выходит, а не крутит спавн в цикле', async () => {
    let calls = 0;
    const pool = new PrewarmPool(1, {}, {
      prewarmFn: async () => {
        calls++;
        if (calls > 3) return new Promise<never>(() => undefined); // предохранитель для старого кода
        throw new Error('CLI слишком старый для --await-claim');
      },
    });
    await Promise.race([pool.fill(), sleep(100)]);
    expect(calls).toBe(1);
    expect(pool.warm).toBe(0);
  });

  it('stop(): закрытые при остановке спэры не перегреваются заново', async () => {
    const pw = fakePrewarm();
    const pool = new PrewarmPool(2, {}, { prewarmFn: pw.fn });
    await pool.fill();
    expect(pw.made).toHaveLength(2);
    pool.stop();
    await sleep(10);
    expect(pw.made).toHaveLength(2);
    expect(pw.made.every((f) => f.closed() === 1)).toBe(true);
  });

  it('prewarm с флагами стрима и canUseTool; canUseTool спэра ведёт в движок забравшей сессии', async () => {
    const pw = fakePrewarm();
    const pool = new PrewarmPool(1, {}, { prewarmFn: pw.fn });
    await pool.fill();
    const opts = pw.options[0]!;
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.forwardSubagentText).toBe(true);
    expect(typeof opts.canUseTool).toBe('function');

    const asked: string[] = [];
    const hooks: EngineHooks = {
      canUseTool: async (name, _input, o) => { asked.push(`${name}:${o?.signal ? 'signal' : 'нет'}`); return { behavior: 'allow' }; },
    };
    const factory = pool.take({ cwd: '/x' })!;
    factory(noInput, hooks);
    const r = await opts.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1' } as never);
    expect(asked).toEqual(['Bash:signal']);
    expect(r?.behavior).toBe('allow');
    pool.stop();
  });

  it('close() забранной сессии закрывает процесс (idle-reaping/stop не оставляют сирот)', async () => {
    const pw = fakePrewarm();
    const pool = new PrewarmPool(1, {}, { prewarmFn: pw.fn });
    await pool.fill();
    const q = pool.take({ cwd: '/x' })!(noInput, denyHooks);
    void q[Symbol.asyncIterator]().next(); // первый next() = claim
    await sleep(5);
    expect(pw.made[0]!.claims).toHaveLength(1);
    expect(q.close).toBeTypeOf('function');
    await q.close!();
    expect(pw.made[0]!.queryClosed()).toBe(1);
    pool.stop();
  });

  it('дефолты supervisor\'а (модель/режим/cwd) применяются к claim, если сессия их не задала', async () => {
    const pw = fakePrewarm();
    const pool = new PrewarmPool(1, {}, { prewarmFn: pw.fn, defaults: { model: 'glm-5.3[1m]', permissionMode: 'acceptEdits', cwd: '/srv' } });
    await pool.fill();
    const q = pool.take({})!(noInput, denyHooks);
    void q[Symbol.asyncIterator]().next();
    await sleep(5);
    expect(pw.made[0]!.claims[0]!.options).toEqual({ cwd: '/srv', model: 'glm-5.3[1m]', permissionMode: 'acceptEdits' });
    pool.stop();
  });
});

describe('пул по аккаунтам (ProfilePools)', () => {
  it('у профиля свой тёплый процесс с env профиля; сессия берёт слот своего профиля', async () => {
    const pw = fakePrewarm();
    const pools = new ProfilePools((profile) => new PrewarmPool(1, profile === undefined ? {} : { env: { WHO: profile } }, { prewarmFn: pw.fn }), [undefined, 'yan', 'zai']);
    pools.fill();
    await sleep(20);
    expect(pools.warm).toBe(3);
    expect(pools.target).toBe(3);
    expect(pw.options.map((o) => (o.env as Record<string, string> | undefined)?.['WHO'] ?? 'default').sort()).toEqual(['default', 'yan', 'zai']);
    // сессия zai получает тёплый процесс, прогретый с env zai
    const f = pools.take({ cwd: '/w' }, 'zai');
    expect(f).not.toBeNull();
    const q = f!(noInput, denyHooks);
    void q[Symbol.asyncIterator]().next();
    await sleep(10);
    const zai = pw.made.find((_, i) => (pw.options[i]!.env as Record<string, string> | undefined)?.['WHO'] === 'zai')!;
    expect(zai.claims).toHaveLength(1);
    // профиля без пула — холодный путь
    expect(pools.take({}, 'нет-такого')).toBeNull();
    pools.stop();
  });

  it('голый PrewarmPool (только аккаунт supervisor-а) профильной сессии слот не отдаёт', async () => {
    const pw = fakePrewarm();
    const pool = new PrewarmPool(1, {}, { prewarmFn: pw.fn });
    await pool.fill();
    expect(pool.take({}, 'yan')).toBeNull();
    expect(pool.warm).toBe(1);
    expect(pool.take({})).not.toBeNull();
    pool.stop();
  });

  it('reset — слот профиля пересоздаётся (новый ключ из UI), старый процесс гасится', async () => {
    const pw = fakePrewarm();
    let gen = 0;
    const pools = new ProfilePools((profile) => new PrewarmPool(1, { env: { GEN: String(++gen), WHO: profile ?? 'default' } }, { prewarmFn: pw.fn }), ['zai']);
    pools.fill();
    await sleep(20);
    const first = pw.made[0]!;
    pools.reset('zai');
    await sleep(20);
    expect(first.closed()).toBe(1);
    expect(pw.made).toHaveLength(2);
    expect((pw.options[1]!.env as Record<string, string>)['GEN']).toBe('2');
    expect(pools.warm).toBe(1);
    pools.stop();
  });

  it('какие профили греть: all, список, default; неизвестные пропускаются', () => {
    expect(poolProfiles(undefined, ['yan', 'zai'], 1)).toEqual([undefined]);
    expect(poolProfiles(undefined, ['yan'], 0)).toEqual([]);
    expect(poolProfiles('all', ['yan', 'zai'], 1)).toEqual([undefined, 'yan', 'zai']);
    expect(poolProfiles('zai, нет', ['yan', 'zai'], 0)).toEqual(['zai']);
    expect(poolProfiles('default,yan', ['yan'], 0)).toEqual([undefined, 'yan']);
  });
});
