// Сквозные сабагенты по аккаунтам: проверки делегирования, ожидание воркера, read-only обёртка.
import { describe, expect, it, vi } from 'vitest';
import { SessionManager, type SpawnInfo } from './session/manager.js';
import type { EngineHooks } from './session/engine.js';
import type { SdkMsg, SdkUserInput } from './session/types.js';
import { ProfileRegistry } from './profiles.js';
import { isWriteTool, wrapReadonly } from './session/sdk.js';
import {
  delegateRun, delegateValidate, makeWorktree, waitChildResult, worktreeChanges, DELEGATE_TOOL, type DelegateDeps,
} from './delegate.js';
import type { GitRunner } from './storage.js';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Фабрика-мок: возвращает QueryLike (генератор сценария + interrupt). */
function queryLike(script: (hooks: EngineHooks) => AsyncGenerator<SdkMsg>) {
  return (_input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => {
    const g = script(hooks);
    return {
      [Symbol.asyncIterator]: () => g,
      interrupt: async () => undefined,
      close: async () => { /* генератор доедет сам */ },
    };
  };
}

/** git-фейк: по умолчанию «не репозиторий» (иначе тест создал бы настоящий worktree в живом репо). */
const noGit: GitRunner = async (args) => ({ code: 1, stdout: '', stderr: String(args[0]), timedOut: false });

/** Реестр: yan может делегировать, zai — воркер. Фабрика-шпион пишет, с чем её звали. */
function setup(script: (hooks: EngineHooks) => AsyncGenerator<SdkMsg> = async function* () {}, git: GitRunner = noGit) {
  const manager = new SessionManager();
  const profiles = new ProfileRegistry([
    { name: 'yan', delegate: true },
    { name: 'zai', displayName: 'z.ai · GLM', model: 'glm-5.3[1m]' },
  ]);
  const factoryCalls: Array<{ sess: SpawnInfo & { parentSessionId?: string; editable?: boolean }; id: string }> = [];
  const deps: DelegateDeps = {
    manager,
    profiles,
    factoryFor: (sess, id) => {
      factoryCalls.push({ sess: { ...sess }, id });
      return queryLike(script);
    },
    resumeFactory: () => queryLike(script),
    git,
  };
  return { manager, profiles, deps, factoryCalls };
}

/** Сценарий воркера: init → текст → result (успешный ход). Каждый вызов — свежий генератор
 *  (один общий на модуль делился бы между родителем и воркером). */
function workerScript(hooks: EngineHooks): AsyncGenerator<SdkMsg> {
  void hooks;
  return (async function* () {
    yield { type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [], model: 'glm-5.3[1m]', permissionMode: 'default' } as SdkMsg;
    await sleep(40);
    yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Обзор готов: три панели, всё живое.' }] } } as SdkMsg;
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 2, duration_ms: 40 } as SdkMsg;
    await sleep(2000);
  })();
}

describe('delegateValidate', () => {
  it('нет родителя / глубина / тумблер / неизвестный аккаунт', async () => {
    const { manager, profiles, deps } = setup();
    const parentId = manager.create({ name: 'родитель', cwd: process.cwd(), profile: 'yan', factory: queryLike(workerScript) });

    expect(delegateValidate(deps, 'нет-uuid', 'zai')).toEqual({ ok: false, error: expect.stringContaining('DELEGATE_NO_CALLER') });

    // воркер не делегирует дальше (глубина 1)
    const child = manager.create({ name: 'воркер', cwd: process.cwd(), profile: 'zai', parentSessionId: parentId, agentOf: DELEGATE_TOOL, factory: queryLike(workerScript) });
    expect(delegateValidate(deps, child, 'zai').ok).toBe(false);

    // тумблер выключен у аккаунта без записи delegate
    const off = manager.create({ name: 'клод', cwd: process.cwd(), profile: 'zai', factory: queryLike(workerScript) });
    const v = delegateValidate(deps, off, 'zai');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('DELEGATE_DISABLED');

    // базовый аккаунт валиден как цель
    expect(delegateValidate(deps, parentId, profiles.baseName() ?? 'default').ok).toBe(true);
    // модель могла написать displayName — понимаем и его, и начало имени
    const v2 = delegateValidate(deps, parentId, 'z.ai · GLM');
    expect(v2.ok).toBe(true);
    if (v2.ok) expect(v2.account).toBe('zai');
    expect(delegateValidate(deps, parentId, 'za').ok).toBe(true);
    const bad = delegateValidate(deps, parentId, 'nope');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('UNKNOWN_PROFILE');
  });
});

