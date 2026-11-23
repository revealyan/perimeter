// Клиент supervisor'а в рендерере: WSS, реконнект с догоном по lastSeq,
// дедупликация по seq, живые карточки разрешений, запросы с ответом (ack/err по id).

import { PROTOCOL_VERSION, parseFrame, type CustomModel, type EffortLevel, type Event, type ModelInfoFrame, type StorageInfoFrame, type UsageInfo } from '@perimeter/protocol';
export type { UsageInfo, UsageWindow } from '@perimeter/protocol';
import {
  parseFsList, parseFsRead, parseGitStatus, parseNetPorts, parseTermInfo, parseTermList,
  type FsList, type FsRead, type GitStatus, type PortInfo, type TermInfo,
} from './lib/panelData';
import { chunkInput, clampSize } from './lib/termModel';
import { LOCAL, connections } from './connections';
import { cacheStore, type CachedMeta } from './cache';
import { playTurnDone, turnSoundMode } from './lib/sound';
import { attachOrphanResults, feedFits, feedSignature, mergeCachedFeed, toCachedSession, type CachedSession } from './lib/cacheModel';

/** closed — клиент закрыт намеренно (подключение выключено/удалено), не переподключается */
export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface QuestionInfo {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface PermissionCard {
  requestId: string;
  toolName: string;
  input: unknown;
  questions?: QuestionInfo[];
  /** когда пришёл запрос (для «ждёт N мин») */
  at: number;
}

export interface FeedItem {
  id: string;
  kind: 'user' | 'text' | 'thinking' | 'tool-use' | 'tool-result' | 'turn' | 'subagent' | 'permission-log' | 'error' | 'state';
  data: Record<string, unknown>;
  ts?: number;
}

export interface SessionView {
  id: string;
  name: string;
  state: string;
  needs: string | null;
  model?: string;
  permissionMode?: string;
  profile?: string;
  projectId?: string;
  archived?: boolean;
  /** усилие сессии; нет — по умолчанию аккаунта/модели */
  effort?: EffortLevel;
  /** ultracode включён для сессии */
  ultracode?: boolean;
  /** окно автокомпакта сессии (токены); нет — модели/аккаунта */
  compactWindow?: number;
  /** сессия-воркер (сквозной сабагент): id родительской сессии */
  parentSessionId?: string;
  /** чем порождён воркер (имя инструмента делегирования); справочно */
  agentOf?: string;
  /** сессия переехала в другую среду (архивная пометка «переехала → …») */
  movedTo?: string;
  /** сессия приехала из другой среды (плашка в ленте) */
  movedFrom?: string;
  /** epoch последней активности (для «активна N мин назад») */
  lastActivity: number;
  /**
   * Момент для порядка в сайдбаре: как lastActivity, но пока идёт ход — заморожен (иначе работающие сессии
   * и их проекты менялись местами на каждое событие потока). Сдвигают: твоё сообщение, конец хода, простой.
   */
  sortAt?: number;
  items: FeedItem[];
  permissions: PermissionCard[];
  printing: string | null;
  /** идёт ресинк ленты из транскрипта */
  resyncing?: boolean;
  /** история из транскрипта уже подтянута (грузится при открытии сессии, не всех сразу) */
  historyLoaded?: boolean;
  /** лента лежит в локальном кэше — откроется оттуда, а сервер дошлёт только новое (догон по seq) */
  cachedFeed?: boolean;
  /** запрос к модели не прошёл и повторяется (гаснет с первым ответом модели или концом хода) */
  retry?: { attempt: number; maxRetries: number; delayMs: number; status: number | null; error: string; at: number };
  lastResult?: { costUsd?: number; numTurns?: number; durationMs?: number; subtype?: string };
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  profile?: string;
  model?: string;
  permissionMode?: string;
}

/** Ответ cmd:session.export — всё, что нужно приёмной стороне для полного переноса. */
export interface ExportedSession {
  sessionId: string;
  /** транскрипт claude одним куском jsonl */
  transcript: string;
  /** HEAD источника на момент экспорта (база патча); null — не git-репозиторий */
  headCommit: string | null;
  /** патч незакоммиченных правок (tracked); null — правок нет */
  patch: string | null;
  /** новые файлы без git — патчем не едут, показываем предупреждением */
  untracked: string[];
  meta: {
    name: string; claudeSessionId: string; cwd: string;
    model?: string; permissionMode?: string; profile?: string;
    effort?: EffortLevel; ultracode?: boolean; projectId?: string;
  };
}

export interface ProfileInfo {
  name: string;
  displayName?: string;
  description?: string;
  model?: string;
  /** модели аккаунта (из Claude Code или ручной список); нет — ещё не получены */
  models?: ModelInfoFrame[];
  modelsSource?: 'auto' | 'manual';
  modelsAt?: number;
  defaultEffort?: EffortLevel;
  /** ultracode разрешён (false — кнопки нет) */
  ultracode?: boolean;
  /** делегирование сабагентов разрешено (сессии аккаунта получают инструмент delegate_to_agent) */
  delegate?: boolean;
  /** нативные субагенты (Task/Agent) видны; по умолчанию шлюзы — нет, Claude — да */
  nativeAgents?: boolean;
  /** лимит ответа обычно / на xhigh и выше; нет — по умолчанию Claude Code / как обычно */
  maxOutput?: number;
  maxOutputHigh?: number;
  /** список задач (TaskCreate…) у сессий аккаунта */
  tasks?: boolean;
  /** стандартные уровни усилия моделям без сведений */
  effortFallback?: boolean;
  /** окно автокомпакта по умолчанию у сессий аккаунта */
  compactWindow?: number;
  /** показывать лимиты (usage) */
  usage?: boolean;
  /** у аккаунта есть источник лимитов */
  usageSource?: 'claude' | 'zai';
  /** ключ API задан — последние символы («…UDPw»); сам ключ в клиент не приходит */
  keyHint?: string;
  /** ключ можно задать из настроек (шлюз вроде z.ai); у подписки Claude — нет */
  keyEditable?: boolean;
  /** хост шлюза аккаунта (api.z.ai) — ключ аккаунта можно отдать MCP-серверам этого домена */
  gatewayHost?: string;
  /** кто отдал список auto: provider — /v1/models провайдера, claude-code — запасной список Claude Code */
  modelsFrom?: 'provider' | 'claude-code';
  /** модели с контекстом 1M: Claude Code запускается с `<id>[1m]` */
  long?: string[];
  /** свои модели: та же модель с другим окном контекста (`glm-5.3@400k`) */
  custom?: CustomModel[];
  /** вход в Claude Code у аккаунта-подписки; loggedIn=false — «не вошёл · Войти» */
  auth?: { loggedIn: boolean; email?: string; plan?: string };
}

/** Шаблон аккаунта на ключе API. */
export type KeyTemplate = 'anthropic' | 'zai' | 'custom' | 'claude-token';

/** Ход входа в подписку Claude на сервере (event:profile.login). */
export interface LoginEvent {
  loginId: string;
  state: 'starting' | 'waiting' | 'verifying' | 'done' | 'failed' | 'cancelled';
  rbId?: string;
  url?: string;
  rbError?: string;
  profile?: string;
  email?: string;
  plan?: string;
  error?: string;
}

/** MCP-сервер аккаунта (секретов нет — только имена заголовков и переменных). */
export interface McpServer {
  name: string;
  transport: 'http' | 'sse' | 'stdio' | 'ws';
  target: string;
  status: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unknown';
  statusText: string;
  scope: 'user' | 'other';
  headerNames?: string[];
  envNames?: string[];
}

export type McpConfig =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

/** Строка общего списка MCP: сервер и у каких целей (аккаунтов с общим файлом настроек) включён. */
export interface McpSharedRow {
  name: string;
  transport: McpServer['transport'];
  target: string;
  headerNames?: string[];
  envNames?: string[];
  /** в копии — ключ аккаунта меткой: у каждого аккаунта подставляется свой */
  accountKey: boolean;
  /** копия уже есть у supervisor'а */
  stored: boolean;
  /** id цели → статус у неё; нет ключа — выключен */
  on: Record<string, { status: McpServer['status']; statusText: string }>;
}

export interface McpShared {
  /** цели: аккаунты с общим файлом настроек Claude Code (id — имя первого) */
  targets: Array<{ id: string; profiles: string[] }>;
  servers: McpSharedRow[];
  /** из проекта, плагина или claude.ai — не переключаются */
  other: Array<{ name: string; transport: McpServer['transport']; target: string; targets: string[] }>;
  /** стандартные наборы, которых не хватает (z.ai: поиск, чтение страниц, zread, изображения) */
  presets?: Array<{ id: 'zai'; missing: string[] }>;
}

export interface McpSharedResult { profile: string; ok: boolean; error?: string }

/** Поле установки из каталога MCP (ключ, адрес, путь…), которое заполняет человек. */
export interface McpField {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  choices?: string[];
}

/** Шаблон конфига из каталога: «{{ключ}}» — значение поля; необязательное пустое поле убирает заголовок/переменную/аргумент. */
export interface McpTemplate {
  type: 'http' | 'sse' | 'stdio';
  url?: string;
  headers?: { name: string; value: string }[];
  command?: string;
  args?: { tokens: string[]; field?: string }[];
  env?: { name: string; value: string }[];
}

/** Способ установки записи каталога: удалённый сервер или пакет, который запускается на сервере. */
export interface McpVariant {
  id: string;
  kind: 'remote' | 'npm' | 'pypi' | 'oci';
  label: string;
  template: McpTemplate;
  fields: McpField[];
  runtime?: 'npx' | 'uvx' | 'docker';
  /** почему на этом сервере не поставить («нет npx») */
  missing?: string;
}

/** Запись официального каталога MCP (registry.modelcontextprotocol.io). */
export interface McpCatalogEntry {
  id: string;
  title: string;
  description: string;
  version: string;
  publisher: string;
  repo?: string;
  website?: string;
  suggestedName: string;
  variants: McpVariant[];
  deprecated?: boolean;
}

/** Итог проверки ключа мини-запросом. */
export interface KeyCheck { ok: boolean; ms: number; status?: number; message?: string }

/** Откуда новый проект. */
export type ProjectSource = 'empty' | 'git' | 'existing';

export interface GitInfo { origin: string | null; branch: string | null; head?: string | null; changed: number }

/** Превью папки проекта в среде (cmd:project.inspect). */
export interface ProjectPlan {
  path: string;
  inStorage: boolean;
  exists: boolean;
  isDir: boolean;
  empty: boolean;
  git?: GitInfo;
  plan: 'create' | 'clone' | 'connect' | 'conflict' | 'missing';
  reason?: string;
}

/** Обзор проектов среды (cmd:project.scan). */
export interface ProjectScan {
  storage: StorageInfoFrame;
  projects: Array<{ id: string; name: string; path: string; exists: boolean; inStorage: boolean; git?: GitInfo }>;
  orphans: string[];
}

/** Правка не-секретной части аккаунта из настроек. */
export interface ProfilePatch {
  /** подпись аккаунта; null — убрать */
  displayName?: string | null;
  models?: ModelInfoFrame[];
  modelsSource?: 'auto' | 'manual';
  model?: string | null;
  /** модели с контекстом 1M (весь список) */
  long?: string[];
  /** свои модели (весь список) */
  custom?: CustomModel[];
  defaultEffort?: EffortLevel | null;
  ultracode?: boolean;
  /** делегирование: включить/выключить у аккаунта-родителя */
  delegate?: boolean;
  /** нативные субагенты (Task/Agent): показать/спрятать */
  nativeAgents?: boolean;
  /** лимит ответа обычно / на xhigh и выше; null — убрать */
  maxOutput?: number | null;
  maxOutputHigh?: number | null;
  tasks?: boolean;
  effortFallback?: boolean;
  /** окно автокомпакта по умолчанию; null — убрать */
  compactWindow?: number | null;
  /** показывать лимиты */
  usage?: boolean;
}

/** Поля сессии из кадров сервера (hello / session.list / ack настроек) → вид сессии. */
type SessionFields = { model?: string; permissionMode?: string; profile?: string; projectId?: string; archived?: boolean; effort?: EffortLevel; ultracode?: boolean; compactWindow?: number; parentSessionId?: string; agentOf?: string; movedTo?: string; movedFrom?: string };
function applySessionFields(v: SessionView, s: SessionFields): void {
  if (s.model) v.model = s.model;
  if (s.permissionMode) v.permissionMode = s.permissionMode;
  if (s.profile) v.profile = s.profile;
  if (s.projectId) v.projectId = s.projectId;
  // усилие и ultracode сервер присылает, когда они заданы: отсутствие = сброшены
  if (s.effort !== undefined) v.effort = s.effort;
  else delete v.effort;
  v.ultracode = s.ultracode === true;
  if (s.compactWindow !== undefined) v.compactWindow = s.compactWindow;
  else delete v.compactWindow;
  // воркер делегирования: отсутствие полей = обычная сессия (не залипает после потери родителя)
  if (s.parentSessionId) v.parentSessionId = s.parentSessionId;
  else delete v.parentSessionId;
  if (s.agentOf) v.agentOf = s.agentOf;
  else delete v.agentOf;
  // пометки переезда между средами: отсутствие = сброшено
  if (s.movedTo) v.movedTo = s.movedTo;
  else delete v.movedTo;
  if (s.movedFrom) v.movedFrom = s.movedFrom;
  else delete v.movedFrom;
}

/** Человекочитаемое имя профиля (в UI всегда оно). */
export function profileLabel(p: { name: string; displayName?: string }): string {
  return p.displayName ?? p.name;
}

type Reply = { id: string; ok: boolean; data?: unknown; code?: string; message?: string };

/**
 * Среда = подключение: 'local' (этот компьютер, есть всегда) или id VPS-подключения ('vps' — первое, как раньше,
 * дальше 'c-…'). Подписи и список — в connections.ts.
 */
export type EnvId = string;
export { LOCAL, envLabel, envShort, isRemote } from './connections';

/** Среда последней выбранной сессии. */
export function loadActiveEnv(): EnvId {
  return localStorage.getItem('perimeter:env') ?? 'vps';
}

/**
 * С кем синкаются проекты среды: этот компьютер ↔ каждый VPS (1-1). У VPS — только этот компьютер,
 * у этого компьютера — все включённые VPS.
 */
export function syncPeers(env: EnvId): EnvId[] {
  if (env !== LOCAL) return [LOCAL];
  return connections.list.filter((c) => c.kind === 'vps' && c.enabled).map((c) => c.id);
}

/** Проект другой среды, которого нет в текущей: предложение привязать к папке здесь. */
export interface SyncSuggestion {
  name: string;
  /** путь в другой среде — для справки, здесь не используется */
  otherPath: string;
  otherEnv: EnvId;
  profile?: string;
  model?: string;
  permissionMode?: string;
}

/** Снимок проектов среды (localStorage) — чтобы синк работал и после перезапуска приложения. */
export function loadEnvProjects(env: EnvId): ProjectInfo[] {
  try {
    const raw = JSON.parse(localStorage.getItem(`perimeter:projects:${env}`) ?? '[]') as unknown;
    return Array.isArray(raw) ? (raw as ProjectInfo[]).filter((p) => typeof p?.name === 'string' && typeof p?.path === 'string') : [];
  } catch {
    return [];
  }
}

/** Чего не хватает в текущей среде относительно другой (по имени, без учёта регистра). */
export function computeSyncSuggestions(here: ProjectInfo[], other: ProjectInfo[], otherEnv: EnvId, dismissed: string[] = []): SyncSuggestion[] {
  const have = new Set(here.map((p) => p.name.trim().toLowerCase()));
  const skip = new Set(dismissed.map((n) => n.toLowerCase()));
  return other
    .filter((p) => !have.has(p.name.trim().toLowerCase()) && !skip.has(p.name.trim().toLowerCase()))
    .map((p) => ({
      name: p.name, otherPath: p.path, otherEnv,
      ...(p.profile !== undefined ? { profile: p.profile } : {}),
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.permissionMode !== undefined ? { permissionMode: p.permissionMode } : {}),
    }));
}

