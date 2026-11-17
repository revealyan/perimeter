// Пул тёплых claude-процессов (SDK prewarm/SpareProcess):
// держим N прогретых, take() при создании сессии → init мгновенный.
// claim задаёт только cwd/model/permissionMode; всё, что CLI читает на старте (флаги стрима,
// canUseTool, env), фиксируется на prewarm. Поэтому canUseTool спэра — переходник, который
// привязывается к хукам движка сессии в момент старта (ClaimOptions canUseTool не принимает).

import { prewarm, type Options, type PermissionMode, type Query, type SpareProcess } from '@anthropic-ai/claude-agent-sdk/core';
import type { EffortLevel } from '@perimeter/protocol';
import type { QueryLike, SdkMsg, SdkUserInput } from './session/types.js';
import type { EngineHooks } from './session/engine.js';
import { flagSettings, toSdkPermission } from './session/sdk.js';

/** Тёплый слот: процесс + привязка хуков движка, который его заберёт. */
export interface PoolSlot {
  readonly spare: SpareProcess;
  bind(hooks: EngineHooks): void;
}

/** Параметры claim (per-session половина опций SDK). */
export interface ClaimParams {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  /** усилие и ultracode — оверлеем настроек при claim (ClaimOptions.settings, как applyFlagSettings) */
  effort?: EffortLevel;
  ultracode?: boolean;
  /** false — слово «ultracode» не срабатывает (аккаунту запрещено) */
  ultracodeKeyword?: boolean;
}