describe('delegateRun (асинхронный: родитель не блокируется)', () => {
  /** git-фейк живого репо: worktree add проходит, в копии есть правки. */
  const repoGit: GitRunner = async (args) => {
    const a = args.join(' ');
    if (a === 'rev-parse --is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '', timedOut: false };
    if (a === 'rev-parse --show-toplevel') return { code: 0, stdout: '/repo\n', stderr: '', timedOut: false };
    if (a.startsWith('rev-parse --git-path')) return { code: 0, stdout: '/repo/.git/info/exclude\n', stderr: '', timedOut: false };
    if (a.startsWith('worktree add')) return { code: 0, stdout: '', stderr: '', timedOut: false };
    if (a === 'status --porcelain=v1') return { code: 0, stdout: ' M a.ts\n?? b.ts\n', stderr: '', timedOut: false };
    if (a === 'diff --shortstat') return { code: 0, stdout: ' 1 file changed, 2 insertions(+), 1 deletion(-)\n', stderr: '', timedOut: false };
    if (a === 'diff --cached --shortstat') return { code: 0, stdout: '', stderr: '', timedOut: false };
    return { code: 1, stdout: '', stderr: `нет команды: ${a}`, timedOut: false };
  };

  it('инструмент отвечает сразу («запущен»); итог воркера приходит родителю сообщением', async () => {
    const parentInputs: string[] = [];
    const capture = (input: AsyncIterable<SdkUserInput>) => {
      void (async () => {
        for await (const m of input) {
          const c = m.message.content;
          parentInputs.push(typeof c === 'string' ? c : JSON.stringify(c));
        }
      })().catch(() => undefined);
    };
    const { manager, deps, factoryCalls } = setup(workerScript, repoGit);
    const parentId = manager.create({
      name: 'главная', cwd: '/repo/app', profile: 'yan', projectId: 'p1',
      factory: (input, hooks) => { capture(input); return queryLike(workerScript)(input, hooks); },
    });

    const res = await delegateRun(deps, parentId, { account: 'zai', prompt: 'почини тесты', name: 'ремонт' });
    // инструмент вернулся мгновенно — ход родителя не ждёт воркера
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain('запущен');
    expect(res.content[0]!.text).toContain('Не жди');

    // воркер создан правильно: worktree, editable, acceptEdits, проект наследуется
    const child = factoryCalls.at(-1)!;
    expect(child.sess.cwd?.replaceAll(String.fromCharCode(92), '/')).toMatch(/\/repo\/\.perimeter\/wt\/[0-9a-f]{8}$/);
    expect(child.sess.editable).toBe(true);
    expect(child.sess.permissionMode).toBe('acceptEdits');
    const info = manager.get(child.id);
    expect(info?.parentSessionId).toBe(parentId);
    expect(info?.agentOf).toBe(DELEGATE_TOOL);
    expect(info?.projectId).toBe('p1');
    expect(info?.name).toBe('ремонт');

    // сценарий воркера (~40 мс) закончился → родителю приехало сообщение с итогом и сводкой правок
    for (let i = 0; i < 40 && parentInputs.length === 0; i++) await sleep(50);
    expect(parentInputs[0]).toContain('воркер «ремонт» · zai');
    expect(parentInputs[0]).toContain('Обзор готов');
    expect(parentInputs[0]).toContain('git merge perimeter/w-');
  });

  it('вне git: воркер read-only в общей папке (editable нет, default)', async () => {
    const { manager, deps, factoryCalls } = setup(workerScript); // noGit
    const parentId = manager.create({ name: 'главная', cwd: 'C:\\docs', profile: 'yan', factory: queryLike(workerScript) });
    const res = await delegateRun(deps, parentId, { account: 'zai', prompt: 'обзор' });
    expect(res.content[0]!.text).toContain('запущен');
    const child = factoryCalls.at(-1)!;
    expect(child.sess.cwd).toBe('C:\\docs');
    expect(child.sess.editable).toBeUndefined();
    expect(child.sess.permissionMode).toBe('default');
  });
});

describe('waitChildResult', () => {
  it('dead воркера до хода — неудача с причиной', async () => {
    const { manager } = setup();
    const parentId = manager.create({ name: 'род', cwd: process.cwd(), profile: 'yan', factory: queryLike(async function* () {}) });
    const childId = manager.create({ name: 'воркер', cwd: process.cwd(), profile: 'zai', parentSessionId: parentId, factory: queryLike(async function* () {}) });
    const wait = waitChildResult(manager, childId, { timeoutMs: 2000 });
    await sleep(50);
    await manager.stop(childId); // событие dead приходит уже под подпиской
    const out = await wait;
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.reason).toContain('остановлен');
  });
});