/** Ошибка команды: код supervisor'а + текст. */
export class CmdError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Правка аккаунта: ответ идёт тем же сокетом, что и истории сессий, — через медленный туннель
 * (~150 КБ/с до VPS) он может стоять в очереди за мегабайтами транскриптов. Ждём дольше.
 */
const PROFILE_TIMEOUT_MS = 30_000;
/** Команды панелей: старый supervisor молча игнорирует незнакомый тип — не держим UI 15 с. */
const PANEL_TIMEOUT_MS = 8_000;

/** Событие удалённого браузера (по rbId, вне seq сессии). */
export type RbEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'state'; url: string; title: string; loading: boolean; canGoBack?: boolean; canGoForward?: boolean }
  | { type: 'exit'; reason?: string };

/** Поток терминала: вывод или выход процесса (адресуется по termId, вне seq сессии). */
export type TermEvent = { type: 'output'; data: string } | { type: 'exit'; code: number | null };
/** Вывод терминала без подписчика (ответ на open/attach ещё не разобран) — копим немного. */
const ORPHAN_MAX_BYTES = 64 * 1024;
const ORPHAN_MAX_TERMS = 8;

export class SupervisorClient {
  status: ConnStatus = 'connecting';
  url = '';
  sessions = new Map<string, SessionView>();
  activeId: string | null = null;
  serverVersion = '';
  profiles: ProfileInfo[] = [];
  projects: ProjectInfo[] = [];
  pool: { warm: number; target: number } | null = null;
  /** хранилище проектов среды (из hello): куда по имени создаются новые проекты */
  storage: StorageInfoFrame | null = null;
  /** текст последней ошибки для тоста; гаснет сам */
  lastError = '';
  /** последний снимок контекста по сессии (для кольца правой панели) */
  contextBySession = new Map<string, Record<string, unknown>>();
  /** лимиты аккаунтов (usage): последнее известное + пояснение, когда данных нет */
  usage = new Map<string, { usage: UsageInfo | null; note?: string }>();
  private usageInFlight = new Map<string, Promise<void>>();

  /**
   * Среда клиента — id подключения ('local' — этот компьютер, остальные — VPS через свой ssh-туннель).
   * Фиксирована на всю жизнь экземпляра: приложение держит по клиенту на подключение, все подключены сразу.
   */
  readonly environment: EnvId;
  /** Проекты этой среды сохранились — другие среды пересчитывают предложения синка (связывает App). */
  onProjectsChanged: (() => void) | null = null;
  /** список показан из локального кэша — hello ещё не пришёл */
  fromCache = false;

  constructor(env?: EnvId, url?: string) {
    this.environment = env ?? loadActiveEnv();
    this.url = url ?? connections.get(this.environment)?.wsUrl ?? (this.environment === LOCAL ? 'ws://127.0.0.1:8791' : 'ws://127.0.0.1:8790');
    this.hydrating = this.startHydrate();
  }

  // ─── локальный кэш (IndexedDB) ────────────────────────────────────────────

  /** Чтение кэша при старте; hello ждёт его (до 1,5 с), чтобы отправить seq кэшированных лент. */
  private hydrating: Promise<void> | null = null;
  private feedSigs = new Map<string, string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private startHydrate(): Promise<void> | null {
    if (typeof indexedDB === 'undefined') return null;
    const p: Promise<void> = cacheStore.load(this.environment).then(
      (c) => { if (c) this.applyCache(c.meta, c.heads); },
      () => undefined,
    ).finally(() => { if (this.hydrating === p) this.hydrating = null; });
    return p;
  }

