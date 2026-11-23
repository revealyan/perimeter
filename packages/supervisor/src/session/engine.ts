// Engine — обёртка над одной сессией claude (Agent SDK, стриминговый вход).
// Отвечает только за маппинг SDK-событий → черновики кадров протокола;
// seq/шапку навешивает менеджер, состояния выводит тоже менеджер.

import { randomUUID } from 'node:crypto';
import type { ContentBlock, EffortLevel, Event } from '@perimeter/protocol';
import { AsyncQueue } from './asyncQueue.js';
import { outputTokensEnv } from './outputTokens.js';
import type { PermissionResult, QueryLike, SdkMsg, SdkUserInput, SystemInitMsg } from './types.js';

/** Omit, распределяющийся по юниону (иначе теряются ключи вариантов). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Черновик события: без шапки (v/ts/sessionId/seq). */
export type EventDraft = DistributiveOmit<Event, 'v' | 'ts' | 'sessionId' | 'seq'>;

export interface EngineHooks {
  /** signal — отмена запроса со стороны SDK (control_cancel_request, например при interrupt) */
  canUseTool: (toolName: string, input: unknown, opts?: { signal?: AbortSignal }) => Promise<PermissionResult>;
}

export interface EngineOptions {
  /** Фабрика запроса: получает вход-очередь и хуки, возвращает Query. */
  factory: (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => QueryLike;
  onEvent: (e: EventDraft) => void;
  /** Таймаут карточки разрешения; 0 = без таймаута. */
  permissionTimeoutMs?: number;
  /**
   * Текст thinking-блока с его подписью: Claude Code пишет thinking в транскрипт без текста,
   * supervisor хранит его сам (ThinkingStore) — лента после ресинка из транскрипта не теряет размышления.
   */
  onThinking?: (signature: string, text: string) => void;
  /** лимиты подписки (rate_limit_event Claude Code) — supervisor копит их по аккаунту (usage) */
  onRateLimit?: (info: unknown) => void;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (v: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => { this.resolveFn = resolve; });
  }
  resolve(v: T): void { this.resolveFn(v); }
}

interface PendingPermission {
  d: Deferred<PermissionResult>;
  timer: NodeJS.Timeout | undefined;
  /** снять подписку на отмену от SDK */
  unlisten: (() => void) | undefined;
}

export class SessionEngine {
  private readonly opts: EngineOptions;
  private queue: AsyncQueue<SdkUserInput> | null = null;
  private query: QueryLike | null = null;
  private pending = new Map<string, PendingPermission>();
  private openSubagents = new Set<string>();
  private running = false;
  /** stop() уже вызван: конец потока — ожидаемый, не ошибка для UI */
  private stopping = false;
  /** текст текущего thinking-блока из потоковых дельт — запас, если в итоговом сообщении текста нет */
  private streamThinking = '';

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  get isRunning(): boolean { return this.running; }

  /** Запуск: создаёт очередь и процесс, крутит цикл сообщений. */
  async start(): Promise<void> {
    if (this.running) throw new Error('движок уже запущен');
    this.running = true;
    try {
      this.queue = new AsyncQueue<SdkUserInput>();
      this.query = this.opts.factory(this.queue.iterator(), {
        canUseTool: (toolName, input, o) => this.handleCanUseTool(toolName, input, o?.signal),
      });
      for await (const msg of this.query) {
        // ошибка маппинга одного сообщения (новая форма в другой версии CLI) не должна
        // рвать цикл: выход из for-await закрыл бы живой процесс и уронил сессию в dead
        try {
          this.handleMsg(msg);
        } catch (err) {
          this.emit({ type: 'event:error', code: 'MAP_FAILED', message: `сообщение SDK не разобрано: ${String(err).slice(0, 300)}` });
        }
      }
      // генератор завершился = процесс claude ушёл (в стриминговом режиме он живёт вечно);
      // после осознанного stop() (idle-reaping, смена профиля, cmd:session.stop) это не ошибка
      if (!this.stopping) this.emit({ type: 'event:error', code: 'ENGINE_EXIT', message: 'поток claude завершился' });
    } catch (err) {
      if (!this.stopping) this.emit({ type: 'event:error', code: 'ENGINE_CRASH', message: String(err) });
    } finally {
      this.running = false;
      this.settleAllPending('deny', 'движок остановлен');
    }
  }