describe('worktree воркера', () => {
  /** git-фейк живого репо: worktree add проходит, в копии есть правки. */
  const repoGit: GitRunner = async (args) => {
    const a = args.join(' ');
    if (a === 'rev-parse --is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '', timedOut: false };
    if (a === 'rev-parse --show-toplevel') return { code: 0, stdout: '/repo\n', stderr: '', timedOut: false };
    if (a.startsWith('rev-parse --git-path')) return { code: 0, stdout: '/repo/.git/info/exclude\n', stderr: '', timedOut: false };
    if (a.startsWith('worktree add')) return { code: 0, stdout: '', stderr: '', timedOut: false };
    if (a === 'status --porcelain=v1') return { code: 0, stdout: ' M a.ts\n?? b.ts\n', stderr: '', timedOut: false };
    if (a === 'diff --shortstat') return { code: 0, stdout: ' 1 file changed, 2 insertions(+), 1 deletion(-)\n', stderr: '', timedOut: false };
    if (a === 'diff --cached --shortstat') return { code: 0, stdout: '', stderr: '', timedOut: false };
    return { code: 1, stdout: '', stderr: `нет команды: ${a}`, timedOut: false };
  };

  it('makeWorktree: копия на ветке perimeter/w-*; не-git — null; занятый путь — переиспользование', async () => {
    const wt = await makeWorktree(repoGit, '/repo/sub', '4265f11d-e860-47ad-9b54-306e22e68390');
    expect(wt).toEqual({ path: join('/repo', '.perimeter', 'wt', '4265f11d'), branch: 'perimeter/w-4265f11d' });
    expect(await makeWorktree(noGit, '/tmp', 'x'.repeat(40))).toBeNull();
    const busy: GitRunner = async (args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '', timedOut: false };
      if (a === 'rev-parse --show-toplevel') return { code: 0, stdout: '/repo\n', stderr: '', timedOut: false };
      if (a.startsWith('worktree add')) return { code: 128, stdout: '', stderr: 'already exists', timedOut: false };
      return { code: 1, stdout: '', stderr: '', timedOut: false };
    };
    // add занят, но worktree существует → переиспользуем
    const re = await makeWorktree(busy, '/repo', '11111111-2222-4333-8444-555555555555');
    expect(re).toEqual({ path: join('/repo', '.perimeter', 'wt', '11111111'), branch: 'perimeter/w-11111111' });
  });

  it('worktreeChanges: сводка правок словами; чистая копия — null', async () => {
    const text = await worktreeChanges(repoGit, { path: '/repo/.perimeter/wt/x', branch: 'perimeter/w-x' });
    expect(text).toContain('2 файла');
    expect(text).toContain('perimeter/w-x');
    expect(text).toContain('git merge perimeter/w-x');
    const clean: GitRunner = async (args) => (args.join(' ') === 'status --porcelain=v1' ? { code: 0, stdout: '', stderr: '', timedOut: false } : { code: 1, stdout: '', stderr: '', timedOut: false });
    expect(await worktreeChanges(clean, { path: '/x', branch: 'b' })).toBeNull();
  });


});

describe('wrapReadonly (read-only воркер)', () => {
  it('write-семейство — отказ с причиной, inner не зовётся; остальное проходит', async () => {
    const inner = vi.fn(async () => ({ behavior: 'allow' as const }));
    const wrapped = wrapReadonly(inner);
    for (const t of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) {
      const r = await wrapped(t, { file_path: '/a' });
      expect(r.behavior).toBe('deny');
      expect(r.message).toContain('read-only');
    }
    expect(inner).not.toHaveBeenCalled();
    expect(isWriteTool('Bash')).toBe(false);
    const ok = await wrapped('Bash', { command: 'ls' });
    expect(ok.behavior).toBe('allow');
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
