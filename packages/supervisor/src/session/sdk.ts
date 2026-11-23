// Реальный адаптер Agent SDK → фабрика движка.
// Единственное место, зависящее от SDK (АДР 002); остальное работает с QueryLike.

import { query, type McpServerConfig, type ModelInfo, type Options, type SDKUserMessage, type PermissionResult as SdkPermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { EffortLevel, ModelInfoFrame } from '@perimeter/protocol';
import { DELEGATE_SERVER } from '../delegate.js';
import type { EngineHooks } from './engine.js';
import type { PermissionResult, QueryLike, SdkUserInput } from './types.js';
import { outputTokensEnv } from './outputTokens.js';
export { OUTPUT_TOKENS_VAR, outputTokensEnv } from './outputTokens.js';

/** Наш ответ на карточку → контракт canUseTool SDK (общий для холодного пути и пула). */
export function toSdkPermission(r: PermissionResult): SdkPermissionResult {
  if (r.behavior === 'allow') {
    const ui = r.updatedInput;
    return {
      behavior: 'allow',
      ...(ui !== undefined && ui !== null ? { updatedInput: ui as Record<string, unknown> } : {}),
      // «всегда разрешать»: правило уходит в сессию как есть (контракт SDK updatedPermissions)
      ...(r.updatedPermissions !== undefined ? { updatedPermissions: r.updatedPermissions as never } : {}),
    };
  }
  return { behavior: 'deny', message: r.message ?? 'отклонено в UI' };
}

export interface SdkSessionOptions {
  cwd?: string;
  model?: string;
  permissionMode?: Options['permissionMode'];
  resume?: string;
  forkSession?: boolean;
  includePartialMessages?: boolean;
  forwardSubagentText?: boolean;
  allowedTools?: string[];
  maxTurns?: number;
  /** окружение субпроцесса (мультиакк: токены/CLAUDE_CONFIG_DIR профиля) */
  env?: Record<string, string>;
  /** Лог stderr субпроцесса claude (диагностика запуска). */
  onStderr?: (line: string) => void;
  /** усилие с самого старта (дальше меняется на лету через applyFlagSettings) */
  effort?: EffortLevel;
  /** ultracode включён для сессии */
  ultracode?: boolean;
  /** false — аккаунту ultracode запрещён: слово «ultracode» в сообщении не срабатывает */
  ultracodeKeyword?: boolean;
  /** окно контекста своей модели (autoCompactWindow): Claude Code берёт его только при старте процесса */
  window?: number;
  /** лимит ответа (CLAUDE_CODE_MAX_OUTPUT_TOKENS) оверлеем настроек; null — по умолчанию Claude Code */
  outputTokens?: number | null;
  /** свои MCP-серверы этого query (встроенный инструмент делегирования); к .claude.json аккаунта не пишется */
  mcpServers?: Record<string, McpServerConfig>;
  /** инструменты, которые модели не видят (нативный Task прячем у делегирующих сессий — сабагенты только наши) */
  disallowedTools?: string[];
  /** сессия-воркер (read-only): правки файлов запрещены, остальное — обычные разрешения */
  readonly?: boolean;
}

/** Инструменты, меняющие файлы: воркеру делегирования запрещены (read-only). */
export function isWriteTool(name: string): boolean {
  return name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit';
}

/**
 * Обёртка canUseTool для read-only воркера: write-семейство — отказ с внятным текстом (модель видит причину
 * и перестраивается, карточки в UI не плодим), остальное — обычный путь (спрашивать/разрешать) внутреннего хука.
 */
export function wrapReadonly(inner: EngineHooks['canUseTool']): EngineHooks['canUseTool'] {
  return async (toolName, toolInput, extra) => {
    if (isWriteTool(toolName)) {
      return { behavior: 'deny', message: 'сабагент-воркер работает без права менять файлы (read-only): верни результат текстом' };
    }
    return inner(toolName, toolInput, extra);
  };
}

/**
 * Как модель показывает размышления. По умолчанию Claude Code просит у API режим «updates»: вместо текста
 * размышлений — короткие связки (connector_text), thinking-блоки приходят пустыми (у Anthropic — и в транскрипте:
 * «размышления пропадают»). Явный summarized возвращает текст (проверено подставным шлюзом 23.11: уходит
 * thinking.display=summarized без беты updates, усилие на месте). PERIMETER_THINKING_DISPLAY: summarized
 * (по умолчанию) · omitted · default — не задавать (как решит Claude Code).
 */
export function thinkingOption(env: Record<string, string | undefined> = process.env): Options['thinking'] | undefined {
  const v = (env['PERIMETER_THINKING_DISPLAY'] ?? 'summarized').trim();
  if (v === 'summarized' || v === 'omitted') return { type: 'adaptive', display: v };
  return undefined;
}

/** Флаги-оверлей настроек CLI для старта: ultracode, слово-триггер, окно контекста, лимит ответа. Пусто — без оверлея. */
export function flagSettings(sess: { ultracode?: boolean; ultracodeKeyword?: boolean; window?: number; outputTokens?: number | null }): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {
    ...(sess.ultracode === true && sess.ultracodeKeyword !== false ? { ultracode: true } : {}),
    ...(sess.ultracodeKeyword === false ? { workflowKeywordTriggerEnabled: false } : {}),
    ...(sess.window !== undefined ? { autoCompactWindow: sess.window } : {}),
    ...(sess.outputTokens !== undefined ? { env: outputTokensEnv(sess.outputTokens) } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Папка сессии должна существовать: иначе spawn падает, а SDK сообщает об этом вводящим в заблуждение
 * «native binary … failed to launch … libc» (случай 2026-11-10: проект с путём /opt/project1, которого нет).
 */
export function assertCwd(cwd: string | undefined): void {
  if (cwd === undefined) return;
  let ok = false;
  try { ok = statSync(cwd).isDirectory(); } catch { ok = false; }
  if (!ok) throw new Error(`папки ${cwd} нет на этой машине — сессию не запустить (создайте папку или поменяйте путь проекта)`);
}

export function sdkFactory(sess: SdkSessionOptions) {
  return (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks): QueryLike => {
    assertCwd(sess.cwd);
    const options: Options = {
      includePartialMessages: sess.includePartialMessages ?? true,
      forwardSubagentText: sess.forwardSubagentText ?? true,
      // signal: SDK отменяет запрос (interrupt) — движок гасит карточку, иначе она висит в UI вечно
      // read-only воркер: write-инструменты не доходят до карточек — отказ с причиной (wrapReadonly)
      canUseTool: async (toolName, toolInput, { signal }): Promise<SdkPermissionResult> =>
        toSdkPermission(await (sess.readonly === true ? wrapReadonly(hooks.canUseTool) : hooks.canUseTool)(toolName, toolInput, { signal })),
      ...(sess.onStderr ? { stderr: sess.onStderr } : {}),
      ...(sess.cwd !== undefined ? { cwd: sess.cwd } : {}),
      ...(sess.model !== undefined ? { model: sess.model } : {}),
      ...(sess.permissionMode !== undefined ? { permissionMode: sess.permissionMode } : {}),
      ...(sess.resume !== undefined ? { resume: sess.resume } : {}),
      ...(sess.forkSession ? { forkSession: true } : {}),
      ...(sess.allowedTools !== undefined ? { allowedTools: sess.allowedTools } : {}),
      ...(sess.maxTurns !== undefined ? { maxTurns: sess.maxTurns } : {}),
      ...(sess.env !== undefined ? { env: sess.env } : {}),
      ...(sess.mcpServers !== undefined ? { mcpServers: sess.mcpServers } : {}),
      ...(sess.disallowedTools !== undefined ? { disallowedTools: sess.disallowedTools } : {}),
      ...(sess.effort !== undefined ? { effort: sess.effort } : {}),
      ...(thinkingOption() !== undefined ? { thinking: thinkingOption()! } : {}),
      ...(flagSettings(sess) !== undefined ? { settings: flagSettings(sess) as Options['settings'] } : {}),
      // явный путь к CLI (packaged-приложение: бинарь в докачанном node_modules — сам SDK его из бандла не разрезолвит)
      ...(process.env.PERIMETER_CLI_PATH !== undefined ? { pathToClaudeCodeExecutable: process.env.PERIMETER_CLI_PATH } : {}),
    };
    const q = query({
      // вход движка (наша очередь) отдаём как стриминговый prompt SDK
      prompt: input as unknown as AsyncIterable<SDKUserMessage>,
      options,
    });
    // делегирование: always_ask в режимах auto/dontAsk движок молча отвергает («is blocked…
    // switch to another permission mode») — принудительно «спрашивать» для нашего сервера
    // в любом режиме сессии: карточка в «Ждут тебя» вместо тихого отказа
    if (sess.mcpServers?.[DELEGATE_SERVER] !== undefined) {
      void (q as unknown as { setMcpPermissionModeOverride?: (n: string, m: 'default' | 'auto' | null) => Promise<unknown> })
        .setMcpPermissionModeOverride?.(DELEGATE_SERVER, 'default').catch(() => undefined);
    }
    // Query реализует AsyncGenerator<SDKMessage> + interrupt/close — это и есть QueryLike
    return q as unknown as QueryLike;
  };
}

/** ModelInfo SDK → модель для клиента: id для --model, подпись, уровни усилия (нет усилия — пустой список). */
/**
 * Модель Claude Code → модель для UI, как в Claude Code Desktop: displayName «Opus» без версии, а версия — в начале
 * description («Opus 5.5 · Best for everyday, complex tasks») → подпись «Opus 5.5», пояснение — после « · ».
 * «Default (recommended)» → «По умолчанию · Sonnet 5.5».
 */
export function toModelInfo(m: Pick<ModelInfo, 'value' | 'displayName' | 'supportsEffort' | 'supportedEffortLevels'> & { description?: string }): ModelInfoFrame {
  // без цен («$3/$15 per Mtok» — у входа по ключу API): в выборе модели они только шумят
  const parts = (m.description ?? '').split(' · ').map((x) => x.trim()).filter((x) => x && !/per\s+mtok/i.test(x));
  const name = (m.displayName ?? '').trim();
  let head = '';
  let tail = parts.join(' · ');
  if (parts.length > 1 || (parts[0] && name && parts[0].toLowerCase().startsWith(name.toLowerCase()))) {
    head = parts[0] ?? '';
    tail = parts.slice(1).join(' · ');
  }
  let label: string | undefined = name || undefined;
  if (m.value === 'default') {
    // «Sonnet 5.5» или «Use the default model (currently Opus 5.5)»
    const cur = /currently ([^)]+)\)/i.exec(m.description ?? '')?.[1]?.trim() ?? head;
    if (cur) label = `По умолчанию · ${cur}`;
    // «Use the default model (currently …)» — уже в подписи, пояснением не дублируем
    tail = (head ? parts.slice(1) : parts).filter((x) => !/currently/i.test(x)).join(' · ');
  } else if (head && name && head.toLowerCase().startsWith(name.toLowerCase())) label = head;
  return {
    id: m.value,
    ...(label ? { label } : {}),
    ...(tail ? { description: tail.slice(0, 200) } : {}),
    efforts: m.supportsEffort === true ? [...(m.supportedEffortLevels ?? [])] : [],
  };
}

/**
 * Данные /usage Claude Code (лимиты подписки) без хода: временный query с пустым вводом, как fetchSupportedModels.
 * API экспериментальный (usage_EXPERIMENTAL_MAY_CHANGE_…): нет метода — undefined. У входа токеном подписки
 * rate_limits_available=false — тогда лимиты берутся из ответов API в сессиях (rate_limit_event).
 */
export async function fetchUsageApi(opts: { env?: Record<string, string>; cwd?: string }, timeoutMs = 30_000): Promise<unknown> {
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined) }),
  };
  const q = query({ prompt: idle, options: { cwd: opts.cwd ?? homedir(), ...(opts.env !== undefined ? { env: opts.env } : {}) } });
  const fn = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<unknown> })
    .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    if (!fn) return undefined;
    return await Promise.race([
      fn.call(q, { skipBehaviors: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Claude Code не ответил за ${Math.round(timeoutMs / 1000)} с`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    q.close();
  }
}

/**
 * Список моделей аккаунта у самого Claude Code — без сообщения в сессию и без расхода токенов:
 * временный query с пустым потоком ввода, initialize отдаёт модели (проверено на CLI: ~2.5 с, процесс сразу закрывается).
 */
export async function fetchSupportedModels(opts: { env?: Record<string, string>; cwd?: string }, timeoutMs = 20_000): Promise<ModelInfoFrame[]> {
  // поток ввода, который никогда ничего не отдаёт: процесс поднимается, но хода нет
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined) }),
  };
  const q = query({
    prompt: idle,
    options: {
      cwd: opts.cwd ?? homedir(),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Claude Code не ответил за ${Math.round(timeoutMs / 1000)} с`)), timeoutMs); }),
    ]);
    return models.map(toModelInfo);
  } finally {
    if (timer) clearTimeout(timer);
    try { q.close(); } catch { /* процесс уже вышел */ }
  }
}
