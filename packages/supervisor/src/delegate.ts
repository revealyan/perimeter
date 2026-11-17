// Сквозные сабагенты по аккаунтам (срез 1): сессия-родитель получает встроенный MCP-инструмент
// delegate_to_agent, который порождает ДОЧЕРНЮЮ СЕССИЮ на другом аккаунте (env/модель профиля)
// в том же cwd. Воркер — настоящая сессия в реестре: своя лента, свои разрешения, respawn; read-only
// (write-инструменты запрещены обёрткой в sdk.ts). Глубина 1: воркер сам инструмент не получает.
// Инструмент ждёт первый ход воркера и возвращает его финальный текст + статистику; таймаут —
// статус «задача ещё идёт» (не ошибка, чтобы родитель не ретраил); воркера не убиваем никогда.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createSdkMcpServer, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Event } from '@perimeter/protocol';
import type { SessionManager, SessionCreateOptions, SpawnInfo } from './session/manager.js';
import type { ProfileRegistry } from './profiles.js';
import { realGit, type GitRunner } from './storage.js';
import { SUPERVISOR_VERSION } from './version.js';

export const DELEGATE_SERVER = 'perimeter';
export const DELEGATE_TOOL = 'delegate_to_agent';
/** Сколько наблюдатель ждёт первый ход воркера (итог всё равно приедет родителю сообщением). */
export const DELEGATE_WAIT_MS = 30 * 60_000;
/** Фоновый предел наблюдения за воркером: дольше — сообщение «работает дольше обычного». */
export const DELEGATE_WATCH_MS = 2 * 60 * 60_000;

/** Зависимости делегирования — всё уже есть в startSupervisor; в тестах подменяется. */
export interface DelegateDeps {
  manager: SessionManager;
  profiles: ProfileRegistry;
  /** фабрика движка воркера (buildOptions + readonly, БЕЗ mcpServers) */
  factoryFor: (sess: SpawnInfo & { parentSessionId?: string; editable?: boolean }, sessionId: string) => SessionCreateOptions['factory'];
  resumeFactory: SessionCreateOptions['resumeFactory'];
  /** git для worktree-изоляции воркеров (по умолчанию настоящий; тесты подменяют) */
  git?: GitRunner;
}

/** Worktree воркера: своя копия рабочей папки на отдельной ветке — воркер может править файлы,
 *  не мешая родителю (его незакоммиченные правки в копию НЕ попадают — честная изоляция от HEAD).
 *  Не-git папка — null: воркер пойдёт read-only в общей папке. */
export interface WorktreeInfo { path: string; branch: string }

export async function makeWorktree(git: GitRunner, cwd: string, sid: string): Promise<WorktreeInfo | null> {
  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree'], { timeoutMs: 10_000, cwd });
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
    const root = (await git(['rev-parse', '--show-toplevel'], { timeoutMs: 10_000, cwd })).stdout.trim();
    if (root === '') return null;
    const short = sid.replace(/-/g, '').slice(0, 8);
    const branch = `perimeter/w-${short}`;
    const path = join(root, '.perimeter', 'wt', short);
    const add = await git(['worktree', 'add', '-b', branch, path, 'HEAD'], { timeoutMs: 60_000, cwd: root });
    if (add.code !== 0) {
      // путь/ветка заняты (respawn воркера) — переиспользуем существующий worktree
      const exists = await git(['rev-parse', '--is-inside-work-tree'], { timeoutMs: 10_000, cwd: path });
      return exists.code === 0 ? { path, branch } : null;
    }
    // служебную папку прячем от git-статуса родителя локально (.git/info/exclude — .gitignore проекта не трогаем)
    try {
      const exclude = (await git(['rev-parse', '--git-path', 'info/exclude'], { timeoutMs: 10_000, cwd: root })).stdout.trim();
      if (exclude !== '') {
        const have = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
        if (!have.split(/\r?\n/).includes('.perimeter/wt/')) appendFileSync(exclude, '\n.perimeter/wt/\n', 'utf8');
      }
    } catch { /* exclude — приятная мелочь, не повод отказываться от worktree */ }
    return { path, branch };
  } catch {
    return null; // git недоступен/ошибка — воркер пойдёт read-only, это не блокер
  }
}