  /** Снимок из кэша — только если сервер ещё не ответил (hello свежее кэша). */
  private applyCache(meta: CachedMeta, heads: Map<string, number>): void {
    if (this.serverVersion || this.sessions.size > 0) return;
    this.fromCache = true;
    this.profiles = meta.profiles as ProfileInfo[];
    this.projects = meta.projects as ProjectInfo[];
    this.storage = (meta.storage ?? null) as StorageInfoFrame | null;
    for (const c of meta.sessions) {
      const v = this.ensure(c.id, c.name);
      v.state = c.state;
      v.needs = c.needs;
      v.lastActivity = c.lastActivity;
      applySessionFields(v, c as SessionFields);
      v.archived = c.archived === true;
      const seq = heads.get(c.id);
      if (seq !== undefined) {
        v.cachedFeed = true;
        // этот seq уйдёт в hello: сервер пришлёт только события после него
        this.lastSeq.set(c.id, seq);
      }
    }
    if (!this.activeId && meta.activeId && this.sessions.has(meta.activeId)) this.activeId = meta.activeId;
    if (this.activeId) this.ensureHistory(this.activeId);
    this.refreshSync();
    this.notify();
  }

  /** Открыть ленту из кэша; кэша не оказалось — как раньше, из транскрипта. */
  private loadCachedFeed(sid: string): void {
    const s = this.sessions.get(sid);
    if (!s || s.resyncing) return;
    s.resyncing = true;
    let fallback = false;
    cacheStore.loadFeed<FeedItem>(this.environment, sid).then((feed) => {
      const v = this.sessions.get(sid);
      if (!v || v.historyLoaded) return;
      if (feed && v.cachedFeed) {
        v.items = attachOrphanResults(mergeCachedFeed(feed, v.items));
        v.historyLoaded = true;
        this.feedSigs.set(sid, feedSignature(feed.items, feed.lastSeq));
      } else {
        // в hello ушёл seq кэша, а ленты нет — пришедшего догона мало, нужен полный транскрипт
        v.cachedFeed = false;
        v.items = [];
        fallback = true;
      }
    }, () => { fallback = true; }).finally(() => {
      const v = this.sessions.get(sid);
      if (v) v.resyncing = false;
      if (fallback && v) {
        v.cachedFeed = false;
        this.lastSeq.delete(sid);
        if (this.status === 'live') this.resync(sid);
      }
      this.notify();
    });
  }

