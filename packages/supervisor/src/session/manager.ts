// Менеджер сессий: реестр, seq-шапки кадров, вывод состояний из потока событий.
// Состояния не хранит в engine — выводит их здесь по семантике кадров (p0-design §4).

import { randomUUID } from 'node:crypto';
import {
  EventSchema, PROTOCOL_VERSION, type EffortLevel, type Event, type SessionState,
} from '@perimeter/protocol';
import { assertTransition, SeqCounter } from './state.js';
import { SessionEngine, type EngineHooks, type EventDraft } from './engine.js';
import type { QueryLike, SdkUserInput } from './types.js';

export interface SessionInfo {
  id: string;
  /** настоящий id сессии claude (транскрипт/resume); отсутствует до system/init */
  claudeSessionId?: string;
  name: string;
  state: SessionState;
  needs: string | null;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  /** профиль аккаунта (мультиакк), под которым живёт сессия */
  profile?: string;
  /** проект, если сессия создана в проекте */
  projectId?: string;
  /** сессия в архиве */
  archived?: boolean;
  /** усилие; нет — по умолчанию модели */
  effort?: EffortLevel;
  /** ultracode включён (нет — выключен) */
  ultracode?: boolean;
  /** окно автокомпакта сессии; нет — модели/аккаунта */
  compactWindow?: number;
  /** сессия-воркер (сквозной сабагент): id родительской сессии; нет — обычная сессия */
  parentSessionId?: string;
  /** чем порождена воркер (имя инструмента делегирования); справочно */
  agentOf?: string;
  /** сессия переехала в другую среду (архивная пометка «переехала → …», метка среды-цели) */
  movedTo?: string;
  /** сессия приехала из другой среды (метка среды-источника — плашка в ленте) */
  movedFrom?: string;
}

/** Параметры процесса, которые переживают respawn/форк: всё, что нужно, чтобы поднять сессию заново. */
export interface SpawnInfo {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  profile?: string;
  effort?: EffortLevel;
  ultracode?: boolean;
  compactWindow?: number;
}

/** Запись реестра для персистентности (state-store). */
export interface SavedSession extends SpawnInfo {
  id: string;
  name: string;
  claudeSessionId?: string;
  projectId?: string;
  archived?: boolean;
  /** воркер делегирования: родитель и инструмент (вложенность переживает рестарт) */
  parentSessionId?: string;
  agentOf?: string;
  /** перенос между средами: пометки переезда (см. SessionInfo) */
  movedTo?: string;
  movedFrom?: string;
  lastSeq: number;
}