/** Сводка правок воркера в его worktree (незакоммиченное): строка для tool_result или null. */
export async function worktreeChanges(git: GitRunner, wt: WorktreeInfo): Promise<string | null> {
  try {
    const st = await git(['status', '--porcelain=v1'], { timeoutMs: 10_000, cwd: wt.path });
    if (st.code !== 0 || st.stdout.trim() === '') return null;
    const files = st.stdout.trim().split('\n').length;
    const [d, staged] = await Promise.all([
      git(['diff', '--shortstat'], { timeoutMs: 10_000, cwd: wt.path }),
      git(['diff', '--cached', '--shortstat'], { timeoutMs: 10_000, cwd: wt.path }),
    ]);
    const stat = [d.stdout.trim(), staged.stdout.trim()].filter(Boolean).join('; ');
    const filesWord = files === 1 ? 'файл' : files < 5 ? 'файла' : 'файлов';
    return `Правки воркера: ${files} ${filesWord} (${stat || 'новые файлы'}) в ветке ${wt.branch} — забрать в проект: git merge ${wt.branch}`;
  } catch {
    return null;
  }
}

/** Кто вызывает инструмент: id сессии-родителя (инжектится на фабрике — модель тут не источник). */
export interface DelegateCaller {
  callerId: string;
}

/** Аргументы инструмента (модель заполняет по описанию со списком аккаунтов). */
export const delegateArgsSchema = z.object({
  account: z.string().min(1).describe('имя аккаунта-воркера (аккаунты и их модели перечислены в описании инструмента)'),
  prompt: z.string().min(1).describe('задача воркеру: самодостаточная, с контекстом и что вернуть'),
  model: z.string().min(1).optional().describe('модель аккаунта-воркера; нет — модель по умолчанию аккаунта'),
  name: z.string().min(1).max(80).optional().describe('короткое имя воркера для списка сессий'),
});
export type DelegateArgs = z.infer<typeof delegateArgsSchema>;

/** Описание инструмента со списком доступных аккаунтов — модель видит, кому можно делегировать.
 *  Слаг обязателен: его же ждёт аргумент account (модель не должна гадать между displayName и именем). */
export function toolDescription(profiles: ProfileRegistry): string {
  const list = profiles.publicList().map((p) => {
    const who = p.displayName !== undefined && p.displayName !== p.name ? `${p.displayName} — ${p.name}` : p.name;
    return p.model !== undefined ? `${who} (${p.model})` : who;
  });
  const base = `ЕДИНСТВЕННЫЙ способ субагентов здесь: запустить сабагента-воркера (обычно на другом аккаунте). воркер — отдельная сессия проекта, в git-репозитории получает свою копию-ветку (может править файлы, не мешая родителю; итог — текст и сводка правок), вне git — работает только на чтение. Используй для объёмной механики (обзоры, поиск, черновики, правки), чтобы беречь квоту текущего аккаунта. Вызов возвращается сразу: продолжай свою работу, результат придёт в эту сессию отдельным сообщением, когда воркер закончит.`;
  return list.length > 0 ? `${base}\nАккаунты (аргумент account — короткое имя): ${list.join(', ')}.` : base;
}

/** Разобрать, какой аккаунт имелся в виду: слаг, displayName или их начало (без учёта регистра) —
 *  модель может написать «z.ai · GLM» вместо `zai`; не совпало — null. */
export function matchAccount(profiles: ProfileRegistry, account: string): string | null {
  const q = account.trim().toLowerCase();
  if (q === '') return null;
  const base = profiles.baseName();
  const cands = [base, ...profiles.publicList().map((p) => p.name)].filter((n): n is string => typeof n === 'string');
  // точное совпадение, потом префикс (пустые значения не считаются — иначе матчили бы всё)
  const by = (get: (n: string) => string) => cands.find((n) => get(n).toLowerCase() === q)
    ?? cands.find((n) => { const v = get(n).toLowerCase(); return v !== '' && (v.startsWith(q) || q.startsWith(v)); });
  const byName = by((n) => n);
  if (byName !== undefined) return byName;
  const byDisplay = by((n) => profiles.get(n)?.displayName ?? '');
  if (byDisplay !== undefined) return byDisplay;
  return null;
}