  /** Отправка сообщения пользователя (стриминговый вход — работает и среди хода). */
  send(text: string, images?: string[]): void {
    if (!this.queue) throw new Error('движок не запущен');
    const content: SdkUserInput['message']['content'] = images && images.length
      ? [
          { type: 'text', text },
          ...images.map((data) => {
            // принимаем и полный dataURL (data:image/jpeg;base64,…), и чистый base64 (по умолчанию png)
            const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(data);
            return {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: (m?.[1] ?? 'image/png') as 'image/png', data: m?.[2] ?? data },
            };
          }),
        ]
      : text;
    this.queue.push({ type: 'user', message: { role: 'user', content } });
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt();
  }

  /** Смена модели на лету (SDK setModel); false — метод недоступен. */
  async setModel(model: string): Promise<boolean> {
    if (!this.query?.setModel) return false;
    await this.query.setModel(model);
    return true;
  }

  /** Смена режима разрешений на лету. */
  async setPermissionMode(mode: string): Promise<boolean> {
    if (!this.query?.setPermissionMode) return false;
    await this.query.setPermissionMode(mode);
    return true;
  }

  /**
   * Усилие и ultracode на лету (SDK applyFlagSettings). Ключи шлём всегда парой: по документации SDK
   * effortLevel без ключа ultracode выключает ultracode. effortLevel null — усилие по умолчанию модели.
   */
  async applyFlags(flags: { effortLevel: EffortLevel | null; ultracode: boolean; outputTokens?: number | null }): Promise<boolean> {
    if (!this.query?.applyFlagSettings) return false;
    await this.query.applyFlagSettings({
      effortLevel: flags.effortLevel,
      ultracode: flags.ultracode,
      // лимит ответа меняется вместе с усилием (настройка аккаунта «на xhigh и выше»)
      ...(flags.outputTokens !== undefined ? { env: outputTokensEnv(flags.outputTokens) } : {}),
    });
    return true;
  }

  /** Снимок контекста (SDK getContextUsage); null — недоступно. */
  async context(): Promise<unknown | null> {
    if (!this.query?.getContextUsage) return null;
    return this.query.getContextUsage('summary');
  }

  /** Ответ на карточку разрешения; false = запроса нет (таймаутнут/чужой). */
  respondPermission(requestId: string, behavior: 'allow' | 'deny', updatedInput?: unknown, updatedPermissions?: unknown): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    if (p.timer) clearTimeout(p.timer);
    p.unlisten?.();
    const res: PermissionResult = behavior === 'allow'
      ? {
          behavior: 'allow',
          ...(updatedInput !== undefined ? { updatedInput } : {}),
          ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
        }
      : { behavior: 'deny', message: 'отклонено в UI' };
    p.d.resolve(res);
    this.emit({
      type: 'event:permission.result', requestId, behavior,
      ...(behavior === 'deny' ? { reason: 'пользователь отклонил' } : {}),
    });
    return true;
  }

  /** Мягкая остановка: погасить карточки, закрыть ввод, дождаться выхода. */
  async stop(): Promise<void> {
    this.stopping = true;
    // карточки гасим синхронно, пока движок ещё текущий у менеджера (кадры permission.result дойдут до UI)
    this.settleAllPending('deny', 'движок остановлен');
    this.queue?.close();
    try { await this.query?.close?.(); } catch { /* процесс мог уже уйти */ }
  }

  // ─── внутреннее ──────────────────────────────────────────────────────────

  private emit(e: EventDraft): void { this.opts.onEvent(e); }

  private async handleCanUseTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<PermissionResult> {
    if (signal?.aborted) return { behavior: 'deny', message: 'запрос отменён до показа' };
    const requestId = randomUUID();
    const questions = toolName === 'AskUserQuestion'
      ? (input as { questions?: unknown } | null)?.questions
      : undefined;
    this.emit({
      type: 'event:permission.request',
      requestId,
      toolName,
      input,
      ...(Array.isArray(questions) ? { questions: questions as never } : {}),
    });
    const p: PendingPermission = { d: new Deferred<PermissionResult>(), timer: undefined, unlisten: undefined };
    const timeout = this.opts.permissionTimeoutMs ?? 0;
    if (timeout > 0) {
      p.timer = setTimeout(() => this.expirePermission(requestId, 'таймаут карточки в UI', 'таймаут'), timeout);
    }
    if (signal) {
      // SDK отменил запрос (interrupt/отмена хода): карточка в UI больше не нужна, ответ на неё бессмысленен
      const onAbort = () => this.expirePermission(requestId, 'запрос отменён claude', 'запрос отменён (interrupt)');
      signal.addEventListener('abort', onAbort, { once: true });
      p.unlisten = () => signal.removeEventListener('abort', onAbort);
    }
    this.pending.set(requestId, p);
    return p.d.promise;
  }

  /** Погасить одну карточку без ответа пользователя (таймаут или отмена со стороны SDK). */
  private expirePermission(requestId: string, message: string, reason: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (p.timer) clearTimeout(p.timer);
    p.unlisten?.();
    p.d.resolve({ behavior: 'deny', message });
    this.emit({ type: 'event:permission.result', requestId, behavior: 'timeout', reason });
  }

  private settleAllPending(behavior: 'deny', reason: string): void {
    for (const [requestId, p] of [...this.pending]) {
      this.pending.delete(requestId);
      if (p.timer) clearTimeout(p.timer);
      p.unlisten?.();
      p.d.resolve({ behavior, message: reason });
      this.emit({ type: 'event:permission.result', requestId, behavior: 'timeout', reason });
    }
  }

  /** Повтор запроса к API: без него сессия минутами висит в «работает» без объяснений (429 у шлюза и т. п.). */
  private handleRetry(m: Record<string, unknown>): void {
    const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
    this.emit({
      type: 'event:api.retry',
      attempt: int(m['attempt']),
      maxRetries: int(m['max_retries']),
      delayMs: int(m['retry_delay_ms']),
      status: typeof m['error_status'] === 'number' ? Math.round(m['error_status']) : null,
      error: typeof m['error'] === 'string' ? m['error'] : 'unknown',
    });
  }

  private handleMsg(msg: SdkMsg): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this.handleInit(msg as unknown as SystemInitMsg);
        else if (msg.subtype === 'api_retry') this.handleRetry(msg as Record<string, unknown>);
        return; // thinking_tokens/… — пока не мапим
      case 'assistant':
        this.handleAssistant(msg);
        return;
      case 'user':
        this.handleUser(msg);
        return;
      case 'stream_event':
        this.handleStreamEvent(msg);
        return;
      case 'result':
        this.handleResult(msg);
        return;
      case 'rate_limit_event':
        this.opts.onRateLimit?.(msg.rate_limit_info);
        return;
    }
  }

  private handleInit(msg: SystemInitMsg): void {
    this.emit({
      type: 'event:session.init',
      tools: msg.tools ?? [],
      mcpServers: msg.mcp_servers ?? [],
      model: msg.model ?? '',
      permissionMode: msg.permissionMode ?? 'default',
      ...(msg.session_id ? { claudeSessionId: msg.session_id } : {}),
      ...(msg.slash_commands ? { slashCommands: msg.slash_commands } : {}),
      ...(msg.agents ? { agents: msg.agents } : {}),
      ...(msg.skills ? { skills: msg.skills } : {}),
    });
  }

  private handleAssistant(msg: Extract<SdkMsg, { type: 'assistant' }>): void {
    const parent = msg.parent_tool_use_id ?? null;
    const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
    for (const raw of blocks) {
      const block = normalizeBlock(raw);
      if (!block) continue;
      if (parent) {
        // ветка субагента (--forward-subagent-text): text/thinking наружу как subagent.message
        if (!this.openSubagents.has(parent)) {
          this.openSubagents.add(parent);
          this.emit({ type: 'event:subagent.start', parentToolUseId: parent });
        }
        if (block.type === 'text' || block.type === 'thinking') {
          this.emit({ type: 'event:subagent.message', parentToolUseId: parent, kind: block.type });
        }
        continue;
      }
      let out = block;
      if (block.type === 'thinking') {
        const text = block.thinking || this.streamThinking;
        this.streamThinking = '';
        const sig = (raw as { signature?: unknown }).signature;
        if (text && typeof sig === 'string' && sig) this.opts.onThinking?.(sig, text);
        if (text !== block.thinking) out = { type: 'thinking', thinking: text };
      }
      this.emit({
        type: 'event:message.assistant',
        messageId: msg.message.id,
        block: out,
        parentToolUseId: null,
      });
    }
  }

  private handleUser(msg: Extract<SdkMsg, { type: 'user' }>): void {
    const parent = msg.parent_tool_use_id ?? null;
    if (parent) {
      // ответ субагента наружу не отдаём в P0 — только закрытие ветки
      this.closeSubagentIfMainResult(msg);
      return;
    }
    const tr = extractToolResult(msg.message?.content);
    if (tr) {
      this.closeSubagentIfToolUseId(tr.toolUseId);
      // поток SDK отдаёт структурированный результат как tool_use_result (snake_case);
      // toolUseResult — написание транскрипта; без обоих — сырой content блока tool_result
      const structured = msg.tool_use_result ?? msg.toolUseResult;
      const result = structured !== undefined ? structured : tr.content;
      this.emit({
        type: 'event:message.user',
        toolUseId: tr.toolUseId,
        isError: tr.isError,
        ...(result !== undefined ? { result } : {}),
      });
      return;
    }
    // обычное user-сообщение (эхо) в P0 не транслируем
    this.closeSubagentIfMainResult(msg);
  }

  private closeSubagentIfMainResult(msg: Extract<SdkMsg, { type: 'user' }>): void {
    const tr = extractToolResult(msg.message?.content);
    if (tr) this.closeSubagentIfToolUseId(tr.toolUseId);
  }

  private closeSubagentIfToolUseId(toolUseId: string): void {
    if (this.openSubagents.has(toolUseId)) {
      this.openSubagents.delete(toolUseId);
      this.emit({ type: 'event:subagent.stop', parentToolUseId: toolUseId });
    }
  }

  private handleStreamEvent(msg: Extract<SdkMsg, { type: 'stream_event' }>): void {
    // партиалы субагента: в протоколе у stream.delta нет родителя — иначе текст субагента
    // печатается «призраком» основной ленты
    if (msg.parent_tool_use_id) return;
    const ev = msg.event;
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') { this.streamThinking = ''; return; }
    if (ev.type !== 'content_block_delta' || !ev.delta) return;
    const d = ev.delta;
    if (d.type === 'text_delta' && d.text !== undefined) {
      this.emit({ type: 'event:stream.delta', kind: 'text', delta: d.text });
    } else if (d.type === 'thinking_delta' && d.thinking !== undefined) {
      this.streamThinking += d.thinking;
      this.emit({ type: 'event:stream.delta', kind: 'thinking', delta: d.thinking });
    } else if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
      this.emit({ type: 'event:stream.delta', kind: 'input_json', delta: d.partial_json });
    }
  }

  private handleResult(msg: Extract<SdkMsg, { type: 'result' }>): void {
    // закрываем оставшиеся ветки субагентов (ход закончился)
    for (const parent of this.openSubagents) {
      this.emit({ type: 'event:subagent.stop', parentToolUseId: parent });
    }
    this.openSubagents.clear();
    const u = msg.usage ?? {};
    // настоящий SDK: modelUsage с camelCase-ключами; model_usage/snake_case — терпимость к старому формату
    const mu = msg.modelUsage ?? msg.model_usage;
    this.emit({
      type: 'event:turn.result',
      subtype: msg.subtype,
      ...(msg.result !== undefined ? { result: msg.result } : {}),
      ...(msg.total_cost_usd !== undefined ? { totalCostUsd: msg.total_cost_usd } : {}),
      ...(msg.usage ? { usage: {
        inputTokens: u['input_tokens'] ?? 0,
        outputTokens: u['output_tokens'] ?? 0,
        ...(u['cache_read_input_tokens'] !== undefined ? { cacheReadTokens: u['cache_read_input_tokens'] } : {}),
        ...(u['cache_creation_input_tokens'] !== undefined ? { cacheCreationTokens: u['cache_creation_input_tokens'] } : {}),
      } } : {}),
      ...(mu ? { modelUsage: Object.fromEntries(
        Object.entries(mu).map(([m, v]) => {
          const cost = v['costUSD'] ?? v['cost_usd'];
          return [m, {
            inputTokens: v['inputTokens'] ?? v['input_tokens'] ?? 0,
            outputTokens: v['outputTokens'] ?? v['output_tokens'] ?? 0,
            ...(cost !== undefined ? { costUsd: cost } : {}),
          }];
        }),
      ) } : {}),
      ...(msg.num_turns !== undefined ? { numTurns: msg.num_turns } : {}),
      ...(msg.duration_ms !== undefined ? { durationMs: msg.duration_ms } : {}),
      ...(msg.permission_denials !== undefined ? { permissionDenials: Array.isArray(msg.permission_denials) ? msg.permission_denials.length : msg.permission_denials } : {}),
    });
  }
}

// ─── нормализация блоков ───────────────────────────────────────────────────

function normalizeBlock(raw: unknown): ContentBlock | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (b['type'] === 'text' && typeof b['text'] === 'string') return { type: 'text', text: b['text'] };
  if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') return { type: 'thinking', thinking: b['thinking'] };
  if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
    return { type: 'tool_use', id: b['id'], name: b['name'], input: b['input'] };
  }
  return null;
}

interface ToolResultInfo { toolUseId: string; isError?: boolean; content?: unknown }

function extractToolResult(content: unknown): ToolResultInfo | null {
  if (!Array.isArray(content)) return null;
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue;
    const b = raw as Record<string, unknown>;
    if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
      return {
        toolUseId: b['tool_use_id'],
        isError: b['is_error'] === true ? true : undefined,
        ...(b['content'] !== undefined ? { content: b['content'] } : {}),
      };
    }
  }
  return null;
}