type EngineFactory = (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => QueryLike;

export interface SessionCreateOptions {
  /** заранее известный id (делегирование: сессия-родитель должна знать id воркера до создания) */
  id?: string;
  name?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  profile?: string;
  projectId?: string;
  effort?: EffortLevel;
  ultracode?: boolean;
  /** создать воркером этой сессии (сквозной сабагент) */
  parentSessionId?: string;
  /** чем порождён воркер (имя инструмента делегирования) */
  agentOf?: string;
  /** фабрика процесса: как engine запускает claude (SDK-адаптер или мок) */
  factory: EngineFactory;
  /** фабрика возрождения после смерти процесса: SDK с resume=<claudeSessionId>; получает сохранённые параметры сессии */
  resumeFactory?: (sessionId: string, info: SpawnInfo & { claudeSessionId?: string }) => EngineFactory;
  /** фабрика форка: SDK с resume+forkSession — копия истории в новую сессию */
  forkFactory?: (claudeSessionId: string, info: SpawnInfo) => EngineFactory;
  permissionTimeoutMs?: number;
}

type Subscriber = (e: Event) => void;

interface Entry {
  info: SessionInfo;
  seq: SeqCounter;
  engine: SessionEngine;
  runPromise: Promise<void>;
  opts: SessionCreateOptions;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** последнее касание (выбор в окне, набор, отправка, смена состояния) — кого вытеснять первым при лимите */
  touchedAt: number;
  /** разбужена заранее (wake) и хода с тех пор не было — гасится по короткому простою */
  wokeUnused: boolean;
  /** гасится ради места (makeRoom): stop асинхронный — пока идёт, в живых не считаем и второй раз не выбираем */
  evicting: boolean;
  /** неотвеченные карточки разрешений: исходные кадры (с исходным seq) — для досылки свежему клиенту */
  pending: Map<string, Extract<Event, { type: 'event:permission.request' }>>;
}

/** Поля процесса из записи сессии (без undefined — exactOptionalPropertyTypes). */
function spawnInfo(i: SpawnInfo): SpawnInfo {
  return {
    ...(i.cwd !== undefined ? { cwd: i.cwd } : {}),
    ...(i.model !== undefined ? { model: i.model } : {}),
    ...(i.permissionMode !== undefined ? { permissionMode: i.permissionMode } : {}),
    ...(i.profile !== undefined ? { profile: i.profile } : {}),
    ...(i.effort !== undefined ? { effort: i.effort } : {}),
    ...(i.ultracode === true ? { ultracode: true } : {}),
    ...(i.compactWindow !== undefined ? { compactWindow: i.compactWindow } : {}),
  };
}

/** Текст «на чём стоим» для карточки разрешения/вопроса. */
function needsOf(req: { toolName: string; questions?: Array<{ question: string }> }): string {
  return Array.isArray(req.questions) && req.questions[0] ? req.questions[0].question : `разрешение: ${req.toolName}`;
}

/**
 * Живые процессы (владелец 2026-11-26: «если будить много сессий — будет много Claude Code, надо менеджерить»).
 * Будим заранее (окно выбрало сессию), поэтому число живых ограничено: сверх лимита первой гасится давно не
 * тронутая простаивающая; занятые (ход, карточка) не трогаем никогда. Отправка будит всегда — лимит для неё мягкий.
 */
export interface LiveLimits {
  /** сколько процессов claude держать живыми (по умолчанию без лимита; supervisor считает от памяти) */
  maxLive?: number;
  /** простой разбуженной заранее, но так и не получившей хода (короче обычного — не копим «посмотрел и ушёл») */
  wakeIdleMs?: number;
  /** свободная память, байт (os.freemem) — заранее не будим, если её меньше minFreeBytes */
  freeMem?: () => number;
  minFreeBytes?: number;
}

export class SessionManager {
  private sessions = new Map<string, Entry>();
  private subscribers = new Set<Subscriber>();
  private persistHook: (() => void) | null = null;
  private createdHook: ((info: SessionInfo) => void) | null = null;
  /** Куда складывать текст thinking-блоков (ThinkingStore supervisor'а); нет — не храним. */
  thinkingSink: ((signature: string, text: string) => void) | null = null;
  /** Куда отдавать лимиты подписки из сессий (аккаунт сессии + rate_limit_info) — usage у wss. */
  rateLimitSink: ((profile: string | undefined, info: unknown) => void) | null = null;
  private readonly idleTimeoutMs: number;
  private readonly live: Required<LiveLimits>;

  /**
   * idleTimeoutMs > 0: простаивающую сессию останавливаем (dead), сообщение поднимет через resume.
   * live — сколько процессов claude держать живыми и когда не будить заранее (см. LiveLimits).
   */
  constructor(idleTimeoutMs = 0, live: LiveLimits = {}) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.live = {
      maxLive: live.maxLive ?? Infinity,
      wakeIdleMs: live.wakeIdleMs ?? 5 * 60_000,
      freeMem: live.freeMem ?? (() => Infinity),
      minFreeBytes: live.minFreeBytes ?? 0,
    };
  }

  /** хук персистентности: дёргается после каждого кадра (инвариант 1/2) */
  setPersistHook(fn: (() => void) | null): void {
    this.persistHook = fn;
  }

  /** хук новой сессии: дёргается при create/fork — WSS рассылает event:session.created (restore не считает) */
  setCreatedHook(fn: ((info: SessionInfo) => void) | null): void {
    this.createdHook = fn;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  get(sessionId: string): SessionInfo | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.info } : undefined;
  }

  /** Неотвеченные карточки разрешений сессии (исходные кадры) — досылаются клиенту при hello. */
  pendingPermissionFrames(sessionId: string): Event[] {
    const s = this.sessions.get(sessionId);
    return s ? [...s.pending.values()] : [];
  }

  create(opts: SessionCreateOptions): string {
    const id = opts.id ?? randomUUID();
    const info: SessionInfo = {
      id,
      name: opts.name ?? `сессия-${id.slice(0, 8)}`,
      state: 'creating',
      needs: null,
      ...spawnInfo(opts),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
      ...(opts.agentOf !== undefined ? { agentOf: opts.agentOf } : {}),
    };
    this.launch(id, info, opts, opts.factory);
    return id;
  }

  /** Снимок реестра для персистентности (state-store). */
  snapshot(): SavedSession[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.info.id,
      name: s.info.name,
      ...(s.info.claudeSessionId !== undefined ? { claudeSessionId: s.info.claudeSessionId } : {}),
      ...spawnInfo(s.info),
      ...(s.info.projectId !== undefined ? { projectId: s.info.projectId } : {}),
      ...(s.info.archived !== undefined ? { archived: s.info.archived } : {}),
      ...(s.info.parentSessionId !== undefined ? { parentSessionId: s.info.parentSessionId } : {}),
      ...(s.info.agentOf !== undefined ? { agentOf: s.info.agentOf } : {}),
      ...(s.info.movedTo !== undefined ? { movedTo: s.info.movedTo } : {}),
      ...(s.info.movedFrom !== undefined ? { movedFrom: s.info.movedFrom } : {}),
      lastSeq: s.seq.last,
    }));
  }

  /** Последний выданный seq (для догона/ресинка). */
  seqLast(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.seq.last ?? null;
  }

  /**
   * Восстановление реестра после рестарта supervisor'а: сессии «мертвы», но resumable.
   * forkFactory обязателен для форка восстановленных сессий (иначе FORK_IMPOSSIBLE до следующего создания).
   */
  restore(
    saved: SavedSession[],
    resumeFactory: SessionCreateOptions['resumeFactory'],
    forkFactory?: SessionCreateOptions['forkFactory'],
  ): void {
    for (const s of saved) {
      if (this.sessions.has(s.id)) continue;
      this.sessions.set(s.id, {
        info: {
          id: s.id, name: s.name, state: 'dead', needs: null,
          ...(s.claudeSessionId !== undefined ? { claudeSessionId: s.claudeSessionId } : {}),
          ...spawnInfo(s),
          ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
          ...(s.archived !== undefined ? { archived: s.archived } : {}),
          ...(s.parentSessionId !== undefined ? { parentSessionId: s.parentSessionId } : {}),
          ...(s.agentOf !== undefined ? { agentOf: s.agentOf } : {}),
          ...(s.movedTo !== undefined ? { movedTo: s.movedTo } : {}),
          ...(s.movedFrom !== undefined ? { movedFrom: s.movedFrom } : {}),
        },
        seq: new SeqCounter(s.lastSeq + 1),
        engine: new SessionEngine({ factory: () => { throw new Error('движок не запущен'); }, onEvent: () => undefined }),
        runPromise: Promise.resolve(),
        opts: {
          factory: () => { throw new Error('нет фабрики'); },
          ...(resumeFactory ? { resumeFactory } : {}),
          ...(forkFactory ? { forkFactory } : {}),
        },
        idleTimer: null,
        touchedAt: 0,
        wokeUnused: false,
        evicting: false,
        pending: new Map(),
      });
    }
  }

  /**
   * Перенос в другую среду (T-ряд): остановить процесс и архивировать с пометкой «переехала → to».
   * Работающую сессию не трогаем (busy) — ждущие аппрувы и середину хода переносить нельзя.
   */
  markMoved(sessionId: string, to: string): 'ok' | 'not-found' | 'busy' {
    const s = this.sessions.get(sessionId);
    if (!s) return 'not-found';
    if (s.info.state !== 'idle' && s.info.state !== 'dead') return 'busy';
    if (s.info.state === 'idle') {
      // хвост старого движка отсекается в onEvent; respawn не нужен — история уезжает
      void s.engine.stop().catch(() => undefined);
      this.setState(sessionId, 'dead');
    }
    s.info.archived = true;
    s.info.movedTo = to;
    this.persistHook?.();
    return 'ok';
  }

  /**
   * Удаление сессии с историей: останавливаем процесс, выкидываем запись реестра.
   * Работающую не трогаем (busy) — середину хода удалять нельзя. Транскрипт снимает wss.
   */
  deleteSession(sessionId: string): 'ok' | 'not-found' | 'busy' {
    const s = this.sessions.get(sessionId);
    if (!s) return 'not-found';
    if (s.info.state !== 'idle' && s.info.state !== 'dead') return 'busy';
    if (s.info.state === 'idle') void s.engine.stop().catch(() => undefined);
    // карточек нет (waiting_permission не проходит проверку выше), хвост движка отсечётся в onEvent
    this.sessions.delete(sessionId);
    this.persistHook?.();
    return 'ok';
  }

  /**
   * Приём перенесённой сессии: запись реестра без процесса (первый ход поднимет через resumeFactory),
   * персист и event:session.created — как у create, но сразу dead.
   */
  importSession(
    saved: SavedSession,
    resumeFactory: SessionCreateOptions['resumeFactory'],
    forkFactory?: SessionCreateOptions['forkFactory'],
  ): SessionInfo | null {
    if (this.sessions.has(saved.id)) return null;
    this.restore([saved], resumeFactory, forkFactory);
    this.persistHook?.();
    const info = this.sessions.get(saved.id)?.info;
    if (info) this.createdHook?.(info);
    return info ?? null;
  }

  /** Форк: новая сессия с копией истории до текущего момента (SDK resume+forkSession). */
  fork(sessionId: string): string | null {
    const src = this.sessions.get(sessionId);
    if (!src || !src.opts.forkFactory || !src.info.claudeSessionId) return null;
    const claudeSessionId = src.info.claudeSessionId;
    const id = randomUUID();
    const info: SessionInfo = {
      id,
      name: `форк · ${src.info.name}`,
      state: 'creating',
      needs: null,
      ...spawnInfo(src.info),
      ...(src.info.projectId !== undefined ? { projectId: src.info.projectId } : {}),
    };
    const factory = src.opts.forkFactory(claudeSessionId, spawnInfo(info));
    this.launch(id, info, src.opts, factory);
    return id;
  }

  /**
   * Смена модели на лету (SDK setModel). Мёртвая сессия: запоминаем, применится при respawn.
   * engineModel — что отдать Claude Code (например, с [1m]); в реестре остаётся выбранная модель.
   */
  async setModel(sessionId: string, model: string, engineModel: string = model): Promise<boolean> {
    const s = this.require(sessionId);
    if (!s.engine.isRunning) {
      s.info.model = model;
      this.persistHook?.();
      return true;
    }
    const ok = await s.engine.setModel(engineModel);
    if (ok) { s.info.model = model; this.persistHook?.(); }
    return ok;
  }

  /**
   * Окно автокомпакта: Claude Code читает его только при старте процесса (applyFlagSettings не меняет — проверено
   * 23.11). Запоминаем; живой процесс между ходами гасит вызывающий (wss), следующее сообщение поднимет с новым.
   */
  setCompactWindow(sessionId: string, window: number | null): void {
    const s = this.require(sessionId);
    if (window === null) delete s.info.compactWindow; else s.info.compactWindow = window;
    this.persistHook?.();
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<boolean> {
    const s = this.require(sessionId);
    if (!s.engine.isRunning) {
      s.info.permissionMode = mode;
      this.persistHook?.();
      return true;
    }
    const ok = await s.engine.setPermissionMode(mode);
    if (ok) { s.info.permissionMode = mode; this.persistHook?.(); }
    return ok;
  }

  /**
   * Усилие и ultracode на лету (SDK applyFlagSettings). effort: null — по умолчанию модели, undefined — не менять;
   * ultracode: undefined — не менять. Мёртвая сессия: запоминаем, применится при respawn.
   */
  async setFlags(sessionId: string, flags: { effort?: EffortLevel | null; ultracode?: boolean; outputTokens?: number | null }): Promise<boolean> {
    const s = this.require(sessionId);
    const effort = flags.effort === undefined ? s.info.effort : (flags.effort ?? undefined);
    const ultracode = flags.ultracode ?? s.info.ultracode === true;
    const commit = () => {
      if (effort === undefined) delete s.info.effort; else s.info.effort = effort;
      if (ultracode) s.info.ultracode = true; else delete s.info.ultracode;
      this.persistHook?.();
    };
    if (!s.engine.isRunning) {
      commit();
      return true;
    }
    // лимит ответа не храним: при respawn он заново считается из аккаунта и усилия (buildOptions)
    const ok = await s.engine.applyFlags({ effortLevel: effort ?? null, ultracode, ...(flags.outputTokens !== undefined ? { outputTokens: flags.outputTokens } : {}) });
    if (ok) commit();
    return ok;
  }

  /** Снимок контекста (кольцо правой панели). */
  async getContext(sessionId: string): Promise<unknown | null> {
    const s = this.require(sessionId);
    return s.engine.context();
  }

  /**
   * Смена аккаунта (профиля) сессии: только между ходами (idle/dead).
   * overrides — модель/режим нового аккаунта: применяются к возрождённому процессу, а не к старому.
   */
  switchProfile(
    sessionId: string,
    profile: string | undefined,
    overrides: { model?: string; permissionMode?: string; effort?: EffortLevel | null; ultracode?: boolean } = {},
  ): 'ok' | 'busy' | 'not-found' {
    const s = this.sessions.get(sessionId);
    if (!s) return 'not-found';
    if (s.info.state !== 'idle' && s.info.state !== 'dead') return 'busy';
    const changed = s.info.profile !== profile
      || (overrides.model !== undefined && overrides.model !== s.info.model)
      || (overrides.permissionMode !== undefined && overrides.permissionMode !== s.info.permissionMode)
      || (overrides.effort !== undefined && (overrides.effort ?? undefined) !== s.info.effort)
      || (overrides.ultracode !== undefined && overrides.ultracode !== (s.info.ultracode === true));
    if (!changed) return 'ok'; // тот же аккаунт с теми же настройками — процесс не перезапускаем
    // undefined — аккаунт самого supervisor'а (сессия без профиля)
    if (profile === undefined) delete s.info.profile; else s.info.profile = profile;
    if (overrides.model !== undefined) s.info.model = overrides.model;
    if (overrides.permissionMode !== undefined) s.info.permissionMode = overrides.permissionMode;
    if (overrides.effort === null) delete s.info.effort;
    else if (overrides.effort !== undefined) s.info.effort = overrides.effort;
    if (overrides.ultracode === false) delete s.info.ultracode;
    else if (overrides.ultracode === true) s.info.ultracode = true;
    this.persistHook?.();
    if (s.info.state === 'idle') {
      // живой процесс stop'аем, помечаем dead и сразу возрождаем с env нового профиля;
      // хвост старого движка отсекается в onEvent (он больше не текущий)
      void s.engine.stop().catch(() => undefined);
      this.setState(sessionId, 'dead');
      this.respawn(sessionId);
    } // dead — профиль применится при следующем запуске
    return 'ok';
  }

  /** Переименовать сессию (реестр/UI; имя claude-сессии не трогаем). */
  rename(sessionId: string, name: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.info.name = name;
    this.persistHook?.();
    return true;
  }

  /** Архив: сессия уезжает вниз сайдбара, из архива возвращается без потерь. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.info.archived = archived;
    // вернуть в строй = отменить несостоявшийся переезд (пометка «переехала → …» теряет смысл)
    if (!archived) delete s.info.movedTo;
    this.persistHook?.();
    return true;
  }

  /** Возрождение сессии через resume (инвариант 2): dead → initializing. */
  respawn(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || (entry.info.state !== 'dead' && entry.info.state !== 'error')) return false;
    const factory = entry.opts.resumeFactory
      ? entry.opts.resumeFactory(sessionId, {
          ...(entry.info.claudeSessionId !== undefined ? { claudeSessionId: entry.info.claudeSessionId } : {}),
          ...spawnInfo(entry.info),
        })
      : entry.opts.factory;
    // карточки прежнего процесса к новому не относятся (прежний движок их уже погасил)
    entry.pending.clear();
    entry.engine = this.makeEngine(sessionId, factory, entry.opts.permissionTimeoutMs);
    this.setState(sessionId, 'initializing');
    entry.runPromise = entry.engine.start().catch(() => { /* ENGINE_CRASH уже в потоке */ });
    return true;
  }

  /**
   * Отправка сообщения. Мёртвая — сначала возрождается. В working переводит только из «спокойных»
   * состояний: в ходе/на карточке/после interrupt сообщение встаёт в очередь CLI, а состояние ведёт поток событий.
   */
  send(sessionId: string, text: string, images?: string[]): void {
    const s = this.require(sessionId);
    s.wokeUnused = false;
    s.touchedAt = Date.now();
    if (s.info.state === 'dead' || s.info.state === 'error') {
      this.makeRoom(sessionId); // мягко: не нашлось кого погасить — всё равно будим, сообщение важнее лимита
      this.respawn(sessionId);
    }
    s.engine.send(text, images);
    if (s.info.state === 'idle' || s.info.state === 'initializing') this.setState(sessionId, 'working');
  }

  /** Ответ на карточку; состояние выводится из кадра permission.result (с учётом остальных карточек). */
  respondPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny', updatedInput?: unknown, updatedPermissions?: unknown): boolean {
    const s = this.require(sessionId);
    return s.engine.respondPermission(requestId, behavior, updatedInput, updatedPermissions);
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.require(sessionId);
    await s.engine.interrupt();
    // Stop на стыке с концом хода: сессия уже idle — это не ошибка, состояние не трогаем
    const cur = s.info.state;
    if (cur === 'working' || cur === 'waiting_permission' || cur === 'waiting_input') {
      this.setState(sessionId, 'interrupted');
    }
  }

  /**
   * Разбудить заранее (окно открыло сессию, начали печатать): остывшую — процесс с resume без хода, к отправке он
   * уже поднят; живую — продлить простой. limit — живых уже maxLive и гасить некого (все заняты) или мало памяти:
   * проснётся сообщением, как раньше.
   */
  wake(sessionId: string): 'woken' | 'alive' | 'limit' {
    const s = this.require(sessionId);
    s.touchedAt = Date.now();
    const st = s.info.state;
    if (st !== 'dead' && st !== 'error') {
      if (st === 'idle') this.armIdle(sessionId, s);
      return 'alive';
    }
    if (this.live.freeMem() < this.live.minFreeBytes) return 'limit';
    if (!this.makeRoom(sessionId)) return 'limit';
    s.wokeUnused = true;
    this.respawn(sessionId);
    return 'woken';
  }

  /** Лимит живых процессов (Infinity — без лимита). */
  get maxLive(): number {
    return this.live.maxLive;
  }

  /** Сколько процессов claude живо (всё, кроме остывших и упавших). */
  liveCount(): number {
    let n = 0;
    for (const e of this.sessions.values()) if (e.info.state !== 'dead' && e.info.state !== 'error' && !e.evicting) n++;
    return n;
  }

  /**
   * Место под ещё один процесс: живых ≥ maxLive — гасим давно не тронутые простаивающие (кроме самой сессии).
   * false — гасить некого (живые заняты ходом/карточкой).
   */
  private makeRoom(exceptId: string): boolean {
    let live = this.liveCount();
    if (live < this.live.maxLive) return true;
    const idle = [...this.sessions.entries()]
      .filter(([id, e]) => id !== exceptId && e.info.state === 'idle' && !e.evicting)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [id, e] of idle) {
      if (live < this.live.maxLive) break;
      e.evicting = true;
      void this.stop(id).catch(() => undefined).finally(() => { e.evicting = false; });
      live--;
    }
    return live < this.live.maxLive;
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.require(sessionId);
    const engine = s.engine;
    await engine.stop();
    // за время остановки сессию могли уже возродить новым сообщением — тогда новый движок не трогаем
    if (s.engine === engine) this.setState(sessionId, 'dead');
  }

  // ─── внутреннее ──────────────────────────────────────────────────────────

  /** Зарегистрировать сессию и запустить её первый движок. */
  private launch(id: string, info: SessionInfo, opts: SessionCreateOptions, factory: EngineFactory): void {
    const entry: Entry = {
      info, seq: new SeqCounter(), engine: this.makeEngine(id, factory, opts.permissionTimeoutMs),
      runPromise: Promise.resolve(), opts, idleTimer: null, touchedAt: Date.now(), wokeUnused: false, evicting: false, pending: new Map(),
    };
    this.sessions.set(id, entry);
    this.createdHook?.({ ...info });
    this.setState(id, 'initializing');
    entry.runPromise = entry.engine.start().catch(() => { /* ENGINE_CRASH уже в потоке */ });
  }

  /** Движок, чьи события идут в поток сессии только пока он текущий (после respawn старый — немой). */
  private makeEngine(sessionId: string, factory: EngineFactory, permissionTimeoutMs: number | undefined): SessionEngine {
    const engine: SessionEngine = new SessionEngine({
      factory,
      ...(permissionTimeoutMs !== undefined ? { permissionTimeoutMs } : {}),
      onThinking: (signature, text) => this.thinkingSink?.(signature, text),
      onRateLimit: (info) => this.rateLimitSink?.(this.sessions.get(sessionId)?.info.profile, info),
      // процесс поднялся: «запускается» → «готова» сразу, не дожидаясь system/init (его CLI шлёт только с первым ходом)
      onReady: () => {
        const cur = this.sessions.get(sessionId);
        if (cur && cur.engine === engine && cur.info.state === 'initializing') this.setState(sessionId, 'idle');
      },
      onEvent: (draft) => {
        const cur = this.sessions.get(sessionId);
        if (!cur || cur.engine !== engine) return; // хвост заменённого процесса (смена профиля/respawn)
        this.dispatch(sessionId, cur, draft);
      },
    });
    return engine;
  }

  private dispatch(sessionId: string, entry: Entry, draft: EventDraft): void {
    // вывод состояния из семантики события; конфликт перехода не должен ронять кадр
    try {
      this.deriveState(sessionId, draft);
    } catch (err) {
      this.broadcast({
        v: PROTOCOL_VERSION, ts: Date.now(), sessionId, seq: entry.seq.take(),
        type: 'event:error', code: 'STATE_TRANSITION', message: String(err).slice(0, 300),
      });
    }

    // схему проверяем ДО выдачи seq: отвергнутый кадр не должен оставлять дыру (инвариант 1)
    const candidate = { v: PROTOCOL_VERSION, ts: Date.now(), sessionId, seq: 0, ...draft };
    const parsed = EventSchema.safeParse(candidate);
    if (!parsed.success) {
      const errFrame = {
        v: PROTOCOL_VERSION, ts: Date.now(), sessionId,
        seq: entry.seq.take(),
        type: 'event:error', code: 'FRAME_SCHEMA',
        message: `кадр не прошёл схему: ${draft.type}: ${parsed.error.message.slice(0, 300)}`,
      } satisfies Event;
      this.broadcast(errFrame);
      this.persistHook?.();
      return;
    }
    const frame = { ...parsed.data, seq: entry.seq.take() } as Event;
    if (frame.type === 'event:permission.request') entry.pending.set(frame.requestId, frame);
    this.broadcast(frame);
    this.persistHook?.();
  }

  private deriveState(sessionId: string, draft: EventDraft): void {
    const s = this.sessions.get(sessionId);
    switch (draft.type) {
      case 'event:session.init': {
        if (s && draft.claudeSessionId) s.info.claudeSessionId = draft.claudeSessionId;
        // init приходит лениво — нередко уже после нашего send (ход идёт): idle только из initializing
        if (this.curState(sessionId) === 'initializing') this.setState(sessionId, 'idle');
        return;
      }
      case 'event:message.assistant':
      case 'event:stream.delta':
        // ход мог стартовать не от нашего send (resume, автоход) — активность ассистента = working
        if (this.curState(sessionId) === 'idle') this.setState(sessionId, 'working');
        return;
      case 'event:permission.request':
        this.setState(sessionId, 'waiting_permission', needsOf(draft));
        return;
      case 'event:permission.result': {
        s?.pending.delete(draft.requestId);
        if (this.curState(sessionId) !== 'waiting_permission') return;
        // параллельные карточки: пока висит хоть одна — ждём её, needs — по оставшейся
        const next = s ? [...s.pending.values()][0] : undefined;
        if (next) this.setState(sessionId, 'waiting_permission', needsOf(next));
        else this.setState(sessionId, 'working');
        return;
      }
      case 'event:turn.result':
        this.setState(sessionId, 'idle');
        return;
      case 'event:error':
        if (draft.code === 'ENGINE_EXIT' || draft.code === 'ENGINE_CRASH') this.setState(sessionId, 'dead');
        return;
      default:
        return;
    }
  }

  private curState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)?.info.state;
  }

  private setState(sessionId: string, to: SessionState, needs?: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const from = s.info.state;
    if (from === to && needs === undefined) return;
    if (from === to && needs === s.info.needs) return; // ничего не поменялось — кадр не нужен
    if (from !== to) assertTransition(from, to);
    s.info.state = to;
    if (needs !== undefined) s.info.needs = needs;
    if (to !== 'waiting_permission' && to !== 'waiting_input' && needs === undefined) s.info.needs = null;

    s.touchedAt = Date.now();
    // idle-reaping: простаивающую живую сессию останавливаем — сообщение поднимет через resume
    if (to === 'idle') this.armIdle(sessionId, s);
    else if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }

    this.broadcast({
      v: PROTOCOL_VERSION, ts: Date.now(), sessionId, seq: s.seq.take(),
      type: 'event:session.state', state: to,
      ...(s.info.needs !== null ? { needs: s.info.needs } : {}),
    });
    // seq ушёл вперёд — персист (коалесцируется на стороне supervisor'а)
    this.persistHook?.();
  }

  /** Таймер простоя: обычный idleTimeoutMs; разбуженной заранее без хода — короче (wakeIdleMs). */
  private armIdle(sessionId: string, s: Entry): void {
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    if (this.idleTimeoutMs <= 0 || !s.engine.isRunning) return;
    const ms = s.wokeUnused ? Math.min(this.idleTimeoutMs, this.live.wakeIdleMs) : this.idleTimeoutMs;
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (this.sessions.get(sessionId)?.info.state === 'idle') {
        void this.stop(sessionId).catch(() => undefined);
      }
    }, ms);
  }

  private broadcast(e: Event): void {
    for (const fn of this.subscribers) fn(e);
  }

  private require(sessionId: string): Entry {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    return s;
  }
}