  /** Лента ушла из кэша (ресинк, регресс seq) — следующее открытие пойдёт за транскриптом. */
  private forgetFeed(s: SessionView): void {
    s.items = [];
    s.printing = null;
    s.historyLoaded = false;
    s.cachedFeed = false;
    this.lastSeq.delete(s.id);
    this.feedSigs.delete(s.id);
    void cacheStore.dropFeed(this.environment, s.id);
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.hydrating || typeof indexedDB === 'undefined') return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.saveCache(); }, 2000);
  }

  /** Сохранить снимок подключения и изменившиеся ленты (только полные — с историей и seq). */
  private async saveCache(): Promise<void> {
    if (this.fromCache || !this.serverVersion) return;
    const env = this.environment;
    await cacheStore.saveMeta(env, {
      savedAt: Date.now(),
      activeId: this.activeId,
      sessions: [...this.sessions.values()].map((v) => toCachedSession(v as unknown as CachedSession & Record<string, unknown>)),
      profiles: this.profiles,
      projects: this.projects,
      storage: this.storage,
    });
    for (const v of [...this.sessions.values()]) {
      if (!v.historyLoaded || v.resyncing) continue;
      const seq = this.lastSeq.get(v.id);
      if (seq === undefined) continue; // без seq догон невозможен — такую ленту не кэшируем
      const sig = feedSignature(v.items, seq);
      if (this.feedSigs.get(v.id) === sig) continue;
      this.feedSigs.set(v.id, sig);
      if (feedFits(v.items) === null) continue;
      await cacheStore.saveFeed(env, v.id, { lastSeq: seq, items: v.items, savedAt: Date.now() });
    }
  }

  /** Адрес подключения поменялся (правка в настройках, туннель на другом порту) — переподключиться. */
  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    if (this.running) { this.close(); this.connect(); }
  }

  private ws: WebSocket | null = null;
  private lastSeq = new Map<string, number>();
  private cmdId = 0;
  private localId = 0;
  private listeners = new Set<() => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 500;
  private closed = false;
  private pending = new Map<string, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private termListeners = new Map<string, Set<(e: TermEvent) => void>>();
  private termOrphans = new Map<string, { events: TermEvent[]; bytes: number }>();
  private connectListeners = new Set<() => void>();
  private rbListeners = new Map<string, Set<(e: RbEvent) => void>>();
  /** подписчики хода входа в подписку (окно «Добавить аккаунт») */
  private loginListeners = new Set<(e: LoginEvent) => void>();
  /** кадр пришёл раньше подписки (до ответа на rb.open) — отдать подписчику, иначе сервер ждёт подтверждения */
  private rbOrphan = new Map<string, RbEvent>();

  /**
   * Синк проектов между средами: проект связан по ИМЕНИ, путь у каждой среды свой
   * (/opt/perimeter на VPS и C:\devs\perimeter на этом компьютере — это один проект).
   * Проекты другой среды, которых нет здесь, — предложения «привязать папку»; сами не создаются.
   */
  syncSuggestions: SyncSuggestion[] = [];

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Коалесценция перерисовок (рецепт рендера Claude Code): мутации хранилища
   * применяются сразу, а UI-флаш — один на кадр. rAF не срабатывает, пока окно
   * перекрыто/свёрнуто (даже при document.hidden === false), поэтому страхуемся таймером:
   * что наступит раньше — то и флашит.
   */
  private notifyScheduled = false;
  notify(): void {
    this.scheduleSave();
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    let done = false;
    const flush = () => {
      if (done) return;
      done = true;
      this.notifyScheduled = false;
      for (const fn of this.listeners) fn();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    setTimeout(flush, 50);
  }

  connect(): void {
    this.closed = false;
    if (this.status !== 'reconnecting') this.status = 'connecting';
    this.notify();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.reconnect();
      return;
    }
    this.ws = ws;
    // обработчики привязаны к своему сокету: старый сокет после close() не трогает состояние
    const hello = () => {
      if (this.ws !== ws) return;
      this.status = 'live';
      this.retryDelay = 500;
      const lastSeq: Record<string, number> = {};
      for (const [sid, s] of this.lastSeq) lastSeq[sid] = s;
      this.send({ type: 'cmd:hello', lastSeq });
      // подписки по termId на сервере живут в соединении — после реконнекта панели подключаются заново
      for (const fn of [...this.connectListeners]) {
        try { fn(); } catch { /* слушатель не роняет транспорт */ }
      }
      this.notify();
    };
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // кэш ещё читается — подождать его (seq лент из кэша должны попасть в hello), но не дольше 1,5 с
      if (this.hydrating) void Promise.race([this.hydrating, new Promise((r) => setTimeout(r, 1500))]).then(hello);
      else hello();
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.handle(String(ev.data)); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending('нет связи с supervisor');
      if (!this.closed) this.reconnect();
    };
    ws.onerror = () => { /* close последует */ };
  }

  private reconnect(): void {
    if (this.retryTimer || this.closed) return;
    this.status = 'reconnecting';
    this.notify();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, 10000);
      this.connect();
    }, this.retryDelay);
  }

  /** Переподключиться сейчас (кнопка «повторить»), без ожидания backoff. */
  reconnectNow(): void {
    if (this.status === 'live') return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retryDelay = 500;
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null; // onclose старого сокета теперь no-op
    ws?.close();
    this.failPending('клиент закрыт');
    // иначе выключенное подключение так и числилось бы «на связи»
    if (this.status !== 'closed') { this.status = 'closed'; this.notify(); }
  }

  /** Подключён или подключается (сокет открыт либо ждёт повтора). */
  get running(): boolean {
    return !this.closed && (this.ws !== null || this.retryTimer !== null);
  }

  /** Подключиться, если ещё не подключены (повторный вызов не плодит второй сокет). */
  ensureConnected(): void {
    if (!this.running) this.connect();
  }

  // ─── удалённый браузер (ретрансляция) ─────────────────────────────────────

  private onRbFrame(f: { type: string; rbId: string } & Record<string, unknown>): void {
    const subs = this.rbListeners.get(f.rbId);
    const ev: RbEvent = f.type === 'event:rb.frame'
      ? { type: 'frame', data: String(f['data']), width: Number(f['width']), height: Number(f['height']) }
      : f.type === 'event:rb.state'
        ? {
            type: 'state', url: String(f['url'] ?? ''), title: String(f['title'] ?? ''), loading: f['loading'] === true,
            ...(typeof f['canGoBack'] === 'boolean' ? { canGoBack: f['canGoBack'] } : {}),
            ...(typeof f['canGoForward'] === 'boolean' ? { canGoForward: f['canGoForward'] } : {}),
          }
        : { type: 'exit', ...(typeof f['reason'] === 'string' ? { reason: f['reason'] } : {}) };
    if (!subs || subs.size === 0) {
      if (ev.type === 'frame') {
        if (this.rbOrphan.size > 8) this.rbOrphan.delete(this.rbOrphan.keys().next().value!);
        this.rbOrphan.set(f.rbId, ev);
      }
      return;
    }
    for (const fn of [...subs]) {
      try { fn(ev); } catch { /* подписчик не роняет транспорт */ }
    }
  }

  /** Подписка на кадры/состояние удалённого браузера. */
  onRb(rbId: string, cb: (e: RbEvent) => void): () => void {
    let set = this.rbListeners.get(rbId);
    if (!set) { set = new Set(); this.rbListeners.set(rbId, set); }
    set.add(cb);
    const early = this.rbOrphan.get(rbId);
    if (early) {
      this.rbOrphan.delete(rbId);
      queueMicrotask(() => { if (set!.has(cb)) cb(early); });
    }
    return () => { set!.delete(cb); if (set!.size === 0) this.rbListeners.delete(rbId); };
  }

  /** Запустить браузер на машине supervisor'а. Первый запуск Chromium — несколько секунд. */
  async rbOpen(o: { url?: string; width: number; height: number; quality?: number }): Promise<{ rbId: string; url: string; title: string }> {
    // кадры по подтверждению: на медленном туннеле задержка не копится (следующий — после rbAck)
    const r = await this.request({ type: 'cmd:rb.open', ...o, ackFrames: true }, 45_000);
    return r.data as { rbId: string; url: string; title: string };
  }

  async rbList(): Promise<Array<{ rbId: string; url: string; title: string; width: number; height: number }>> {
    const r = await this.request({ type: 'cmd:rb.list' }, PANEL_TIMEOUT_MS);
    return (r.data as { browsers?: Array<{ rbId: string; url: string; title: string; width: number; height: number }> } | undefined)?.browsers ?? [];
  }

  async rbAttach(rbId: string): Promise<{ rbId: string; url: string; title: string }> {
    const r = await this.request({ type: 'cmd:rb.attach', rbId, ackFrames: true }, PANEL_TIMEOUT_MS);
    return r.data as { rbId: string; url: string; title: string };
  }

  rbNavigate(rbId: string, to: { url?: string; action?: 'back' | 'forward' | 'reload' | 'stop' }): void {
    void this.request({ type: 'cmd:rb.navigate', rbId, ...to }, PANEL_TIMEOUT_MS).catch((e: unknown) => this.showError(`Браузер: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Ввод — без ожидания ответа (движения мыши идут десятками в секунду). */
  rbInput(rbId: string, input: Record<string, unknown>): void {
    this.send({ type: 'cmd:rb.input', rbId, input });
  }

  /** Кадр показан — можно следующий (без ответа). */
  rbAck(rbId: string): void {
    this.send({ type: 'cmd:rb.ack', rbId });
  }

  rbResize(rbId: string, width: number, height: number): void {
    this.send({ type: 'cmd:rb.resize', rbId, width, height });
  }

  rbClose(rbId: string): void {
    this.send({ type: 'cmd:rb.close', rbId });
  }

  /** Запомнить проекты этой среды, пересчитать предложения синка и сообщить другой среде. */
  private refreshSync(): void {
    localStorage.setItem(`perimeter:projects:${this.environment}`, JSON.stringify(this.projects));
    this.recomputeSync();
    this.onProjectsChanged?.();
  }

  /** Предложения синка по свежим снимкам проектов парных сред (они могли подключиться позже). */
  recomputeSync(): void {
    let dismissed: string[] = [];
    try { dismissed = JSON.parse(localStorage.getItem(`perimeter:sync-dismissed:${this.environment}`) ?? '[]') as string[]; } catch { dismissed = []; }
    const seen = new Set<string>();
    const out: SyncSuggestion[] = [];
    for (const peer of syncPeers(this.environment)) {
      for (const sug of computeSyncSuggestions(this.projects, loadEnvProjects(peer), peer, dismissed)) {
        const k = sug.name.trim().toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(sug); }
      }
    }
    this.syncSuggestions = out;
    this.notify();
  }

  /** Привязать проект другой среды к папке здесь (создаёт проект с тем же именем и дефолтами). */
  async linkProject(sug: SyncSuggestion, path: string): Promise<boolean> {
    const id = await this.newProject(sug.name, path, {
      ...(sug.profile !== undefined ? { profile: sug.profile } : {}),
      ...(sug.model !== undefined ? { model: sug.model } : {}),
      ...(sug.permissionMode !== undefined ? { permissionMode: sug.permissionMode } : {}),
    });
    return id !== null;
  }

  /** «Не предлагать» — проект другой среды здесь не нужен. */
  dismissSync(name: string): void {
    const key = `perimeter:sync-dismissed:${this.environment}`;
    let list: string[] = [];
    try { list = JSON.parse(localStorage.getItem(key) ?? '[]') as string[]; } catch { list = []; }
    if (!list.includes(name)) list.push(name);
    localStorage.setItem(key, JSON.stringify(list));
    this.recomputeSync();
  }

  // ─── транспорт ────────────────────────────────────────────────────────────

  private nextId(): string {
    this.cmdId += 1;
    return `ui-${this.cmdId}`;
  }

  /** Отправить команду без ожидания ответа; шапку (v/ts/id) добавляем сами. */
  send(frame: Record<string, unknown>): string {
    const id = typeof frame['id'] === 'string' ? frame['id'] : this.nextId();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...frame, id }));
    }
    return id;
  }

  /** Команда с ответом: резолвится ack, реджектится err/таймаутом/обрывом. */
  request(frame: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CmdError('OFFLINE', 'нет связи с supervisor'));
    }
    const id = this.nextId();
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CmdError('TIMEOUT', 'supervisor не ответил вовремя'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...frame, id });
    });
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CmdError('OFFLINE', reason));
    }
    this.pending.clear();
  }

  /** Команда «выстрелил и забыл», но ошибка — в тост. */
  private fire(frame: Record<string, unknown>, what: string): Promise<Reply | null> {
    return this.request(frame).catch((e: unknown) => {
      this.showError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
  }

  showError(msg: string): void {
    this.lastError = msg;
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => { this.lastError = ''; this.notify(); }, 8000);
    this.notify();
  }

  dismissError(): void {
    this.lastError = '';
    this.notify();
  }

  select(id: string | null): void {
    this.activeId = id;
    if (id) this.ensureHistory(id);
    this.notify();
  }

  /** Подтянуть историю сессии из транскрипта, если её ещё нет (при открытии сессии). */
  ensureHistory(sid: string): void {
    const s = this.sessions.get(sid);
    if (!s || s.historyLoaded || s.resyncing) return;
    if (s.cachedFeed) { this.loadCachedFeed(sid); return; }
    if (this.status === 'live') this.resync(sid);
  }

  // ─── команды ──────────────────────────────────────────────────────────────

  /** Создать сессию; резолвится её id (null — ошибка, уже показана тостом). Новая сессия становится активной. */
  async newSession(opts?: { profile?: string; projectId?: string; name?: string; model?: string; permissionMode?: string; effort?: EffortLevel; ultracode?: boolean }): Promise<string | null> {
    const name = opts?.name ?? `сессия ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    const r = await this.fire({
      type: 'cmd:session.new', name,
      ...(opts?.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts?.ultracode ? { ultracode: true } : {}),
      ...(opts?.profile !== undefined ? { profile: opts.profile } : {}),
      ...(opts?.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    }, 'Не удалось создать сессию');
    const sid = (r?.data as { sessionId?: string } | undefined)?.sessionId;
    if (!sid) return null;
    const s = this.ensure(sid, name);
    s.name = name;
    const project = opts?.projectId ? this.projects.find((p) => p.id === opts.projectId) : undefined;
    const profile = opts?.profile ?? project?.profile;
    if (profile) s.profile = profile;
    if (opts?.projectId) s.projectId = opts.projectId;
    s.model ??= opts?.model ?? project?.model;
    s.permissionMode ??= opts?.permissionMode ?? project?.permissionMode;
    if (opts?.effort !== undefined) s.effort = opts.effort;
    if (opts?.ultracode) s.ultracode = true;
    // новая сессия: подтягивать из транскрипта нечего — иначе ответ ресинка затрёт первое сообщение в ленте
    s.historyLoaded = true;
    this.select(sid);
    void this.refreshSessions();
    return sid;
  }

  /** Сводка сессий с сервера (имена/профили/проекты) — после создания и форка. */
  async refreshSessions(): Promise<void> {
    const r = await this.request({ type: 'cmd:session.list' }).catch(() => null);
    const list = (r?.data as { sessions?: Array<{ id: string; name: string; state: string; needs?: string | null } & SessionFields> } | undefined)?.sessions;
    if (!list) return;
    for (const s of list) {
      const v = this.ensure(s.id, s.name);
      v.name = s.name;
      applySessionFields(v, s);
      v.archived = s.archived === true;
    }
    this.notify();
  }

  /** Создать проект; резолвится id проекта (null при ошибке). Обновляет список. */
  async newProject(name: string, path: string, opts?: { profile?: string; model?: string; permissionMode?: string }): Promise<string | null> {
    const r = await this.fire({
      type: 'cmd:project.new', name, path,
      ...(opts?.profile !== undefined ? { profile: opts.profile } : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    }, 'Не удалось создать проект');
    const project = (r?.data as { project?: ProjectInfo } | undefined)?.project;
    if (!project) return null;
    if (!this.projects.some((p) => p.id === project.id)) this.projects = [...this.projects, project];
    this.refreshSync();
    this.notify();
    return project.id;
  }

  // ─── хранилище и проекты ─────────────────────────────────────────────────

  /** Сменить папку хранилища среды (нет — supervisor создаст). */
  async setStorage(root: string): Promise<StorageInfoFrame> {
    const r = await this.request({ type: 'cmd:storage.set', root }, PROFILE_TIMEOUT_MS);
    const st = (r.data as { storage?: StorageInfoFrame } | undefined)?.storage;
    if (!st) throw new CmdError('BAD_REPLY', 'supervisor не вернул хранилище');
    this.storage = st;
    this.notify();
    return st;
  }

  /** Что станет с папкой проекта в этой среде — без побочных эффектов. */
  async inspectProject(q: { source: ProjectSource; slug?: string; path?: string; gitUrl?: string }): Promise<ProjectPlan> {
    const r = await this.request({ type: 'cmd:project.inspect', ...q }, PROFILE_TIMEOUT_MS);
    return r.data as ProjectPlan;
  }

  /** Создать проект: папка по имени в хранилище, клон git или готовая папка. Клон может идти минутами. */
  async createProject(o: { name: string; source: ProjectSource; slug?: string; path?: string; gitUrl?: string; profile?: string; model?: string; permissionMode?: string }): Promise<{ project: ProjectInfo; action: string; path: string }> {
    const r = await this.request({ type: 'cmd:project.create', ...o }, o.source === 'git' ? 11 * 60_000 : PROFILE_TIMEOUT_MS);
    const d = r.data as { project?: ProjectInfo; action?: string; path?: string } | undefined;
    if (!d?.project) throw new CmdError('BAD_REPLY', 'supervisor не вернул проект');
    if (!this.projects.some((p) => p.id === d.project!.id)) this.projects = [...this.projects, d.project];
    this.refreshSync();
    this.notify();
    return { project: d.project, action: d.action ?? 'created', path: d.path ?? d.project.path };
  }

  /** Обзор проектов среды для настроек. */
  async scanProjects(): Promise<ProjectScan> {
    const r = await this.request({ type: 'cmd:project.scan' }, PROFILE_TIMEOUT_MS);
    const d = r.data as ProjectScan;
    if (d?.storage) { this.storage = d.storage; this.notify(); }
    return d;
  }

  /** Создать пропавшую папку проекта. */
  async mkdirProject(projectId: string): Promise<void> {
    await this.request({ type: 'cmd:project.mkdir', projectId }, PROFILE_TIMEOUT_MS);
  }

  /** Убрать проект из списка (папка остаётся на диске). */
  async deleteProject(projectId: string): Promise<void> {
    await this.request({ type: 'cmd:project.delete', projectId }, PROFILE_TIMEOUT_MS);
    this.projects = this.projects.filter((p) => p.id !== projectId);
    this.refreshSync();
    this.notify();
  }

  /** Смена настроек живой сессии: модель/режим/усилие/ultracode на лету, профиль между ходами. effort: null — по умолчанию. */
  async setSessionSettings(sid: string, s: { model?: string; permissionMode?: string; profile?: string; effort?: EffortLevel | null; ultracode?: boolean; compactWindow?: number | null }): Promise<boolean> {
    const r = await this.fire({
      type: 'cmd:session.settings', sessionId: sid,
      ...(s.model !== undefined ? { model: s.model } : {}),
      ...(s.permissionMode !== undefined ? { permissionMode: s.permissionMode } : {}),
      ...(s.profile !== undefined ? { profile: s.profile } : {}),
      ...(s.effort !== undefined ? { effort: s.effort } : {}),
      ...(s.ultracode !== undefined ? { ultracode: s.ultracode } : {}),
      ...(s.compactWindow !== undefined ? { compactWindow: s.compactWindow } : {}),
    }, 'Настройки сессии не применились');
    const upd = (r?.data as { session?: { id: string } & SessionFields } | undefined)?.session;
    const v = this.sessions.get(sid);
    if (upd && v) {
      applySessionFields(v, upd);
      this.notify();
    }
    return r !== null;
  }

  /** Заменить профиль в списке (ответ supervisor'а на правку/обновление моделей). */
  private putProfile(p: ProfileInfo): void {
    const i = this.profiles.findIndex((x) => x.name === p.name);
    this.profiles = i < 0 ? [...this.profiles, p] : this.profiles.map((x, j) => (j === i ? p : x));
    this.notify();
  }

  /**
   * Модели аккаунта; refresh — спросить у Claude Code заново (поднимает claude на несколько секунд).
   * Ошибка — исключение с текстом supervisor'а (настройки показывают его у аккаунта).
   */
  /**
   * Лимиты аккаунта (usage). Повторный вызов, пока первый идёт, ждёт его же; ошибки молча — лимиты справочные.
   * refresh — спросить источник заново (иначе supervisor отдаёт свежее минуты из памяти).
   */
  loadUsage(profile: string, refresh = false): Promise<void> {
    const cur = this.usageInFlight.get(profile);
    if (cur) return cur;
    const p = this.request({ type: 'cmd:profile.usage', profile, ...(refresh ? { refresh: true } : {}) }, 40_000).then(
      (r) => {
        const d = r.data as { usage?: UsageInfo | null; note?: string } | undefined;
        this.usage.set(profile, { usage: d?.usage ?? null, ...(d?.note ? { note: d.note } : {}) });
        this.notify();
      },
      () => undefined,
    ).finally(() => { this.usageInFlight.delete(profile); });
    this.usageInFlight.set(profile, p);
    return p;
  }

  async profileModels(profile: string, refresh = false): Promise<ProfileInfo> {
    const r = await this.request({ type: 'cmd:profile.models', profile, ...(refresh ? { refresh: true } : {}) }, refresh ? 60_000 : PROFILE_TIMEOUT_MS);
    const p = (r.data as { profile?: ProfileInfo } | undefined)?.profile;
    if (!p) throw new CmdError('BAD_REPLY', 'supervisor не вернул профиль');
    this.putProfile(p);
    return p;
  }

  /**
   * Новый ключ API аккаунта: уходит в supervisor своей среды и пишется в env профиля; обратно не возвращается.
   * Простаивающие сессии аккаунта supervisor останавливает — следующее сообщение поднимет их с новым ключом.
   */
  async setProfileKey(profile: string, apiKey: string): Promise<{ profile: ProfileInfo; restarted: number; busy: number }> {
    const r = await this.request({ type: 'cmd:profile.update', profile, apiKey }, PROFILE_TIMEOUT_MS);
    const d = r.data as { profile?: ProfileInfo; restarted?: number; busy?: number } | undefined;
    if (!d?.profile) throw new CmdError('BAD_REPLY', 'supervisor не вернул профиль');
    this.putProfile(d.profile);
    return { profile: d.profile, restarted: d.restarted ?? 0, busy: d.busy ?? 0 };
  }

  /** Новый аккаунт на ключе API по шаблону; ключ только уходит на сервер. */
  async addKeyProfile(o: { name: string; displayName?: string; template: KeyTemplate; baseUrl?: string; apiKey: string }): Promise<ProfileInfo> {
    const r = await this.request({ type: 'cmd:profile.add', ...o }, PROFILE_TIMEOUT_MS);
    const p = (r.data as { profile?: ProfileInfo } | undefined)?.profile;
    if (!p) throw new CmdError('BAD_REPLY', 'supervisor не вернул профиль');
    this.putProfile(p);
    return p;
  }

  /** Проверить ключ мини-запросом: черновика (шаблон + ключ) или существующего аккаунта. */
  async checkKey(o: { profile?: string; template?: KeyTemplate; baseUrl?: string; apiKey?: string }): Promise<KeyCheck> {
    const r = await this.request({ type: 'cmd:profile.check', ...o }, 30_000);
    return (r.data ?? { ok: false, ms: 0, message: 'пустой ответ' }) as KeyCheck;
  }

  /** Начать вход в подписку Claude на сервере (новый аккаунт или существующий profile). Ссылка ждётся до 30 с. */
  async loginStart(o: { profile?: string; name?: string; displayName?: string; width: number; height: number }): Promise<{ loginId: string; rbId?: string; url?: string }> {
    const r = await this.request({ type: 'cmd:profile.login.start', ...o }, 60_000);
    return r.data as { loginId: string; rbId?: string; url?: string };
  }

  /** Выпустить токен подписки (`claude setup-token`) на машине этого supervisor'а — у локального вход в браузере владельца. */
  async tokenStart(): Promise<{ loginId: string; url?: string }> {
    const r = await this.request({ type: 'cmd:profile.token.start' }, 60_000);
    return r.data as { loginId: string; url?: string };
  }

  /** Забрать выпущенный токен — один раз. */
  async tokenTake(loginId: string): Promise<string> {
    const r = await this.request({ type: 'cmd:profile.token.take', loginId }, PROFILE_TIMEOUT_MS);
    return String((r.data as { token?: string } | undefined)?.token ?? '');
  }

  async loginCode(loginId: string, code: string): Promise<void> {
    await this.request({ type: 'cmd:profile.login.code', loginId, code }, PROFILE_TIMEOUT_MS);
  }

  loginCancel(loginId: string): void {
    void this.request({ type: 'cmd:profile.login.cancel', loginId }, PROFILE_TIMEOUT_MS).catch(() => undefined);
  }

  onLogin(cb: (e: LoginEvent) => void): () => void {
    this.loginListeners.add(cb);
    return () => this.loginListeners.delete(cb);
  }

  /** MCP-серверы аккаунта со статусами (`claude mcp list` на сервере проверяет каждый — до минуты). */
  async mcpList(profile: string): Promise<McpServer[]> {
    const r = await this.request({ type: 'cmd:mcp.list', profile }, 120_000);
    return ((r.data as { servers?: McpServer[] } | undefined)?.servers) ?? [];
  }

  /** Добавить MCP-сервер аккаунту; секреты только уходят на сервер. Возвращает обновлённый список. */
  async mcpAdd(profile: string, name: string, config: McpConfig): Promise<McpServer[]> {
    const r = await this.request({ type: 'cmd:mcp.add', profile, name, config }, 120_000);
    return ((r.data as { servers?: McpServer[] } | undefined)?.servers) ?? [];
  }

  async mcpRemove(profile: string, name: string): Promise<McpServer[]> {
    const r = await this.request({ type: 'cmd:mcp.remove', profile, name }, 120_000);
    return ((r.data as { servers?: McpServer[] } | undefined)?.servers) ?? [];
  }

  /** Вход OAuth в MCP-сервер на стороне сервера (как вход в подписку): ход — event:profile.login. */
  /** Поиск в каталоге MCP (через supervisor — он же проверяет, есть ли на сервере npx/uvx/docker). */
  /** Общий список MCP среды; check — статусы (`claude mcp list` у каждого аккаунта, до минуты). */
  async mcpShared(check = false): Promise<McpShared> {
    const r = await this.request({ type: 'cmd:mcp.shared', ...(check ? { check: true } : {}) }, check ? 180_000 : 30_000);
    const d = (r.data ?? {}) as Partial<McpShared>;
    return { targets: d.targets ?? [], servers: d.servers ?? [], other: d.other ?? [], ...(d.presets ? { presets: d.presets } : {}) };
  }

  /** Поставить недостающие серверы стандартного набора z.ai всем аккаунтам. */
  async mcpPreset(preset: 'zai'): Promise<{ added: string[]; results: Record<string, McpSharedResult[]> }> {
    const r = await this.request({ type: 'cmd:mcp.preset', preset }, 300_000);
    const d = (r.data ?? {}) as { added?: string[]; results?: Record<string, McpSharedResult[]> };
    return { added: d.added ?? [], results: d.results ?? {} };
  }

  /** Включить/выключить общий сервер у аккаунта (у всех аккаунтов с тем же файлом настроек). */
  async mcpToggle(profile: string, name: string, on: boolean): Promise<void> {
    await this.request({ type: 'cmd:mcp.toggle', profile, name, on }, 120_000);
  }

  /** Добавить сервер всем аккаунтам и в общий список; секреты только уходят на сервер. */
  async mcpSharedAdd(name: string, config: McpConfig, profiles?: string[]): Promise<McpSharedResult[]> {
    const r = await this.request({ type: 'cmd:mcp.shared.add', name, config, ...(profiles ? { profiles } : {}) }, 300_000);
    return ((r.data as { results?: McpSharedResult[] } | undefined)?.results) ?? [];
  }

  /** Удалить сервер у всех аккаунтов и из общего списка. */
  async mcpSharedRemove(name: string): Promise<McpSharedResult[]> {
    const r = await this.request({ type: 'cmd:mcp.shared.remove', name }, 300_000);
    return ((r.data as { results?: McpSharedResult[] } | undefined)?.results) ?? [];
  }

  async mcpCatalogSearch(query: string): Promise<{ entries: McpCatalogEntry[]; skipped: number }> {
    const r = await this.request({ type: 'cmd:mcp.catalog.search', query }, 45_000);
    const d = r.data as { entries?: McpCatalogEntry[]; skipped?: number } | undefined;
    return { entries: d?.entries ?? [], skipped: d?.skipped ?? 0 };
  }

  async mcpLoginStart(o: { profile: string; name: string; width: number; height: number }): Promise<{ loginId: string; rbId?: string; url?: string }> {
    const r = await this.request({ type: 'cmd:mcp.login.start', ...o }, 60_000);
    return r.data as { loginId: string; rbId?: string; url?: string };
  }

  /** Правка аккаунта (модели, модель и усилие по умолчанию, ultracode); пишется в profiles.json среды. */
  async updateProfile(profile: string, patch: ProfilePatch): Promise<ProfileInfo> {
    const r = await this.request({ type: 'cmd:profile.update', profile, ...patch }, PROFILE_TIMEOUT_MS);
    const p = (r.data as { profile?: ProfileInfo } | undefined)?.profile;
    if (!p) throw new CmdError('BAD_REPLY', 'supervisor не вернул профиль');
    this.putProfile(p);
    return p;
  }

  /** Снимок контекста сессии (кольцо). Ошибки молча: у остывшей сессии контекста нет — это норма. */
  requestContext(sid: string): void {
    void this.request({ type: 'cmd:session.context', sessionId: sid }).then((r) => {
      if (r.data && typeof r.data === 'object') {
        this.contextBySession.set(sid, r.data as Record<string, unknown>);
        this.notify();
      }
    }, () => undefined);
  }

  sendText(sid: string, text: string, images?: string[]): void {
    const s = this.sessions.get(sid);
    this.localId += 1;
    s?.items.push({ id: `local-${this.localId}`, kind: 'user', data: { text, ...(images?.length ? { images } : {}) }, ts: Date.now() });
    if (s) { s.lastActivity = Date.now(); s.sortAt = s.lastActivity; }
    void this.fire({ type: 'cmd:message.send', sessionId: sid, text: text || ' ', ...(images?.length ? { images } : {}) }, 'Сообщение не отправлено');
    this.notify();
  }

  interrupt(sid: string): void {
    void this.fire({ type: 'cmd:interrupt', sessionId: sid }, 'Не удалось остановить ход');
  }

  stopSession(sid: string): void {
    void this.fire({ type: 'cmd:session.stop', sessionId: sid }, 'Не удалось остановить сессию');
  }

  /** Форк: новая сессия с копией истории до текущего момента; становится активной. */
  async fork(sid: string): Promise<void> {
    const r = await this.fire({ type: 'cmd:session.fork', sessionId: sid }, 'Форк не создан');
    const newId = (r?.data as { sessionId?: string } | undefined)?.sessionId;
    if (!newId) return;
    const src = this.sessions.get(sid);
    const v = this.ensure(newId, `форк · ${src?.name ?? ''}`);
    if (src) {
      if (src.profile) v.profile = src.profile;
      if (src.projectId) v.projectId = src.projectId;
      if (src.model) v.model = src.model;
      if (src.permissionMode) v.permissionMode = src.permissionMode;
      v.items = src.items.map((it) => ({ ...it, data: { ...it.data } })); // история до форка — сразу видна
    }
    this.select(newId);
    void this.refreshSessions();
  }

  renameSession(sid: string, name: string): void {
    const s = this.sessions.get(sid);
    if (s) s.name = name; // оптимистично
    void this.fire({ type: 'cmd:session.rename', sessionId: sid, name }, 'Не удалось переименовать');
    this.notify();
  }

  archiveSession(sid: string, archived: boolean): void {
    const s = this.sessions.get(sid);
    if (s) s.archived = archived;
    if (archived && this.activeId === sid) {
      this.activeId = [...this.sessions.values()].find((x) => !x.archived)?.id ?? null;
    }
    void this.fire({ type: 'cmd:session.archive', sessionId: sid, archived }, 'Не удалось изменить архив');
    this.notify();
  }

  /** Удалить сессию с историей (транскрипт на сервере тоже). Работающую не удаляем. */
  deleteSession(sid: string): void {
    this.sessions.delete(sid);
    this.lastSeq.delete(sid);
    this.contextBySession.delete(sid);
    this.feedSigs.delete(sid);
    if (this.activeId === sid) this.activeId = [...this.sessions.values()].find((x) => !x.archived)?.id ?? null;
    void cacheStore.dropFeed(this.environment, sid);
    void this.fire({ type: 'cmd:session.delete', sessionId: sid }, 'Не удалось удалить сессию');
    this.notify();
  }

  /** Экспорт сессии для переноса в другую среду: транскрипт + мета + патч правок; сессия уходит в архив с пометкой. */
  exportSession(sid: string, to: string): Promise<ExportedSession> {
    return this.request({ type: 'cmd:session.export', sessionId: sid, to }, 30_000).then(
      (r) => {
        // сервер уже архивирует с пометкой — отражаем сразу, не дожидаясь следующего hello
        const s = this.sessions.get(sid);
        if (s) { s.archived = true; s.movedTo = to; }
        if (this.activeId === sid) this.activeId = [...this.sessions.values()].find((x) => !x.archived)?.id ?? null;
        this.notify();
        return r.data as ExportedSession;
      },
      (e: unknown) => { throw e instanceof CmdError ? e : new CmdError('EXPORT_FAILED', 'перенос не удался'); },
    );
  }

  /** Импорт перенесённой сессии: транскрипт ложится в папку проекта, сессия создаётся остывшей. */
  importSession(p: {
    name: string; claudeSessionId: string; transcript: string; movedFrom: string;
    project?: string; model?: string; permissionMode?: string; profile?: string; effort?: EffortLevel; ultracode?: boolean;
    patch?: string; baseCommit?: string;
  }): Promise<{ sessionId: string }> {
    const frame: Record<string, unknown> = { type: 'cmd:session.import', ...p };
    // пустые опции не шлём: сервер различает «не задано» и «сброшено»
    for (const k of ['project', 'model', 'permissionMode', 'profile', 'effort', 'ultracode', 'patch', 'baseCommit'] as const) {
      if (frame[k] === undefined) delete frame[k];
    }
    return this.request(frame, 60_000).then((r) => r.data as { sessionId: string }, (e: unknown) => {
      throw e instanceof CmdError ? e : new CmdError('IMPORT_FAILED', 'перенос не удался');
    });
  }

  respondPermission(sid: string, requestId: string, behavior: 'allow' | 'deny', updatedInput?: unknown, updatedPermissions?: unknown): void {
    // карточку убираем сразу (оптимистично); если сервер её уже не знает — тост
    const s = this.sessions.get(sid);
    if (s) s.permissions = s.permissions.filter((p) => p.requestId !== requestId);
    void this.fire({
      type: 'cmd:permission.respond', sessionId: sid, requestId, behavior,
      ...(updatedInput !== undefined ? { updatedInput } : {}),
      ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
    }, 'Ответ не доставлен');
    this.notify();
  }

  /** «всегда разрешать» этот инструмент в этой сессии (правило живёт до конца сессии) */
  alwaysAllowTool(sid: string, requestId: string, toolName: string): void {
    this.respondPermission(sid, requestId, 'allow', undefined, [{
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    }]);
  }

  /** Ответ на AskUserQuestion: answers — {текст вопроса: выбранные метки через запятую}. */
  answerQuestions(sid: string, card: PermissionCard, answers: Record<string, string>): void {
    this.respondPermission(sid, card.requestId, 'allow', {
      ...(typeof card.input === 'object' && card.input !== null ? card.input as Record<string, unknown> : {}),
      questions: card.questions ?? [],
      answers,
    });
  }

  /** Нагрузка машины supervisor'а (процессор/память/диск) — для строки статуса. */
  sysStats(): Promise<{ load1: number | null; cores: number; memTotal: number; memFree: number; uptimeSec: number; diskFree?: number } | null> {
    return this.request({ type: 'cmd:sys.stats' }, PROFILE_TIMEOUT_MS)
      .then((r) => r.data as { load1: number | null; cores: number; memTotal: number; memFree: number; uptimeSec: number; diskFree?: number }, () => null);
  }

  // ─── панели: файлы, git, терминал, порты ─────────────────────────────────
  // Корень путей — папка сессии; ack разбираем терпимо: пустой ack старого сервера → UNSUPPORTED.

  private async panelCmd<T>(frame: Record<string, unknown>, parse: (d: unknown) => T | null, what: string, timeoutMs = PANEL_TIMEOUT_MS): Promise<T> {
    const r = await this.request(frame, timeoutMs);
    const v = parse(r.data);
    if (v === null) throw new CmdError('UNSUPPORTED', `сервер не поддерживает ${what} — обновите supervisor`);
    return v;
  }

  fsList(sid: string, path = ''): Promise<FsList> {
    return this.panelCmd({ type: 'cmd:fs.list', sessionId: sid, path }, parseFsList, 'просмотр файлов (fs.list)');
  }

  fsRead(sid: string, path: string, maxBytes?: number): Promise<FsRead> {
    return this.panelCmd({ type: 'cmd:fs.read', sessionId: sid, path, ...(maxBytes !== undefined ? { maxBytes } : {}) }, parseFsRead, 'чтение файлов (fs.read)');
  }

  gitStatus(sid: string): Promise<GitStatus> {
    return this.panelCmd({ type: 'cmd:git.status', sessionId: sid }, parseGitStatus, 'git-статус (git.status)');
  }

  netPorts(sid?: string): Promise<PortInfo[]> {
    return this.panelCmd({ type: 'cmd:net.ports', ...(sid ? { sessionId: sid } : {}) }, parseNetPorts, 'список портов (net.ports)');
  }

  termOpen(sid: string, cols: number, rows: number, cwd?: string): Promise<TermInfo> {
    return this.panelCmd({ type: 'cmd:term.open', sessionId: sid, ...clampSize(cols, rows), ...(cwd ? { cwd } : {}) }, parseTermInfo, 'терминал (term.open)', REQUEST_TIMEOUT_MS);
  }

  termAttach(sid: string, termId: string): Promise<TermInfo> {
    return this.panelCmd({ type: 'cmd:term.attach', sessionId: sid, termId }, parseTermInfo, 'терминал (term.attach)');
  }

  termList(sid: string): Promise<TermInfo[]> {
    return this.panelCmd({ type: 'cmd:term.list', sessionId: sid }, parseTermList, 'терминал (term.list)');
  }

  /** Ввод в терминал: большие вставки — кусками под лимит кадра, по порядку. */
  async termInput(sid: string, termId: string, data: string): Promise<void> {
    for (const part of chunkInput(data)) await this.request({ type: 'cmd:term.input', sessionId: sid, termId, data: part }, PANEL_TIMEOUT_MS);
  }

  async termResize(sid: string, termId: string, cols: number, rows: number): Promise<void> {
    await this.request({ type: 'cmd:term.resize', sessionId: sid, termId, ...clampSize(cols, rows) }, PANEL_TIMEOUT_MS);
  }

  async termClose(sid: string, termId: string): Promise<void> {
    await this.request({ type: 'cmd:term.close', sessionId: sid, termId }, PANEL_TIMEOUT_MS);
  }

  /** Подписка на поток терминала; вывод, пришедший до подписки, отдаём сразу (асинхронно). */
  onTerm(termId: string, cb: (e: TermEvent) => void): () => void {
    let subs = this.termListeners.get(termId);
    if (!subs) {
      subs = new Set();
      this.termListeners.set(termId, subs);
    }
    subs.add(cb);
    const orphan = this.termOrphans.get(termId);
    if (orphan) {
      this.termOrphans.delete(termId);
      queueMicrotask(() => { for (const ev of orphan.events) cb(ev); });
    }
    return () => {
      const set = this.termListeners.get(termId);
      set?.delete(cb);
      if (set && set.size === 0) this.termListeners.delete(termId);
    };
  }

  /** Каждое (пере)подключение к supervisor'у — сразу после отправки hello. */
  onConnect(cb: () => void): () => void {
    this.connectListeners.add(cb);
    return () => { this.connectListeners.delete(cb); };
  }

  // ─── события ──────────────────────────────────────────────────────────────

  private handle(raw: string): void {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return; }
    const r = parseFrame(json);
    if (!r.ok || 'unknownType' in r) return;
    const f = r.frame;
    if ('ok' in f) {
      const p = this.pending.get(f.id);
      if (p) {
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.ok) p.resolve(f as Reply);
        else p.reject(new CmdError(f.code, `${f.message}`));
      }
      return;
    }
    // поток терминала — без seq и sessionId: маршрутизируем по termId ДО логики ленты
    if (f.type === 'event:term.output' || f.type === 'event:term.exit') {
      this.onTermFrame(f.termId, f.type === 'event:term.output' ? { type: 'output', data: f.data } : { type: 'exit', code: f.code });
      return;
    }
    if (f.type === 'event:hello') {
      this.onHello(f);
      return;
    }
    // профили поменялись (правка в настройках, обновление моделей) — у всех клиентов сразу
    if (f.type === 'event:profiles') {
      this.profiles = f.profiles;
      this.notify();
      return;
    }
    // лимиты аккаунта пришли с ответом API в чьей-то сессии
    if (f.type === 'event:usage') {
      this.usage.set(f.profile, { usage: f.usage });
      this.notify();
      return;
    }
    // новая сессия на сервере (делегирование и др.) — без hello клиент о ней не узнает
    if (f.type === 'event:session.created') {
      const c = f.session;
      const v = this.ensure(c.id, c.name);
      v.name = c.name;
      v.state = c.state;
      v.needs = c.needs ?? null;
      applySessionFields(v, c);
      v.archived = c.archived === true;
      this.notify();
      return;
    }
    // ход входа в подписку — окну «Добавить аккаунт»
    if (f.type === 'event:profile.login') {
      const { loginId, state, rbId, url, rbError, profile, email, plan, error } = f;
      const e: LoginEvent = { loginId, state, ...(rbId ? { rbId } : {}), ...(url ? { url } : {}), ...(rbError ? { rbError } : {}),
        ...(profile ? { profile } : {}), ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(error ? { error } : {}) };
      for (const fn of [...this.loginListeners]) fn(e);
      return;
    }
    // удалённый браузер — адресно по rbId, мимо ленты
    if (f.type === 'event:rb.frame' || f.type === 'event:rb.state' || f.type === 'event:rb.exit') {
      this.onRbFrame(f);
      return;
    }
    // команды сервер клиенту не шлёт; объединение кадров велико — сужаем явно
    if (!f.type.startsWith('event:')) return;
    this.onEvent(f as Event);
  }

  private onTermFrame(termId: string, ev: TermEvent): void {
    const subs = this.termListeners.get(termId);
    if (subs && subs.size > 0) {
      for (const fn of [...subs]) {
        try { fn(ev); } catch { /* подписчик не роняет транспорт */ }
      }
      return;
    }
    let o = this.termOrphans.get(termId);
    if (!o) {
      const oldest = this.termOrphans.keys().next();
      if (this.termOrphans.size >= ORPHAN_MAX_TERMS && !oldest.done) this.termOrphans.delete(oldest.value);
      o = { events: [], bytes: 0 };
      this.termOrphans.set(termId, o);
    }
    o.events.push(ev);
    o.bytes += ev.type === 'output' ? ev.data.length : 0;
    while (o.bytes > ORPHAN_MAX_BYTES && o.events.length > 1) {
      const old = o.events.shift();
      o.bytes -= old?.type === 'output' ? old.data.length : 0;
    }
  }

  private onHello(f: Extract<Event, { type: 'event:hello' }>): void {
    this.serverVersion = f.server.version;
    this.fromCache = false;
    this.profiles = f.profiles ?? [];
    this.projects = f.projects ?? [];
    this.pool = f.pool ?? null;
    this.storage = f.storage ?? null;
    // сервер — источник истины по составу сессий: исчезнувшие (рестарт без state.json, другой сервер) убираем
    const alive = new Set(f.sessions.map((s) => s.id));
    for (const id of [...this.sessions.keys()]) {
      if (!alive.has(id)) {
        this.sessions.delete(id);
        this.lastSeq.delete(id);
        this.contextBySession.delete(id);
        this.feedSigs.delete(id);
        void cacheStore.dropFeed(this.environment, id);
      }
    }
    if (this.activeId && !alive.has(this.activeId)) this.activeId = null;
    for (const s of f.sessions) {
      const v = this.ensure(s.id, s.name);
      v.name = s.name;
      v.state = s.state;
      v.needs = s.needs ?? null;
      applySessionFields(v, s);
      v.archived = s.archived === true;
      // устаревшие карточки (ответили с другого клиента/таймаут во время обрыва) — сервер перешлёт актуальные
      if (s.state !== 'waiting_permission' && s.state !== 'waiting_input') v.permissions = [];
      if (s.state !== 'working') v.printing = null;
    }
    if (!this.activeId) this.activeId = f.sessions.find((s) => !s.archived)?.id ?? null;
    // истории — только у открытой сессии: тянуть все разом через туннель до VPS — десятки секунд,
    // за которыми в очереди стоят ответы на команды; остальные подтянутся при открытии
    if (this.activeId) this.ensureHistory(this.activeId);
    this.refreshSync();
    this.notify();
  }

  /** Ресинк ленты сессии из транскрипта. Нет транскрипта (ещё не писали) — не ошибка. */
  resync(sid: string): void {
    const s = this.sessions.get(sid);
    if (!s || s.resyncing) return;
    s.resyncing = true;
    this.request({ type: 'cmd:transcript.get', sessionId: sid }, 30_000).then((r) => {
      const t = r.data as { items?: Array<{ kind: string; data: Record<string, unknown> }>; lastSeq?: number | null } | undefined;
      const v = this.sessions.get(sid);
      if (!v || !t?.items) return;
      // транскрипт — полный снимок ленты на момент ответа (включая реплики пользователя)
      v.items = t.items.map((it, i) => ({ id: `t${i}`, kind: it.kind as FeedItem['kind'], data: it.data }));
      v.historyLoaded = true;
      v.printing = null;
      if (typeof t.lastSeq === 'number') this.lastSeq.set(sid, Math.max(t.lastSeq, this.lastSeq.get(sid) ?? -1));
    }, () => undefined).finally(() => {
      const v = this.sessions.get(sid);
      if (v) v.resyncing = false;
      this.notify();
    });
    this.notify();
  }

  private onEvent(e: Event): void {
    if (e.type === 'event:hello') return;
    const sid = e.sessionId;
    if (!sid) return;
    if (e.type !== 'event:session.state') {
      const seen = this.lastSeq.get(sid);
      if (seen !== undefined && e.seq <= seen) {
        if (e.seq === seen) return; // дубль из догона
        if (e.type !== 'event:permission.request' && e.type !== 'event:error') {
          // регресс: счётчик сервера ниже нашего (рестарт с отставшим персистом) —
          // возможны коллизии номеров, ленту целиком перетягиваем из транскрипта
          const regressed = this.ensure(sid, sid.slice(0, 8));
          this.forgetFeed(regressed);
          // транскрипт — только открытой сессии: остальные подтянутся при открытии (туннель не забиваем)
          if (sid === this.activeId) this.resync(sid);
        }
      }
      if (e.type !== 'event:error' || e.seq > 0) this.lastSeq.set(sid, Math.max(e.seq, this.lastSeq.get(sid) ?? -1));
    }
    const s = this.ensure(sid, sid.slice(0, 8));
    s.lastActivity = e.ts || Date.now();

    switch (e.type) {
      case 'event:session.state':
        s.state = e.state;
        s.needs = e.needs ?? null;
        if (e.state !== 'working') { s.printing = null; delete s.retry; }
        if (e.state === 'dead' || e.state === 'idle' || e.state === 'interrupted') s.permissions = [];
        break;
      case 'event:session.init':
        s.model = e.model;
        s.permissionMode = e.permissionMode;
        s.items.push({ id: `i${e.seq}`, kind: 'state', data: { text: `сессия готова · ${e.model} · инструментов ${e.tools.length}` }, ts: e.ts });
        break;
      case 'event:message.assistant': {
        s.printing = null; // полный блок пришёл — призрак сбрасываем
        delete s.retry; // модель ответила — повторы позади
        const b = e.block;
        if (b.type === 'text') s.items.push({ id: `i${e.seq}`, kind: 'text', data: { text: b.text }, ts: e.ts });
        else if (b.type === 'thinking') { if (b.thinking) s.items.push({ id: `i${e.seq}`, kind: 'thinking', data: { text: b.thinking }, ts: e.ts }); } // пустое (скрытое) — не показываем
        else s.items.push({ id: `i${e.seq}`, kind: 'tool-use', data: { id: b.id, name: b.name, input: b.input, result: undefined, isError: false, done: false }, ts: e.ts });
        break;
      }
      case 'event:stream.delta':
        if (e.kind === 'text') s.printing = (s.printing ?? '') + e.delta;
        break;
      case 'event:message.user': {
        // результат приклеиваем к карточке вызова (по toolUseId), отдельного блока не плодим
        const target = e.toolUseId ? [...s.items].reverse().find((it) => it.kind === 'tool-use' && it.data['id'] === e.toolUseId) : undefined;
        if (target) {
          target.data['result'] = e.result;
          target.data['isError'] = e.isError === true;
          target.data['done'] = true;
        } else {
          s.items.push({ id: `i${e.seq}`, kind: 'tool-result', data: { toolName: e.toolName, isError: e.isError === true, result: e.result, ...(e.toolUseId ? { toolUseId: e.toolUseId } : {}) }, ts: e.ts });
        }
        break;
      }
      case 'event:permission.request':
        if (!s.permissions.some((p) => p.requestId === e.requestId)) {
          s.permissions.push({ requestId: e.requestId, toolName: e.toolName, input: e.input, at: e.ts || Date.now(), ...(e.questions ? { questions: e.questions } : {}) });
          if (typeof document !== 'undefined' && !document.hasFocus()) {
            window.perimeterIPC?.notify(`perimeter · ${s.name}`, e.questions ? 'агент задал вопрос' : `ждёт разрешения: ${e.toolName}`);
          }
        }
        break;
      case 'event:permission.result':
        s.permissions = s.permissions.filter((p) => p.requestId !== e.requestId);
        s.items.push({ id: `i${e.seq}`, kind: 'permission-log', data: { behavior: e.behavior, ...(e.reason ? { reason: e.reason } : {}) }, ts: e.ts });
        break;
      case 'event:api.retry':
        s.retry = { attempt: e.attempt, maxRetries: e.maxRetries, delayMs: e.delayMs, status: e.status, error: e.error, at: e.ts };
        break;
      case 'event:turn.result':
        s.printing = null;
        delete s.retry;
        if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) {
          window.perimeterIPC?.notify(`perimeter · ${s.name}`, e.subtype === 'success' ? 'ход завершён' : 'ход прерван');
        }
        // звук окончания хода: всегда или (по умолчанию) когда окно не в фокусе
        {
          const mode = turnSoundMode();
          if (mode === 'always' || (mode === 'bg' && typeof document !== 'undefined' && (document.hidden || !document.hasFocus()))) playTurnDone();
        }
        s.lastResult = {
          ...(e.subtype !== undefined ? { subtype: e.subtype } : {}),
          ...(e.totalCostUsd !== undefined ? { costUsd: e.totalCostUsd } : {}),
          ...(e.numTurns !== undefined ? { numTurns: e.numTurns } : {}),
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        };
        s.items.push({ id: `i${e.seq}`, kind: 'turn', data: { ...s.lastResult }, ts: e.ts });
        break;
      case 'event:subagent.start':
        s.items.push({ id: `i${e.seq}`, kind: 'subagent', data: { phase: 'start', parent: e.parentToolUseId, ...(e.agentType ? { agentType: e.agentType } : {}) }, ts: e.ts });
        break;
      case 'event:subagent.message':
        break; // текст субагентов в P0 не транслируется сервером
      case 'event:subagent.stop':
        s.items.push({ id: `i${e.seq}`, kind: 'subagent', data: { phase: 'stop', parent: e.parentToolUseId }, ts: e.ts });
        break;
      case 'event:error':
        if (e.code === 'RESYNC_NEEDED') {
          // supervisor перезапускался или кэш отстал от буфера — ленту целиком из транскрипта, но только
          // у открытой сессии: остальные подтянутся при открытии
          this.forgetFeed(s);
          if (sid === this.activeId) this.resync(sid);
        } else {
          s.items.push({ id: `i${e.seq}-${e.code}`, kind: 'error', data: { code: e.code, text: e.message }, ts: e.ts });
        }
        break;
      default:
        break;
    }
    // порядок в сайдбаре: во время хода не двигаем (первое значение — сразу, чтобы было от чего считать)
    if (s.sortAt === undefined || !isRunningState(s.state)) s.sortAt = s.lastActivity;
    this.notify();
  }

  private ensure(id: string, name: string): SessionView {
    let v = this.sessions.get(id);
    if (!v) {
      v = { id, name, state: 'creating', needs: null, items: [], permissions: [], printing: null, lastActivity: Date.now() };
      this.sessions.set(id, v);
    }
    return v;
  }
}

/**
 * Клиенты по подключениям. get() никогда не пусто: недостающий клиент создаётся (не подключённым) —
 * рендер не падает, пока список подключений и набор клиентов расходятся на кадр.
 */
export class ClientSet {
  private map = new Map<EnvId, SupervisorClient>();
  /** новый клиент создан — App подписывается на него */
  onCreate: ((c: SupervisorClient) => void) | null = null;

  get(env: EnvId): SupervisorClient {
    let c = this.map.get(env);
    if (!c) {
      c = new SupervisorClient(env);
      this.map.set(env, c);
      this.onCreate?.(c);
    }
    return c;
  }

  has(env: EnvId): boolean {
    return this.map.has(env);
  }

  ids(): EnvId[] {
    return [...this.map.keys()];
  }

  all(): SupervisorClient[] {
    return [...this.map.values()];
  }

  /** Подключение удалено — закрыть и забыть клиента. */
  drop(env: EnvId): void {
    this.map.get(env)?.close();
    this.map.delete(env);
    void cacheStore.dropEnv(env);
  }
}

/** Ход идёт (порядок сессии в сайдбаре заморожен). */
function isRunningState(state: SessionView['state']): boolean {
  return state === 'working' || state === 'initializing' || state === 'creating';
}