/** Итог ожидания воркера. */
export type ChildOutcome =
  | { kind: 'done'; text: string; numTurns?: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * Ждать первый ход дочерней сессии: финальный текст (последний text-блок) и число ходов приходят
 * событиями менеджера; dead/error воркера — неудача. Отписывается во всех ветках.
 */
export function waitChildResult(
  manager: SessionManager,
  childId: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ChildOutcome> {
  const timeoutMs = opts.timeoutMs ?? DELEGATE_WAIT_MS;
  return new Promise((resolve) => {
    let lastText: string | undefined;
    let settled = false;
    const done = (r: ChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      unsub();
      resolve(r);
    };
    const unsub = manager.subscribe((e: Event) => {
      if (e.sessionId !== childId) return;
      switch (e.type) {
        case 'event:message.assistant':
          if (e.block.type === 'text' && e.block.text.trim() !== '') lastText = e.block.text;
          return;
        case 'event:turn.result':
          done({ kind: 'done', text: lastText ?? '', ...(e.numTurns !== undefined ? { numTurns: e.numTurns } : {}) });
          return;
        case 'event:error':
          if (e.code.startsWith('ENGINE')) done({ kind: 'failed', reason: `воркер упал: ${e.message.slice(0, 200)}` });
          return;
        case 'event:session.state':
          if (e.state === 'dead') done({ kind: 'failed', reason: 'воркер остановлен до завершения хода' });
          return;
        default:
          return;
      }
    });
    const timer = setTimeout(() => done({ kind: 'timeout' }), timeoutMs);
    (timer as { unref?: () => void }).unref?.(); // фон: не держим процесс supervisor'а ради таймера
    const onAbort = () => done({ kind: 'aborted' });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Проверки до создания воркера; ok.account — слаг, каким его поняли (модель могла написать displayName). */
export function delegateValidate(
  deps: DelegateDeps,
  callerId: string,
  account: string,
): { ok: true; account: string } | { ok: false; error: string } {
  const caller = deps.manager.get(callerId);
  if (!caller) return { ok: false, error: 'DELEGATE_NO_CALLER: родительская сессия не найдена' };
  if (caller.parentSessionId !== undefined) {
    return { ok: false, error: 'DELEGATE_DEPTH: сабагент не может делегировать дальше (глубина 1)' };
  }
  if (!deps.profiles.delegateAllowed(caller.profile)) {
    const who = deps.profiles.external(caller.profile) ?? 'этот аккаунт';
    return { ok: false, error: `DELEGATE_DISABLED: у аккаунта «${who}» делегирование выключено (Настройки → Аккаунты)` };
  }
  const base = deps.profiles.baseName();
  const resolved = matchAccount(deps.profiles, account);
  if (resolved === null) {
    const list = [...deps.profiles.publicList().map((p) => p.displayName ?? p.name), base].join(', ');
    return { ok: false, error: `UNKNOWN_PROFILE: аккаунта «${account}» нет. Доступны: ${list}` };
  }
  return { ok: true, account: resolved };
}

/** Итог воркера сообщением в родителя: «[воркер] результат + статистика (+ правки)». */
async function workerDoneText(
  deps: DelegateDeps,
  git: GitRunner,
  wt: WorktreeInfo | null,
  args: DelegateArgs,
  account: string,
  childId: string,
  t0: number,
  outcome: ChildOutcome,
): Promise<string> {
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  const who = deps.profiles.external(deps.profiles.internal(account)) ?? account;
  const head = `[воркер «${args.name ?? 'сабагент'}» · ${who} · ${secs} с${outcome.kind === 'done' && outcome.numTurns !== undefined ? ` · ходов ${outcome.numTurns}` : ''} · сессия ${childId}]`;
  const changes = wt !== null && (outcome.kind === 'done' || outcome.kind === 'timeout')
    ? await worktreeChanges(git, wt)
    : null;
  switch (outcome.kind) {
    case 'done':
      return `${head}\n${outcome.text}${changes !== null ? `\n${changes}` : ''}`;
    case 'failed':
      return `${head}\n${outcome.reason}`;
    case 'timeout':
      return `${head}\nВоркер работает дольше обычного — не перезапускай задачу без нужды; следи за его лентой.`;
    case 'aborted':
      return `${head}\nОжидание прервано — воркер продолжает в своей сессии.`;
  }
}

/**
 * Запуск воркера: инструмент возвращается СРАЗУ — родитель не ждёт и продолжает ход (как фоновые
 * сабагенты Claude Code). Итог приезжает родителю отдельным сообщением, когда воркер закончит;
 * с воркером можно говорить параллельно в его сессии (он в списке вложенной строкой).
 */
export async function delegateRun(
  deps: DelegateDeps,
  callerId: string,
  args: DelegateArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const t0 = Date.now();
  const valid = delegateValidate(deps, callerId, args.account);
  if (!valid.ok) return { content: [{ type: 'text', text: valid.error }], isError: true };
  const account = valid.account; // слаг, каким его поняли (модель могла написать displayName)
  const caller = deps.manager.get(callerId)!;

  const childId = randomUUID();
  // git-проект → воркеру свой worktree (может править, не мешая родителю); иначе read-only в общей папке
  const git = deps.git ?? realGit;
  const wt = caller.cwd !== undefined ? await makeWorktree(git, caller.cwd, childId) : null;
  const spawn: SpawnInfo & { parentSessionId?: string; editable?: boolean } = {
    ...(wt !== null || caller.cwd !== undefined ? { cwd: wt?.path ?? caller.cwd } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    // worktree: правки в своей копии безопасны — правит без спроса, команды спрашивает;
    // общая папка: 'default', write-семейство отрежет обёртка read-only на фабрике
    permissionMode: wt !== null ? 'acceptEdits' : 'default',
    ...(wt !== null ? { editable: true } : {}),
    ...(deps.profiles.internal(account) !== undefined ? { profile: deps.profiles.internal(account)! } : {}),
    parentSessionId: callerId,
  };
  deps.manager.create({
    id: childId,
    name: args.name ?? `сабагент · ${caller.name}`.slice(0, 120),
    // spawn несёт cwd/model/permissionMode/profile/parentSessionId — реестр и persist видят воркера целиком
    ...spawn,
    ...(caller.projectId !== undefined ? { projectId: caller.projectId } : {}),
    agentOf: DELEGATE_TOOL,
    factory: deps.factoryFor(spawn, childId),
    ...(deps.resumeFactory ? { resumeFactory: deps.resumeFactory } : {}),
  });
  deps.manager.send(childId, args.prompt);

  // фон: родитель не блокируется — итог придёт ему сообщением (родитель занят — встанет в очередь хода)
  void (async () => {
    const outcome = await waitChildResult(deps.manager, childId, { timeoutMs: DELEGATE_WATCH_MS });
    const text = await workerDoneText(deps, git, wt, args, account, childId, t0, outcome);
    try { deps.manager.send(callerId, text); } catch { /* родитель ушёл — итог остаётся в ленте воркера */ }
  })().catch(() => undefined);

  const who = deps.profiles.external(deps.profiles.internal(account)) ?? account;
  return {
    content: [{
      type: 'text',
      text: `Воркер «${args.name ?? 'сабагент'}» запущен на аккаунте ${who}${wt !== null ? ` в своей ветке ${wt.branch}` : ''} — сессия ${childId}. `
        + 'Не жди его в этом ходе: продолжай свою работу. С воркером можно говорить напрямую (его сессия в списке). '
        + 'Когда он закончит, результат придёт сюда отдельным сообщением.',
    }],
  };
}

/**
 * Конфиг встроенного MCP-сервера делегирования для options.mcpServers конкретной сессии-родителя.
 * Политика always_ask: каждый вызов идёт через canUseTool → карточка «Разрешить делегирование» в UI.
 */
export function createDelegateServerConfig(deps: DelegateDeps, caller: DelegateCaller): McpServerConfig {
  const server = createSdkMcpServer({
    name: DELEGATE_SERVER,
    version: SUPERVISOR_VERSION,
    tools: [{
      name: DELEGATE_TOOL,
      description: toolDescription(deps.profiles),
      inputSchema: delegateArgsSchema.shape,
      handler: async (args) => delegateRun(deps, caller.callerId, delegateArgsSchema.parse(args)),
    }],
  });
  return { ...server, tools: [{ name: DELEGATE_TOOL, permission_policy: 'always_ask' as const }] };
}