/** Оверлей настроек для claim: усилие + флаги ultracode; пусто — без оверлея (claim без лишнего круга). */
export function claimSettings(p: ClaimParams): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {
    ...(p.effort !== undefined ? { effortLevel: p.effort } : {}),
    ...(flagSettings(p) ?? {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Обёртка: SpareProcess.claim() на первом next() → наш QueryLike. */
export function spareClaimFactory(
  slot: PoolSlot,
  claimOpts: ClaimParams,
): (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => QueryLike {
  return (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks): QueryLike => {
    // карточки разрешений спэра отныне идут в движок этой сессии
    slot.bind(hooks);
    let claimed: Query | null = null;
    const claim = () => {
      if (claimed) return claimed;
      claimed = slot.spare.claim({
        prompt: input as never, // SDKUserInput ≅ SDKUserMessage (наш стриминговый вход)
        options: {
          cwd: claimOpts.cwd ?? process.cwd(),
          ...(claimOpts.model !== undefined ? { model: claimOpts.model } : {}),
          ...(claimOpts.permissionMode !== undefined ? { permissionMode: claimOpts.permissionMode as PermissionMode } : {}),
          ...(claimSettings(claimOpts) !== undefined ? { settings: claimSettings(claimOpts) as never } : {}),
        },
      });
      return claimed;
    };
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => claim()[Symbol.asyncIterator]().next() as Promise<IteratorResult<SdkMsg>>,
          return: async (value?: unknown) => ({ value, done: true as const }),
          throw: async (e?: unknown) => { throw e; },
        } as AsyncIterator<SdkMsg>;
      },
      interrupt: async () => { await claim().interrupt(); },
      setModel: async (m: string) => { await claim().setModel(m); },
      setPermissionMode: async (m: string) => { await claim().setPermissionMode(m as PermissionMode); },
      getContextUsage: async (d) => claim().getContextUsage(d ? { detail: d } : undefined) as unknown,
      applyFlagSettings: async (s) => { await claim().applyFlagSettings(s as never); },
      // остановка сессии (idle-reaping, stop, смена профиля) обязана гасить процесс — иначе он живёт сиротой
      close: async () => {
        if (claimed) claimed.close();
        else slot.spare.close();
      },
    };
  };
}

export interface PoolExtra {
  /** дефолты claim, когда сессия их не задала (как у холодного пути: модель/режим/cwd supervisor'а) */
  defaults?: ClaimParams;
  /** подмена prewarm (тесты) */
  prewarmFn?: (params: { options: Options }) => Promise<SpareProcess>;
}

export class PrewarmPool {
  private slots: PoolSlot[] = [];
  private warming = 0;
  private stopped = false;
  private readonly size: number;
  private readonly defaults: ClaimParams;
  private readonly prewarmFn: (params: { options: Options }) => Promise<SpareProcess>;

  constructor(size: number, private readonly baseOptions: Options = {}, extra: PoolExtra = {}) {
    this.size = size;
    this.defaults = extra.defaults ?? {};
    this.prewarmFn = extra.prewarmFn ?? ((p) => prewarm(p));
  }

  get warm(): number {
    return this.slots.length;
  }

  get target(): number {
    return this.size;
  }

  /** подогреть до целевого размера */
  async fill(): Promise<void> {
    while (!this.stopped && this.slots.length + this.warming < this.size) {
      this.warming++;
      try {
        const slot = await this.prewarmSlot();
        if (this.stopped) {
          // пул остановили, пока грели — процесс не нужен
          try { slot.spare.close(); } catch { /* уже вышел */ }
          return;
        }
        this.slots.push(slot);
        void slot.spare.exited.then(() => {
          const parked = this.slots.includes(slot);
          this.slots = this.slots.filter((s) => s !== slot);
          // умер запаркованный — восполнить; забранный уже восполнен в take()
          if (parked && !this.stopped) void this.fill();
        }, () => undefined);
      } catch {
        // prewarm недоступен (старый CLI, нет бинаря) — выходим, без горячего цикла респавна;
        // следующая попытка — при следующем take()
        return;
      } finally {
        this.warming--;
      }
    }
  }

  /**
   * Тёплая фабрика для новой сессии; null — пул пуст (холодный spawn). Сразу дозаправляет пул.
   * Слот прогрет с env аккаунта supervisor'а — сессии с профилем (profile задан) его не получают.
   */
  take(sess: ClaimParams, profile?: string): ((input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => QueryLike) | null {
    if (profile !== undefined) return null;
    const slot = this.slots.shift();
    if (!slot) {
      if (!this.stopped) void this.fill();
      return null;
    }
    if (!this.stopped) void this.fill();
    const cwd = sess.cwd ?? this.defaults.cwd;
    const model = sess.model ?? this.defaults.model;
    const permissionMode = sess.permissionMode ?? this.defaults.permissionMode;
    return spareClaimFactory(slot, {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(sess.effort !== undefined ? { effort: sess.effort } : {}),
      ...(sess.ultracode !== undefined ? { ultracode: sess.ultracode } : {}),
      ...(sess.ultracodeKeyword !== undefined ? { ultracodeKeyword: sess.ultracodeKeyword } : {}),
    });
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.slots) { try { s.spare.close(); } catch { /* уже вышел */ } }
    this.slots = [];
  }

  private async prewarmSlot(): Promise<PoolSlot> {
    let hooks: EngineHooks | null = null;
    const spare = await this.prewarmFn({
      options: {
        ...this.baseOptions,
        // флаги процесса — как у холодного пути (sdk.ts): без них у сессий из пула нет стрима и текста субагентов
        includePartialMessages: this.baseOptions.includePartialMessages ?? true,
        forwardSubagentText: this.baseOptions.forwardSubagentText ?? true,
        // без canUseTool на prewarm все запросы разрешений сессии из пула молча отклоняются (карточек нет)
        canUseTool: async (toolName, toolInput, o) => {
          if (!hooks) return { behavior: 'deny', message: 'тёплый процесс ещё не привязан к сессии' };
          return toSdkPermission(await hooks.canUseTool(toolName, toolInput, { signal: o.signal }));
        },
      },
    });
    return { spare, bind: (h) => { hooks = h; } };
  }
}

/** Что нужно WSS от пула: тёплая фабрика по профилю, сводка для hello, пересоздание слота профиля. */
export interface PoolLike {
  readonly warm: number;
  readonly target: number;
  take(sess: ClaimParams, profile?: string): ((input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => QueryLike) | null;
  /** env профиля поменялся (ключ из UI) — его тёплый процесс устарел */
  reset?(profile: string | undefined): void;
  stop(): void;
}

/**
 * Пул по аккаунтам: у каждого профиля свой тёплый процесс (env профиля фиксируется на prewarm),
 * ключ '' — аккаунт supervisor'а (сессии без профиля). Сессия берёт слот своего профиля.
 */
export class ProfilePools implements PoolLike {
  private pools = new Map<string, PrewarmPool>();
  private stopped = false;

  /** make — пул для профиля (undefined — аккаунт supervisor'а); null — этому профилю пул не нужен. */
  constructor(private readonly make: (profile: string | undefined) => PrewarmPool | null, profiles: Array<string | undefined>) {
    for (const p of new Set(profiles)) {
      const pool = make(p);
      if (pool) this.pools.set(p ?? '', pool);
    }
  }

  /** Профили, для которых есть пул ('' — аккаунт supervisor'а). */
  keys(): string[] {
    return [...this.pools.keys()];
  }

  get warm(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.warm;
    return n;
  }

  get target(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.target;
    return n;
  }

  fill(): void {
    for (const p of this.pools.values()) void p.fill();
  }

  take(sess: ClaimParams, profile?: string): ((input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => QueryLike) | null {
    const pool = this.pools.get(profile ?? '');
    // у PrewarmPool слот без профиля; здесь пул уже свой у профиля — берём как «без профиля»
    return pool ? pool.take(sess) : null;
  }

  reset(profile: string | undefined): void {
    const key = profile ?? '';
    const old = this.pools.get(key);
    if (!old || this.stopped) return;
    old.stop();
    const fresh = this.make(profile);
    if (fresh) {
      this.pools.set(key, fresh);
      void fresh.fill();
    } else {
      this.pools.delete(key);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const p of this.pools.values()) p.stop();
  }
}

/**
 * Какие профили греть: PERIMETER_POOL_PROFILES — «all» (все из profiles.json) или список через запятую;
 * аккаунт supervisor'а (сессии без профиля) — если базовый размер пула > 0. Неизвестные имена пропускаются.
 */
export function poolProfiles(spec: string | undefined, known: string[], baseSize: number): Array<string | undefined> {
  const out: Array<string | undefined> = baseSize > 0 ? [undefined] : [];
  const s = (spec ?? '').trim();
  if (s === '') return out;
  const want = s.toLowerCase() === 'all' ? known : s.split(',').map((x) => x.trim()).filter(Boolean);
  for (const name of want) {
    if (name === 'default') { if (!out.includes(undefined)) out.push(undefined); continue; }
    if (known.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
