// WSS-сервер supervisor'а (АДР 003): один сокет, JSON-кадры, догон по lastSeq.
// Слушает ТОЛЬКО 127.0.0.1 — транспорт извне через SSH-туннель (инвариант 6).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cpus, freemem, loadavg, tmpdir, totalmem, uptime } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { carryTranscript, readTranscriptItems, retargetTranscript, transcriptPath, writeTranscript } from './transcript.js';
import type { ThinkingStore } from './thinkingStore.js';
import { usageFromRateLimit } from './usage.js';
import { BASE_PROFILE, KEY_TEMPLATES, ProfileRegistry, accountEnv, explicitConfigDir, gatewayModels, keyVar, profileConfigDir, profileFromTemplate, usesKey, usesSubToken, type ModelsFrom, type Profile } from './profiles.js';
import { ACCOUNT_KEY_MARK, globalConfigFile, mcpAdd, mcpList, mcpRemove, mergeMcp, readUserMcp, validateMcp, withAccountKey, type McpConfig, type McpDeps, type McpServerInfo, type McpStatus } from './mcp.js';
import { McpSharedStore, ZAI_KEY_HOST, ZAI_MCP_PRESET, accountKeyOf, configFor, gatewayHostOf, isZaiGateway, rekeyConfig, templateOf, toMcpConfig, type StoredMcp } from './mcpShared.js';
import { searchCatalog, type CatalogDeps } from './mcpCatalog.js';
import { LoginManager, accountsRoot as defaultAccountsRoot, checkKey, checkToken, findOAuthToken, prepareAccountDir, removeAccountDirIfUnused, type KeyCheckResult, type LoginDeps } from './accounts.js';
import { ProjectStore } from './projects.js';
import {
  freeBytes, gitInfo, gitTail, insideRoot, inspectDir, maskUrl, planFor, projectPath, realGit, validGitUrl,
  type GitRunner,
} from './storage.js';
import type { PoolLike } from './pool.js';
import { PanelError, PanelService, type ListenPort, type PanelCmd, type TermSubscriber, type TerminalManager } from './panels/index.js';
import { RemoteBrowserManager, type RbSubscriber } from './panels/rbrowser.js';
import {
  EventSchema, PROTOCOL_VERSION, parseFrame,
  type Cmd, type EffortLevel, type Event, type Frame, type ModelInfoFrame, type Reply, type UsageInfo,
} from '@perimeter/protocol';
import type { SessionManager, SessionCreateOptions, SessionInfo } from './session/manager.js';
import { RingBuffer } from './ringbuffer.js';
import { SUPERVISOR_VERSION } from './version.js';

export interface WssOptions {
  port: number;
  /** настоящий supervisor: проверять, что папка сессии есть (иначе понятная ошибка), и создавать папку нового проекта. В тестах/демо — выкл. */
  ensureDirs?: boolean;
  host?: string; // по умолчанию 127.0.0.1; переопределяется только для тестов/локальной отладки
  ringCapacity?: number;
  /** журнал текста размышлений: транскрипт хранит thinking без текста — подставляем при transcript.get */
  thinking?: ThinkingStore;
  /** профили аккаунтов (мультиакк) — отдаются в event:hello и применяются фабрикой */
  profiles?: ProfileRegistry;
  /** фабрика процесса claude для новой сессии; получает параметры сессии (cwd — куда класть транскрипт),
   *  готовый id (делегирование: хендлеру инструмента нужен родитель до создания) и parentSessionId воркера */
  sessionFactory: (sess: { cwd?: string; model?: string; permissionMode?: string; profile?: string; effort?: EffortLevel; ultracode?: boolean; parentSessionId?: string }, id: string) => SessionCreateOptions['factory'];
  /**
   * Список моделей аккаунта у самого Claude Code (по имени профиля, как его видит клиент; `default` — аккаунт supervisor'а).
   * Нет — cmd:profile.models с refresh отвечает MODELS_FAILED. В тестах подменяется.
   */
  /** список моделей аккаунта; массив — от Claude Code (старый вид), объект — с указанием, кто отдал */
  modelsFetcher?: (profile: string) => Promise<ModelInfoFrame[] | { models: ModelInfoFrame[]; from: ModelsFrom }>;
  /**
   * Лимиты аккаунта у источника (z.ai — квота; подписка Claude — /usage через Claude Code, если доступен).
   * null — источник не ответил лимитами (тогда — последние из ответов API в сессиях).
   */
  usageFetcher?: (profile: string) => Promise<UsageInfo | null>;
  /** фабрики жизненного цикла: респаун через resume и форк истории */
  resumeFactory?: SessionCreateOptions['resumeFactory'];
  forkFactory?: SessionCreateOptions['forkFactory'];
  /** пул тёплых процессов (prewarm): если есть — session.new получает тёплый слот своего профиля */
  pool?: PoolLike;
  /** проекты (папки с дефолтами); отсутствует → команды проектов отвечают NOT_CONFIGURED */
  projects?: ProjectStore;
  /** реестр терминалов панели (по умолчанию свой; подменяется в тестах — например, режим pipe) */
  terminals?: TerminalManager;
  /** источник слушающих портов (по умолчанию ss/netstat; подменяется в тестах) */
  ports?: () => Promise<ListenPort[]>;
  /** запуск git для хранилища проектов (по умолчанию настоящий git; в тестах/демо — подмена) */
  git?: GitRunner;
  /** удалённые браузеры (ретрансляция); по умолчанию — свой с найденным Chromium */
  rbrowser?: RemoteBrowserManager;
  /** сжатие кадров permessage-deflate (по умолчанию вкл.; тестам можно выключить) */
  compress?: boolean;
  /** аккаунты из UI: папка аккаунтов, подмены входа и проверки ключа (тесты) */
  accounts?: {
    root?: string;
    login?: Partial<Omit<LoginDeps, 'emit'>>;
    checkKey?: (p: Parameters<typeof checkKey>[0]) => Promise<KeyCheckResult>;
    /** проверка токена подписки через Claude Code (тесты подменяют) */
    checkToken?: (token: string) => Promise<KeyCheckResult>;
    /** запуск `claude mcp …` (тесты подменяют) */
    mcpRun?: McpDeps['run'];
    /** каталог MCP: сеть и проверка команд (тесты и демо подменяют) */
    mcpCatalog?: CatalogDeps;
    /** копии общих MCP-серверов (mcp-shared.json); нет — в памяти */
    mcpSharedFile?: string;
  };
}

/** Цель MCP: аккаунты с общим файлом настроек Claude Code (id — имя первого). */
interface McpTarget {
  id: string;
  profiles: Profile[];
  dir: string | undefined;
  env: Record<string, string>;
}

/** Медленный клиент: выше этого буфера кадры удалённого браузера пропускаем (следующий придёт сам). */
const RB_BACKPRESSURE_BYTES = 2 * 1024 * 1024;

/**
 * permessage-deflate: история сессии (JSON 0,5–1 МБ) жмётся в разы — через туннель ~150 КБ/с это секунды.
 * Порог 1 КБ — мелкие кадры (дельты стрима) не жмём; кадры удалённого браузера (JPEG) шлются без сжатия.
 */
export const DEFLATE_OPTIONS = {
  threshold: 1024,
  zlibDeflateOptions: { level: 6, memLevel: 8 },
  concurrencyLimit: 8,
} as const;

/** git clone может идти минутами; дольше — обрываем с понятной ошибкой. */
const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;
/** git-сведения папки в превью и обзоре: на большом репозитории status не должен вешать ответ. */
const GIT_INFO_TIMEOUT_MS = 8_000;

/** Список моделей auto-аккаунта старше этого — обновляется в фоне при старте. */
const MODELS_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Медленный клиент: выше этого буфера сокета вывод терминала пропускаем (догон — cmd:term.attach). */
const TERM_BACKPRESSURE_BYTES = 8 * 1024 * 1024;

/** Папка проекта: нет — создать; не абсолютный путь / нет прав / это файл — текст ошибки (иначе null). */
export function ensureProjectDir(path: string): string | null {
  if (!isAbsolute(path)) return `путь проекта должен быть абсолютным: ${path}`;
  try {
    if (statSync(path).isDirectory()) return null;
    return `${path} — это файл, а не папка`;
  } catch { /* нет — создаём ниже */ }
  try {
    mkdirSync(path, { recursive: true });
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM'
      ? `нет прав создать папку ${path} на сервере — выберите папку в домашнем каталоге или создайте её вручную`
      : `не удалось создать папку ${path}: ${String((err as Error).message)}`;
  }
}

/** Папка существует и это папка. */
export function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export class WssServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  /** клиенты, прошедшие cmd:hello: события сессий идут только им (иначе живой кадр обгоняет догон) */
  private ready = new Set<WebSocket>();
  private rings = new Map<string, RingBuffer<Event>>();
  private unsubscribe: (() => void) | null = null;
  private startedAt = Date.now();
  private readonly sessionFactory: WssOptions['sessionFactory'];
  private readonly ensureDirs: boolean;
  private readonly resumeFactory: WssOptions['resumeFactory'];
  private readonly forkFactory: WssOptions['forkFactory'];
  private readonly profiles: ProfileRegistry;
  private readonly thinking: ThinkingStore | undefined;
  private readonly projects: ProjectStore | null;
  private readonly pool: PoolLike | null;
  private readonly modelsFetcher: WssOptions['modelsFetcher'];
  private readonly usageFetcher: WssOptions['usageFetcher'];
  /** последние известные лимиты по аккаунту (внутреннее имя; '' — аккаунт supervisor'а) */
  private readonly usage = new Map<string, UsageInfo>();
  /**
   * Аккаунты подписки, у которых /usage недоступен (вход токеном: rate_limits_available=false) — не поднимаем ради
   * него Claude Code на каждый запрос (секунды ожидания при переключении сессий); лимиты — из ответов API в сессиях.
   */
  private readonly usageApiDead = new Set<string>();
  private readonly git: GitRunner;
  /** идущие запросы списка моделей по аккаунту — не плодим процессы claude на двойной клик */
  private modelsInflight = new Map<string, Promise<void>>();
  /** панели: файлы, git, порты, терминалы (терминалы живут здесь, а не в сокете) */
  private readonly panels: PanelService;
  /** адресат потока терминалов для каждого сокета */
  private termSinks = new Map<WebSocket, TermSubscriber>();
  /** удалённые браузеры и адресаты их кадров по сокетам */
  private readonly rbrowser: RemoteBrowserManager;
  private rbSinks = new Map<WebSocket, RbSubscriber>();
  private readonly compress: boolean;
  /** входы в подписку Claude (cmd:profile.login.*) */
  private readonly logins: LoginManager;
  private readonly accountsDir: string;
  private readonly keyCheck: (p: Parameters<typeof checkKey>[0]) => Promise<KeyCheckResult>;
  private readonly tokenCheck: (token: string) => Promise<KeyCheckResult>;
  private readonly mcpDeps: McpDeps;
  private readonly catalogDeps: CatalogDeps;
  private readonly mcpStore: McpSharedStore;
  /** смены ключа в настройках MCP аккаунтов — по очереди (remove + add одного сервера не должны переплетаться) */
  private mcpRekeyQueue: Promise<void> = Promise.resolve();
  readonly port: number;
  private readonly host: string;
  private readonly ringCapacity: number;

  constructor(
    private manager: SessionManager,
    opts: WssOptions,
  ) {
    this.port = opts.port;
    this.host = opts.host ?? '127.0.0.1';
    this.ringCapacity = opts.ringCapacity ?? 2000;
    this.sessionFactory = opts.sessionFactory;
    this.ensureDirs = opts.ensureDirs === true;
    this.resumeFactory = opts.resumeFactory;
    this.forkFactory = opts.forkFactory;
    this.profiles = opts.profiles ?? new ProfileRegistry([]);
    this.thinking = opts.thinking;
    this.projects = opts.projects ?? null;
    this.pool = opts.pool ?? null;
    this.modelsFetcher = opts.modelsFetcher;
    this.usageFetcher = opts.usageFetcher;
    // лимиты подписки приходят с ответами API в сессиях (rate_limit_event) — копим и рассылаем клиентам
    this.manager.rateLimitSink = (profile, info) => {
      const u = usageFromRateLimit(info);
      if (!u) return;
      this.usage.set(profile ?? '', u);
      this.broadcastUsage(profile, u);
    };
    this.git = opts.git ?? realGit;
    this.rbrowser = opts.rbrowser ?? new RemoteBrowserManager();
    this.compress = opts.compress !== false;
    this.accountsDir = opts.accounts?.root ?? defaultAccountsRoot(undefined);
    this.keyCheck = opts.accounts?.checkKey ?? ((p) => checkKey(p));
    this.tokenCheck = opts.accounts?.checkToken ?? ((t) => checkToken(this.logins.claudeBin, t));
    this.logins = new LoginManager({
      // вкладка входа: наш подписчик следит за адресом; кадры ему не нужны — ack не шлёт, браузер не рисует впустую
      openTab: (p) => this.rbrowser.open({ ...p, ackFrames: true }),
      closeTab: (rbId) => this.rbrowser.close(rbId),
      ...(opts.accounts?.login ?? {}),
      emit: (e) => this.broadcast(EventSchema.parse({ v: PROTOCOL_VERSION, ts: Date.now(), seq: 0, type: 'event:profile.login', ...e })),
    });
    this.mcpDeps = { bin: this.logins.claudeBin, ...(opts.accounts?.mcpRun ? { run: opts.accounts.mcpRun } : {}) };
    this.catalogDeps = opts.accounts?.mcpCatalog ?? {};
    this.mcpStore = new McpSharedStore(opts.accounts?.mcpSharedFile);
    this.panels = new PanelService({
      // null — сессии нет; undefined — сессия без cwd
      sessionCwd: (sid) => {
        const s = this.manager.get(sid);
        return s ? s.cwd : null;
      },
      ...(opts.terminals ? { terminals: opts.terminals } : {}),
      ...(opts.ports ? { ports: opts.ports } : {}),
    });
  }

  /** Куда реально забиндились (для инварианта 6 — только loopback). */
  get boundHost(): string {
    const addr = this.wss?.address();
    return typeof addr === 'object' && addr !== null ? addr.address : '';
  }

  /** Поднять сервер; резолвится фактическим портом (0 = ephemeral для тестов). */
  start(): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ host: this.host, port: this.port, perMessageDeflate: this.compress ? DEFLATE_OPTIONS : false });
      this.wss.on('connection', (ws) => this.onConnection(ws));
      this.wss.on('listening', () => {
        const addr = this.wss!.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : this.port);
      });
      this.unsubscribe = this.manager.subscribe((e) => this.onManagerEvent(e));
      // новая сессия (делегирование) — всем клиентам, seq 0 и МИМО ring-буферов: иначе
      // подключённый клиент не узнает о воркере до следующего hello, а кадр в ринге ломал бы догон lastSeq
      this.manager.setCreatedHook((info) => {
        const s = this.publicSession(info);
        if (!s) return;
        this.broadcast(EventSchema.parse({
          v: PROTOCOL_VERSION, ts: Date.now(), seq: 0, type: 'event:session.created', session: s,
        }));
      });
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.manager.setCreatedHook(null);
    // терминалы гасим до закрытия сокетов: подписчики ещё успеют получить event:term.exit
    await this.panels.stop().catch(() => undefined);
    this.termSinks.clear();
    await this.logins.stopAll().catch(() => undefined);
    await this.rbrowser.stopAll().catch(() => undefined);
    this.rbSinks.clear();
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.ready.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  // ─── события менеджера → всем клиентам + в ринг ───────────────────────────

  private onManagerEvent(e: Event): void {
    if (e.sessionId) {
      let ring = this.rings.get(e.sessionId);
      if (!ring) {
        ring = new RingBuffer<Event>(this.ringCapacity);
        this.rings.set(e.sessionId, ring);
      }
      ring.push(e);
    }
    this.broadcast(e);
  }

  private broadcast(e: Frame): void {
    const raw = JSON.stringify(e);
    // до hello клиент не знает, с какого seq продолжать: живой кадр до догона из ринга
    // приходит раньше пропущенных → клиент видит «регресс» seq и перетягивает ленту целиком
    for (const ws of this.ready) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  // ─── соединение ───────────────────────────────────────────────────────────

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        ws.send(JSON.stringify(this.err('0', 'BAD_JSON', 'кадр не JSON')));
        return;
      }
      this.handleFrame(ws, parsed);
    });
    const forget = () => {
      this.clients.delete(ws);
      this.ready.delete(ws);
      // терминалы живут дальше — только отписываем сокет от их потока
      const sink = this.termSinks.get(ws);
      if (sink) {
        this.termSinks.delete(ws);
        this.panels.terminals.unsubscribe(sink);
      }
      // удалённые браузеры тоже живут дальше (до простоя) — отписка
      const rb = this.rbSinks.get(ws);
      if (rb) {
        this.rbSinks.delete(ws);
        this.rbrowser.unsubscribe(rb);
      }
    };
    ws.on('close', forget);
    ws.on('error', forget);
  }

  private handleFrame(ws: WebSocket, raw: unknown): void {
    const r = parseFrame(raw);
    if (!r.ok) {
      // VERSION/SCHEMA у команды — отвечаем err по её id, если вытащим
      const id = (raw as { id?: string })?.id ?? '0';
      ws.send(JSON.stringify(this.err(id, r.code, r.error)));
      return;
    }
    if ('unknownType' in r) {
      return; // кадр из будущего клиента/сервера — игнорируем (инвариант 5)
    }
    const f = r.frame;
    if ('ok' in f) return; // ack/err от клиента supervisor'у не адресованы
    if (!('id' in f)) return; // события от клиента не ожидаем (только команды)
    // любое исключение команды → err клиенту; необработанный reject уронил бы весь демон
    this.handleCmd(ws, f).catch((err: unknown) => {
      this.sendReply(ws, this.err(f.id, 'INTERNAL', String(err).slice(0, 500)));
    });
  }

  private async handleCmd(ws: WebSocket, f: Cmd): Promise<void> {
    switch (f.type) {
      case 'cmd:hello':
        this.handleHello(ws, f);
        return;
      case 'cmd:sys.stats': {
        // нагрузка машины: средняя за минуту, память, свободное место на диске хранилища/рабочей папки
        const diskRoot = this.projects?.root() ?? process.cwd();
        const diskFree = freeBytes(diskRoot);
        this.sendReply(ws, this.ack(f.id, {
          load1: loadavg()[0] ?? null,
          cores: cpus().length,
          memTotal: totalmem(),
          memFree: freemem(),
          uptimeSec: Math.floor(uptime()),
          ...(diskFree !== undefined ? { diskFree } : {}),
        }));
        return;
      }
      case 'cmd:session.list': {
        this.sendReply(ws, this.ack(f.id, { sessions: this.manager.list().map((s) => this.publicSession(s)) }));
        return;
      }
      case 'cmd:session.new': {
        // проект: дефолты применяются к незаданным полям, cwd — путь проекта
        const project = f.projectId !== undefined ? this.projects?.get(f.projectId) : undefined;
        if (f.projectId !== undefined && !project) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROJECT', `проекта ${f.projectId} нет`));
          return;
        }
        const profileName = f.profile ?? project?.profile;
        if (profileName !== undefined && !this.profiles.get(profileName)) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${profileName}» нет в profiles.json`));
          return;
        }
        // `default` (аккаунт supervisor'а) внутри — сессия без профиля: её обслуживает пул
        const profile = this.profiles.internal(profileName);
        // дефолты: явное в кадре → дефолт проекта → рабочие значения supervisor'а
        const model = f.model ?? project?.model;
        const permissionMode = f.permissionMode ?? project?.permissionMode;
        if (f.ultracode === true && !this.profiles.ultracodeAllowed(profile)) {
          this.sendReply(ws, this.err(f.id, 'ULTRACODE_DISABLED', `у аккаунта «${this.profiles.external(profile) ?? '—'}» ultracode выключен`));
          return;
        }
        const efforts = this.profiles.effortsFor(profile, model);
        if (f.effort !== undefined && efforts !== null && !efforts.includes(f.effort)) {
          this.sendReply(ws, this.err(f.id, 'EFFORT_UNSUPPORTED', effortText(model, efforts)));
          return;
        }
        // усилие по умолчанию аккаунта — только если модель его принимает (иначе сессия просто без него)
        const defEffort = this.profiles.get(this.profiles.external(profile))?.defaultEffort;
        const effort = f.effort ?? (defEffort !== undefined && (efforts === null || efforts.includes(defEffort)) ? defEffort : undefined);
        const sess = {
          // cwd обязателен: по нему считается путь транскрипта для ресинка.
          ...(f.cwd !== undefined || project?.path !== undefined
            ? { cwd: f.cwd ?? project?.path }
            : { cwd: process.cwd() }),
          ...(model !== undefined ? { model } : {}),
          ...(permissionMode !== undefined ? { permissionMode } : {}),
          ...(profile !== undefined ? { profile } : {}),
          ...(project !== undefined ? { projectId: project.id } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(f.ultracode === true ? { ultracode: true } : {}),
          ...(f.compactWindow !== undefined ? { compactWindow: f.compactWindow } : {}),
        };
        if (this.ensureDirs && !isDir(sess.cwd!)) {
          this.sendReply(ws, this.err(f.id, 'CWD_NOT_FOUND', `папки ${sess.cwd} нет на сервере — сессию не запустить (создайте папку или поменяйте путь проекта)`));
          return;
        }
        // пул: тёплый слот своего профиля → сессия стартует мгновенно (claim вместо spawn).
        // SpareProcess фиксирует env на prewarm — поэтому у каждого профиля свой тёплый процесс (ProfilePools)
        // тёплому процессу — модель для запуска (с [1m], если у модели аккаунта включён 1M); в реестре — как выбрана.
        // Окно контекста своей модели Claude Code берёт только при старте процесса (claim его не применяет) —
        // такая сессия стартует холодной. Так же холодно стартует сессия с делегированием:
        // in-process MCP-сервер фиксируется на prewarm, claim его не переустанавливает.
        const launch = this.profiles.launchSession(profile, model ?? this.profiles.get(this.profiles.external(profile))?.model, f.compactWindow);
        const delegateOn = f.parentSessionId === undefined && this.profiles.delegateAllowed(profile);
        const warm = launch.window !== undefined || delegateOn ? null : this.pool?.take(
          {
            ...sess,
            ...(launch.model !== undefined ? { model: launch.model } : {}),
            ...(!this.profiles.ultracodeAllowed(profile) ? { ultracodeKeyword: false } : {}),
            ...(this.profiles.outputTokens(profile, sess.effort) !== undefined ? { outputTokens: this.profiles.outputTokens(profile, sess.effort)! } : {}),
          },
          profile,
        ) ?? null;
        const sid = randomUUID();
        const factory: SessionCreateOptions['factory'] = warm ?? this.sessionFactory(
          { ...sess, ...(f.parentSessionId !== undefined ? { parentSessionId: f.parentSessionId } : {}) },
          sid,
        );
        this.manager.create({
          id: sid,
          ...(f.name !== undefined ? { name: f.name } : {}),
          ...sess,
          factory,
          ...(f.parentSessionId !== undefined ? { parentSessionId: f.parentSessionId } : {}),
          ...(f.agentOf !== undefined ? { agentOf: f.agentOf } : {}),
          ...(this.resumeFactory ? { resumeFactory: this.resumeFactory } : {}),
          ...(this.forkFactory ? { forkFactory: this.forkFactory } : {}),
        });
        this.sendReply(ws, this.ack(f.id, { sessionId: sid }));
        return;
      }
      case 'cmd:session.settings': {
        const sid = f.sessionId ?? '';
        // всё проверяемое — до каких-либо изменений: никакого частичного применения при err
        if (f.profile !== undefined && !this.profiles.get(f.profile)) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`));
          return;
        }
        const cur = this.manager.get(sid);
        if (!cur) {
          this.sendReply(ws, this.err(f.id, 'SETTINGS_FAILED', `Error: нет сессии ${sid}`));
          return;
        }
        const targetProfile = f.profile !== undefined ? this.profiles.internal(f.profile) : cur.profile;
        const switching = f.profile !== undefined && targetProfile !== cur.profile;
        const targetModel = f.model ?? cur.model;
        if (f.ultracode === true && !this.profiles.ultracodeAllowed(targetProfile)) {
          this.sendReply(ws, this.err(f.id, 'ULTRACODE_DISABLED', `у аккаунта «${this.profiles.external(targetProfile) ?? '—'}» ultracode выключен`));
          return;
        }
        const efforts = this.profiles.effortsFor(targetProfile, targetModel);
        if (f.effort !== undefined && f.effort !== null && efforts !== null && !efforts.includes(f.effort)) {
          this.sendReply(ws, this.err(f.id, 'EFFORT_UNSUPPORTED', effortText(targetModel, efforts)));
          return;
        }
        // неявные последствия смены аккаунта/модели: ultracode туда, где его нет, не переносим;
        // усилие, которого новая модель не знает, сбрасываем на её умолчание
        let effort: EffortLevel | null | undefined = f.effort;
        if (effort === undefined && cur.effort !== undefined && (switching || f.model !== undefined) && efforts !== null && !efforts.includes(cur.effort)) effort = null;
        const ultracode = f.ultracode ?? (cur.ultracode === true && !this.profiles.ultracodeAllowed(targetProfile) ? false : undefined);
        try {
          const before = cur;
          const nextProfile = switching ? targetProfile : undefined;
          if (switching) {
            if (before.state !== 'idle' && before.state !== 'dead') {
              this.sendReply(ws, this.err(f.id, 'BUSY', 'смена аккаунта возможна только между ходами (idle/dead)'));
              return;
            }
            // у аккаунта свой CLAUDE_CONFIG_DIR/projects: без переноса resume под новым аккаунтом не найдёт историю
            if (before.claudeSessionId && before.cwd) {
              carryTranscript(this.configDirFor(before.profile), this.configDirFor(nextProfile), before.cwd, before.claudeSessionId);
            }
            // модель/режим/усилие уходят в параметры возрождения, а не в старый процесс другого аккаунта
            const r = this.manager.switchProfile(sid, nextProfile, {
              ...(f.model !== undefined ? { model: f.model } : {}),
              ...(f.permissionMode !== undefined ? { permissionMode: f.permissionMode } : {}),
              ...(effort !== undefined ? { effort } : {}),
              ...(ultracode !== undefined ? { ultracode } : {}),
            });
            if (r === 'busy') {
              this.sendReply(ws, this.err(f.id, 'BUSY', 'смена аккаунта возможна только между ходами (idle/dead)'));
              return;
            }
            if (r === 'not-found') throw new Error(`нет сессии ${sid}`);
          } else {
            if (f.model !== undefined) {
              const def = this.profiles.get(this.profiles.external(cur.profile))?.model;
              const was = this.profiles.launchSession(cur.profile, cur.model ?? def, cur.compactWindow);
              const next = this.profiles.launchSession(cur.profile, f.model, f.compactWindow === null ? undefined : f.compactWindow ?? cur.compactWindow);
              if (was.window !== next.window && cur.state !== 'dead') {
                // окно контекста Claude Code берёт только при старте процесса: между ходами процесс гасим,
                // следующее сообщение поднимет его через resume уже с новым окном (история та же)
                if (cur.state !== 'idle' && cur.state !== 'error' && cur.state !== 'interrupted') {
                  this.sendReply(ws, this.err(f.id, 'BUSY', 'модель с другим окном контекста — только между ходами: дождитесь конца хода или нажмите «Стоп»'));
                  return;
                }
                await this.manager.stop(sid);
              }
              const ok = await this.manager.setModel(sid, f.model, next.model ?? f.model);
              if (!ok) throw new Error('движок не поддерживает смену модели');
            }
            // окно автокомпакта сессии (смена модели выше его уже учла): Claude Code берёт его только при старте
            // процесса — между ходами гасим, следующее сообщение поднимет с новым окном (история та же)
            if (f.compactWindow !== undefined && f.model === undefined) {
              const def = this.profiles.get(this.profiles.external(cur.profile))?.model;
              const m = cur.model ?? def;
              const was = this.profiles.launchSession(cur.profile, m, cur.compactWindow);
              const next = this.profiles.launchSession(cur.profile, m, f.compactWindow ?? undefined);
              if (was.window !== next.window && cur.state !== 'dead') {
                if (cur.state !== 'idle' && cur.state !== 'error' && cur.state !== 'interrupted') {
                  this.sendReply(ws, this.err(f.id, 'BUSY', 'автокомпакт меняется между ходами: дождитесь конца хода или нажмите «Стоп»'));
                  return;
                }
                await this.manager.stop(sid);
              }
            }
            if (f.compactWindow !== undefined) this.manager.setCompactWindow(sid, f.compactWindow);
            if (f.permissionMode !== undefined) {
              const ok = await this.manager.setPermissionMode(sid, f.permissionMode);
              if (!ok) throw new Error('движок не поддерживает смену режима');
            }
            if (effort !== undefined || ultracode !== undefined) {
              // лимит ответа аккаунта зависит от усилия (xhigh и выше — свой) — меняется вместе с ним
              const outputTokens = effort !== undefined ? this.profiles.outputTokens(cur.profile, effort) : undefined;
              const ok = await this.manager.setFlags(sid, {
                ...(effort !== undefined ? { effort } : {}),
                ...(ultracode !== undefined ? { ultracode } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
              });
              if (!ok) throw new Error('движок не поддерживает смену усилия и ultracode');
            }
          }
          this.sendReply(ws, this.ack(f.id, { session: this.publicSession(this.manager.get(sid)) }));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'SETTINGS_FAILED', String(err)));
        }
        return;
      }
      case 'cmd:session.context': {
        try {
          const ctx = await this.manager.getContext(f.sessionId ?? '');
          if (ctx === null) {
            this.sendReply(ws, this.err(f.id, 'CONTEXT_UNAVAILABLE', 'движок не отдал контекст (процесс не запущен?)'));
          } else {
            this.sendReply(ws, this.ack(f.id, ctx as Record<string, unknown>));
          }
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'SESSION_NOT_FOUND', String(err)));
        }
        return;
      }
      case 'cmd:profile.models': {
        if (!this.profiles.get(f.profile)) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`));
          return;
        }
        // ручной список (шлюзы) у Claude Code не спрашиваем — он отдал бы чужие модели
        if (f.refresh === true && this.profiles.modelsSource(f.profile) === 'auto') {
          try {
            await this.refreshModels(f.profile);
          } catch (err) {
            this.sendReply(ws, this.err(f.id, 'MODELS_FAILED', `список моделей не получен: ${String((err as Error)?.message ?? err)}`));
            return;
          }
        }
        this.sendReply(ws, this.ack(f.id, { profile: this.profiles.info(f.profile) }));
        return;
      }
      case 'cmd:profile.usage': {
        if (!this.profiles.get(f.profile)) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`));
          return;
        }
        const internal = this.profiles.internal(f.profile);
        const key = internal ?? '';
        const source = this.profiles.usageSource(internal);
        if (source === undefined) {
          this.sendReply(ws, this.ack(f.id, { usage: null, note: 'у этого аккаунта нет лимитов подписки (ключ API или шлюз без квоты)' }));
          return;
        }
        const known = this.usage.get(key);
        // свежее минуты — не дёргаем источник без просьбы
        if (known && f.refresh !== true && Date.now() - known.at < 60_000) {
          this.sendReply(ws, this.ack(f.id, { usage: known }));
          return;
        }
        // подписка, у которой /usage недоступен, — без похода к Claude Code (кроме явного «обновить»)
        if (source === 'claude' && this.usageApiDead.has(key) && f.refresh !== true) {
          this.sendReply(ws, this.ack(f.id, known ? { usage: known } : { usage: null, note: 'Лимиты появятся после первого хода в сессии этого аккаунта: Claude Code узнаёт их из ответов API' }));
          return;
        }
        void (async () => {
          let got: UsageInfo | null = null;
          let err = '';
          if (this.usageFetcher) {
            try { got = await this.usageFetcher(f.profile); } catch (e) { err = String((e as Error)?.message ?? e).slice(0, 200); }
          }
          if (source === 'claude') { if (got) this.usageApiDead.delete(key); else this.usageApiDead.add(key); }
          if (got) {
            this.usage.set(key, got);
            this.broadcastUsage(internal, got);
          }
          const out = got ?? known ?? null;
          const note = out ? undefined : source === 'claude'
            ? 'Лимиты появятся после первого хода в сессии этого аккаунта: Claude Code узнаёт их из ответов API'
            : `z.ai не ответил лимитами${err ? `: ${err}` : ''}`;
          this.sendReply(ws, this.ack(f.id, { usage: out, ...(note ? { note } : {}) }));
        })();
        return;
      }
      case 'cmd:profile.update': {
        if (!this.profiles.get(f.profile)) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`));
          return;
        }
        // 1M и свои модели касаются и идущих сессий аккаунта: запомним, чем они запущены сейчас
        const internalName = this.profiles.internal(f.profile);
        const defBefore = this.profiles.get(f.profile)?.model;
        // ключ до смены: его копии в MCP других аккаунтов (набор z.ai и т. п.) заменим новым
        const keyBefore = f.apiKey !== undefined ? this.accountKey(f.profile) : undefined;
        const live = f.long !== undefined || f.custom !== undefined || f.compactWindow !== undefined
          ? this.manager.list()
            .filter((s) => s.profile === internalName && s.state !== 'dead')
            .map((s) => ({ s, was: this.profiles.launchSession(internalName, s.model ?? defBefore, s.compactWindow) }))
          : [];
        try {
          this.profiles.update(f.profile, {
            ...(f.displayName !== undefined ? { displayName: f.displayName } : {}),
            ...(f.models !== undefined ? { models: f.models } : {}),
            ...(f.modelsSource !== undefined ? { modelsSource: f.modelsSource } : {}),
            ...(f.model !== undefined ? { model: f.model } : {}),
            ...(f.long !== undefined ? { long: f.long } : {}),
            ...(f.custom !== undefined ? { custom: f.custom } : {}),
            ...(f.defaultEffort !== undefined ? { defaultEffort: f.defaultEffort } : {}),
            ...(f.ultracode !== undefined ? { ultracode: f.ultracode } : {}),
            ...(f.delegate !== undefined ? { delegate: f.delegate } : {}),
            ...(f.nativeAgents !== undefined ? { nativeAgents: f.nativeAgents } : {}),
            ...(f.maxOutput !== undefined ? { maxOutput: f.maxOutput } : {}),
            ...(f.maxOutputHigh !== undefined ? { maxOutputHigh: f.maxOutputHigh } : {}),
            ...(f.tasks !== undefined ? { tasks: f.tasks } : {}),
            ...(f.effortFallback !== undefined ? { effortFallback: f.effortFallback } : {}),
            ...(f.compactWindow !== undefined ? { compactWindow: f.compactWindow } : {}),
            ...(f.usage !== undefined ? { usage: f.usage } : {}),
            ...(f.apiKey !== undefined ? { apiKey: f.apiKey } : {}),
          });
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'PROFILE_UPDATE_FAILED', `профиль не сохранён: ${String((err as Error)?.message ?? err)}`));
          return;
        }
        // новый ключ: процессы claude этого аккаунта живут со старым env — останавливаем простаивающие,
        // следующее сообщение поднимет их через resume уже с новым ключом; занятые — после хода, руками
        let restarted = 0;
        let busy = 0;
        if (f.apiKey !== undefined) {
          const internal = this.profiles.internal(f.profile);
          for (const s of this.manager.list()) {
            if (s.profile !== internal || s.state === 'dead') continue;
            if (s.state === 'idle' || s.state === 'error' || s.state === 'interrupted') {
              restarted += 1;
              void this.manager.stop(s.id).catch(() => undefined);
            } else {
              busy += 1;
            }
          }
          console.log(`[profile] ${f.profile}: ключ API заменён; остановлено простаивающих сессий ${restarted}, занятых ${busy}`);
          // тёплый процесс профиля прогрет со старым ключом — пересоздать
          this.pool?.reset?.(internal);
          const keyAfter = this.accountKey(f.profile);
          if (keyBefore && keyAfter && keyBefore !== keyAfter) void this.rekeyMcp(f.profile, keyBefore, keyAfter);
        }
        // лимит ответа — идущим сессиям аккаунта сразу (env на ходу); снят совсем — «по умолчанию» явно
        if (f.maxOutput !== undefined || f.maxOutputHigh !== undefined) {
          for (const s of this.manager.list()) {
            if (s.profile !== internalName || s.state === 'dead') continue;
            void this.manager.setFlags(s.id, { outputTokens: this.profiles.outputTokens(internalName, s.effort) ?? null }).catch(() => undefined);
          }
        }
        // инструменты (задачи, нативные субагенты) фиксируются на старте процесса: тёплый процесс — пересоздать;
        // идущие сессии получат их со следующим процессом (после простоя/respawn)
        if (f.tasks !== undefined || f.nativeAgents !== undefined) this.pool?.reset?.(internalName);
        // 1M переключается сменой модели на ходу; окно контекста — только новым процессом:
        // простаивающие гасим (следующее сообщение поднимет с новым окном), занятые подхватят после «Стоп»
        for (const { s, was } of live) {
          const model = s.model ?? this.profiles.get(f.profile)?.model;
          if (model === undefined) continue;
          const now = this.profiles.launchSession(internalName, model, s.compactWindow);
          if (now.window !== was.window) {
            if (s.state === 'idle' || s.state === 'error' || s.state === 'interrupted') void this.manager.stop(s.id).catch(() => undefined);
          } else if (now.model !== undefined && now.model !== was.model) {
            void this.manager.setModel(s.id, model, now.model).catch(() => undefined);
          }
        }
        this.broadcastProfiles();
        // вернулись к списку из Claude Code, а его ещё нет — подтянем в фоне (придёт event:profiles)
        if (f.modelsSource === 'auto' && this.profiles.models(f.profile) === undefined && this.modelsFetcher) {
          void this.refreshModels(f.profile).catch(() => undefined);
        }
        this.sendReply(ws, this.ack(f.id, { profile: this.profiles.info(f.profile), ...(f.apiKey !== undefined ? { restarted, busy } : {}) }));
        return;
      }
      case 'cmd:profile.add': {
        if (this.profiles.get(f.name)) {
          this.sendReply(ws, this.err(f.id, 'PROFILE_EXISTS', `аккаунт «${f.name}» уже есть — выберите другое имя`));
          return;
        }
        let tokenDir: string | undefined;
        try {
          if (f.template === 'claude-token') tokenDir = prepareAccountDir(this.accountsDir, `tok-${randomSlug()}`, profileConfigDir(undefined));
          const p = this.profiles.create(profileFromTemplate({
            name: f.name, template: f.template, apiKey: f.apiKey,
            ...(tokenDir !== undefined ? { configDir: tokenDir } : {}),
            ...(f.displayName !== undefined ? { displayName: f.displayName } : {}),
            ...(f.baseUrl !== undefined ? { baseUrl: f.baseUrl } : {}),
            ...(f.models !== undefined ? { models: f.models } : {}),
          }));
          console.log(`[profile] добавлен аккаунт ${p.name} (${f.template}, ключ …${f.apiKey.slice(-4)})`);
        } catch (err) {
          if (tokenDir !== undefined) removeAccountDirIfUnused(tokenDir);
          this.sendReply(ws, this.err(f.id, 'PROFILE_ADD_FAILED', `аккаунт не добавлен: ${String((err as Error)?.message ?? err)}`));
          return;
        }
        this.broadcastProfiles();
        // общие MCP, затем (у z.ai) — его стандартный набор всем
        void this.syncSharedMcp(f.name)
          .then(() => (f.template === 'zai' ? this.installZaiPreset() : undefined))
          .catch((err) => console.log(`[mcp] ${f.name}: набор z.ai не поставлен — ${String((err as Error)?.message ?? err)}`));
        if (f.template === 'claude-token') void this.refreshAuth([f.name]);
        if (this.profiles.modelsSource(f.name) === 'auto' && this.modelsFetcher) void this.refreshModels(f.name).catch(() => undefined);
        this.sendReply(ws, this.ack(f.id, { profile: this.profiles.info(f.name) }));
        return;
      }
      case 'cmd:profile.check': {
        let req: Parameters<typeof checkKey>[0];
        // токен подписки работает только внутри Claude Code — проверяем им самим
        const token = f.profile !== undefined ? this.profiles.get(f.profile)?.env?.['CLAUDE_CODE_OAUTH_TOKEN'] : f.template === 'claude-token' ? f.apiKey : undefined;
        if (f.template === 'claude-token' && !f.apiKey && f.profile === undefined) { this.sendReply(ws, this.err(f.id, 'NO_KEY', 'вставьте токен')); return; }
        if (token !== undefined) {
          this.sendReply(ws, this.ack(f.id, await this.tokenCheck(token)));
          return;
        }
        if (f.profile !== undefined) {
          const p = this.profiles.get(f.profile);
          if (!p) { this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`)); return; }
          const keyVar = p.env?.['ANTHROPIC_API_KEY'] !== undefined && p.env['ANTHROPIC_AUTH_TOKEN'] === undefined ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
          const apiKey = p.env?.[keyVar];
          if (!apiKey) { this.sendReply(ws, this.err(f.id, 'NO_KEY', 'у аккаунта нет ключа API')); return; }
          const baseUrl = p.env?.['ANTHROPIC_BASE_URL'];
          req = { keyVar, apiKey, model: f.model ?? p.model ?? KEY_TEMPLATES.anthropic.checkModel, ...(baseUrl ? { baseUrl } : {}) };
        } else {
          const t = KEY_TEMPLATES[f.template ?? 'anthropic'];
          if (!f.apiKey) { this.sendReply(ws, this.err(f.id, 'NO_KEY', 'вставьте ключ API')); return; }
          const baseUrl = f.template === 'custom' ? f.baseUrl : t.baseUrl;
          if (f.template === 'custom' && !baseUrl) { this.sendReply(ws, this.err(f.id, 'NO_URL', 'для «Свой адрес» нужен адрес API')); return; }
          req = { keyVar: t.keyVar === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN', apiKey: f.apiKey, model: f.model ?? t.checkModel, ...(baseUrl ? { baseUrl } : {}) };
        }
        const r = await this.keyCheck(req);
        this.sendReply(ws, this.ack(f.id, r));
        return;
      }
      case 'cmd:profile.login.start': {
        let configDir: string | undefined;
        let fresh = false;
        let target: string | undefined;
        if (f.profile !== undefined) {
          const p = this.profiles.get(f.profile);
          if (!p) { this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`)); return; }
          if (usesKey(p)) { this.sendReply(ws, this.err(f.id, 'LOGIN_NOT_NEEDED', 'этот аккаунт работает по ключу API — входить не нужно')); return; }
          configDir = explicitConfigDir(p);
          target = f.profile;
        } else {
          if (f.name !== undefined && this.profiles.get(f.name)) {
            this.sendReply(ws, this.err(f.id, 'PROFILE_EXISTS', `аккаунт «${f.name}» уже есть — выберите другое имя`));
            return;
          }
          try {
            configDir = prepareAccountDir(this.accountsDir, `acc-${randomSlug()}`, profileConfigDir(undefined));
            fresh = true;
          } catch (err) {
            this.sendReply(ws, this.err(f.id, 'LOGIN_FAILED', `папка аккаунта не создана: ${String((err as Error)?.message ?? err)}`));
            return;
          }
        }
        const onDone = (a: { email?: string; plan?: string }): string => {
          let name = target;
          if (name === undefined) {
            name = f.name ?? this.profiles.freeName(a.email ?? 'claude');
            const displayName = f.displayName ?? a.email;
            this.profiles.create({
              name, configDir,
              ...(displayName !== undefined ? { displayName } : {}),
              description: a.plan ? `подписка ${a.plan}` : 'подписка Claude',
            });
          }
          this.profiles.setAuth(name, { loggedIn: true, ...(a.email ? { email: a.email } : {}), ...(a.plan ? { plan: a.plan } : {}) });
          console.log(`[profile] вход в аккаунт ${name} выполнен`);
          this.broadcastProfiles();
          if (target === undefined) void this.syncSharedMcp(name);
          if (this.modelsFetcher) void this.refreshModels(name).catch(() => undefined);
          return name;
        };
        try {
          const r = await this.logins.start({ configDir, fresh, width: f.width, height: f.height, onDone });
          this.sendReply(ws, this.ack(f.id, r));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'LOGIN_FAILED', `вход не начался: ${String((err as Error)?.message ?? err)}`));
        }
        return;
      }
      case 'cmd:profile.token.start': {
        // временная папка: `setup-token` ничего не сохраняет, но настройки владельца (шлюз в settings.json) ему не нужны
        let dir: string;
        try {
          dir = mkdtempSync(join(tmpdir(), 'cc-setup-token-'));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'LOGIN_FAILED', `временная папка не создана: ${String((err as Error)?.message ?? err)}`));
          return;
        }
        try {
          const r = await this.logins.start({
            configDir: dir, fresh: false, width: 0, height: 0, args: ['setup-token'], ownBrowser: true,
            capture: findOAuthToken,
            cleanup: () => rmSync(dir, { recursive: true, force: true }),
            onDone: () => '',
          });
          console.log('[profile] выпуск токена подписки: вход в браузере этой машины');
          this.sendReply(ws, this.ack(f.id, { loginId: r.loginId, ...(r.url ? { url: r.url } : {}) }));
        } catch (err) {
          rmSync(dir, { recursive: true, force: true });
          this.sendReply(ws, this.err(f.id, 'LOGIN_FAILED', `выпуск токена не начался: ${String((err as Error)?.message ?? err)}`));
        }
        return;
      }
      case 'cmd:profile.token.take': {
        const token = this.logins.take(f.loginId);
        if (!token) { this.sendReply(ws, this.err(f.id, 'NO_TOKEN', 'токена нет — выпуск не завершён или его уже забрали')); return; }
        // длина и вид — для разбора «Anthropic не принял токен» (сам токен в журнал не пишем)
        console.log(`[profile] токен подписки выпущен и отдан окну: ${token.length} символов, ${token.slice(0, 13)}…`);
        this.sendReply(ws, this.ack(f.id, { token }));
        return;
      }
      case 'cmd:profile.login.code': {
        try {
          this.logins.submitCode(f.loginId, f.code);
          this.sendReply(ws, this.ack(f.id, {}));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'LOGIN_FAILED', String((err as Error)?.message ?? err)));
        }
        return;
      }
      case 'cmd:profile.login.cancel': {
        await this.logins.cancel(f.loginId);
        this.sendReply(ws, this.ack(f.id, {}));
        return;
      }
      case 'cmd:mcp.list':
      case 'cmd:mcp.add':
      case 'cmd:mcp.remove': {
        const p = this.profiles.get(f.profile);
        if (!p) { this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`)); return; }
        const dir = explicitConfigDir(p);
        const env: Record<string, string> = usesSubToken(p) ? { CLAUDE_CODE_OAUTH_TOKEN: p.env!['CLAUDE_CODE_OAUTH_TOKEN']! } : {};
        try {
          if (f.type === 'cmd:mcp.add') {
            const key = usesSubToken(p) ? undefined : p.env?.[keyVar(p.env)];
            const cfg = withAccountKey(f.config, { ...(key ? { key } : {}), ...(p.env?.['ANTHROPIC_BASE_URL'] ? { baseUrl: p.env['ANTHROPIC_BASE_URL'] } : {}) });
            await mcpAdd(this.mcpDeps, dir, f.name, cfg, env);
            console.log(`[mcp] ${f.profile}: добавлен ${f.name} (${f.config.type})`);
          } else if (f.type === 'cmd:mcp.remove') {
            await mcpRemove(this.mcpDeps, dir, f.name, env);
            console.log(`[mcp] ${f.profile}: удалён ${f.name}`);
          }
          this.sendReply(ws, this.ack(f.id, { servers: await mcpList(this.mcpDeps, dir, env) }));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'MCP_FAILED', String((err as Error)?.message ?? err)));
        }
        return;
      }
      case 'cmd:mcp.shared': {
        try {
          const targets = this.mcpTargets();
          const lists = await Promise.all(targets.map(async (t) => ({
            t,
            user: readUserMcp(t.dir),
            listed: f.check ? await mcpList(this.mcpDeps, t.dir, t.env).catch(() => null) : null,
          })));
          const stored = this.mcpStore.all();
          const names = new Set<string>([...Object.keys(stored), ...lists.flatMap((l) => Object.keys(l.user))]);
          const servers = [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
            const raw = (stored[name]?.config as unknown as Record<string, unknown> | undefined) ?? lists.map((l) => l.user[name]).find((x) => x !== undefined);
            const info = mergeMcp(new Map(), raw ? { [name]: raw } : {})[0];
            const on: Record<string, { status: McpStatus; statusText: string }> = {};
            for (const l of lists) {
              if (!l.user[name]) continue;
              const s = l.listed?.find((x) => x.name === name);
              on[l.t.id] = { status: s?.status ?? 'unknown', statusText: s?.statusText ?? 'не проверялся' };
            }
            return {
              name, transport: info?.transport ?? 'stdio', target: info?.target ?? '',
              ...(info?.headerNames ? { headerNames: info.headerNames } : {}),
              ...(info?.envNames ? { envNames: info.envNames } : {}),
              accountKey: stored[name]?.template !== undefined, stored: stored[name] !== undefined, on,
            };
          });
          // из проекта, плагина или claude.ai — не переключаются, просто видны
          const other = new Map<string, { name: string; transport: McpServerInfo['transport']; target: string; targets: string[] }>();
          for (const l of lists) {
            for (const s of l.listed ?? []) {
              if (s.scope !== 'other') continue;
              const o = other.get(s.name) ?? { name: s.name, transport: s.transport, target: s.target, targets: [] };
              o.targets.push(l.t.id);
              other.set(s.name, o);
            }
          }
          // набор z.ai: есть аккаунт z.ai, а каких-то серверов набора в общем списке нет
          const hasZai = targets.some((t) => t.profiles.some((p) => isZaiGateway(accountEnv(p)['ANTHROPIC_BASE_URL'])));
          const zaiMissing = hasZai ? Object.keys(ZAI_MCP_PRESET).filter((n) => !names.has(n)) : [];
          this.sendReply(ws, this.ack(f.id, {
            targets: targets.map((t) => ({ id: t.id, profiles: t.profiles.map((p) => p.name) })), servers, other: [...other.values()],
            ...(zaiMissing.length ? { presets: [{ id: 'zai', missing: zaiMissing }] } : {}),
          }));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'MCP_FAILED', String((err as Error)?.message ?? err)));
        }
        return;
      }
      case 'cmd:mcp.toggle': {
        const targets = this.mcpTargets();
        const t = targets.find((x) => x.profiles.some((p) => p.name === f.profile));
        if (!t) { this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `аккаунта «${f.profile}» нет среди тех, кому доступны MCP`)); return; }
        try {
          const e = this.ensureStored(f.name, targets);
          if (f.on) {
            if (!readUserMcp(t.dir)[f.name]) await mcpAdd(this.mcpDeps, t.dir, f.name, configFor(e, this.keysOf(t)), t.env);
          } else if (readUserMcp(t.dir)[f.name]) {
            await mcpRemove(this.mcpDeps, t.dir, f.name, t.env);
          }
          console.log(`[mcp] ${t.id}: ${f.name} ${f.on ? 'включён' : 'выключен'}`);
          this.sendReply(ws, this.ack(f.id, {}));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'MCP_FAILED', String((err as Error)?.message ?? err)));
        }
        return;
      }
      case 'cmd:mcp.shared.add': {
        const bad = validateMcp(f.name, f.config);
        if (bad) { this.sendReply(ws, this.err(f.id, 'MCP_FAILED', bad)); return; }
        const targets = this.mcpTargets().filter((t) => !f.profiles || t.profiles.some((p) => f.profiles!.includes(p.name)));
        try {
          this.sendReply(ws, this.ack(f.id, { results: await this.sharedAdd(f.name, f.config, targets) }));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'MCP_FAILED', String((err as Error)?.message ?? err)));
        }
        return;
      }
      case 'cmd:mcp.preset': {
        try {
          this.sendReply(ws, this.ack(f.id, await this.installZaiPreset()));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'MCP_FAILED', String((err as Error)?.message ?? err)));
        }
        return;
      }
      case 'cmd:mcp.shared.remove': {
        const results: Array<{ profile: string; ok: boolean; error?: string }> = [];
        for (const t of this.mcpTargets()) {
          if (!readUserMcp(t.dir)[f.name]) continue;
          try {
            await mcpRemove(this.mcpDeps, t.dir, f.name, t.env);
            results.push({ profile: t.id, ok: true });
          } catch (err) {
            results.push({ profile: t.id, ok: false, error: String((err as Error)?.message ?? err) });
          }
        }
        if (results.every((r) => r.ok)) this.mcpStore.remove(f.name);
        console.log(`[mcp] общий ${f.name}: удалён у ${results.filter((r) => r.ok).map((r) => r.profile).join(', ') || 'никого'}`);
        this.sendReply(ws, this.ack(f.id, { results }));
        return;
      }
      case 'cmd:mcp.catalog.search': {
        try {
          this.sendReply(ws, this.ack(f.id, await searchCatalog(f.query, this.catalogDeps)));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'CATALOG_FAILED', `каталог MCP недоступен: ${String((err as Error)?.message ?? err)}`));
        }
        return;
      }
      case 'cmd:mcp.login.start': {
        const p = this.profiles.get(f.profile);
        if (!p) { this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`)); return; }
        const dir = explicitConfigDir(p);
        const env: Record<string, string> = usesSubToken(p) ? { CLAUDE_CODE_OAUTH_TOKEN: p.env!['CLAUDE_CODE_OAUTH_TOKEN']! } : {};
        try {
          const r = await this.logins.start({
            configDir: dir, fresh: false, width: f.width, height: f.height,
            args: ['mcp', 'login', f.name, '--no-browser'],
            // возврат на http://localhost:<порт>/callback сервера Claude Code ловит сам — вставлять нечего
            extractCode: () => null,
            check: async () => {
              const s = (await mcpList(this.mcpDeps, dir, env)).find((x) => x.name === f.name);
              return { loggedIn: s?.status === 'connected' };
            },
            onDone: () => { console.log(`[mcp] ${f.profile}: вход в ${f.name} выполнен`); return f.profile; },
          });
          this.sendReply(ws, this.ack(f.id, r));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'LOGIN_FAILED', `вход не начался: ${String((err as Error)?.message ?? err)}`));
        }
        return;
      }
      case 'cmd:project.list': {
        this.sendReply(ws, this.ack(f.id, { projects: this.projects?.list() ?? [] }));
        return;
      }
      case 'cmd:project.new': {
        if (!this.projects) { this.sendReply(ws, this.err(f.id, 'NOT_CONFIGURED', 'хранилище проектов не сконфигурировано')); return; }
        if (f.profile !== undefined && !this.profiles.get(f.profile)) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`));
          return;
        }
        // папка проекта: нет — создаём (новый проект часто = новая папка); нет прав — честная ошибка, проект не создаём
        const projErr = this.ensureDirs ? ensureProjectDir(f.path) : null;
        if (projErr) { this.sendReply(ws, this.err(f.id, 'PROJECT_PATH', projErr)); return; }
        const p = this.projects.create({
          name: f.name, path: f.path,
          ...(f.profile !== undefined ? { profile: f.profile } : {}),
          ...(f.model !== undefined ? { model: f.model } : {}),
          ...(f.permissionMode !== undefined ? { permissionMode: f.permissionMode } : {}),
        });
        this.sendReply(ws, this.ack(f.id, { project: p }));
        return;
      }
      case 'cmd:storage.set': {
        if (!this.projects) { this.sendReply(ws, this.err(f.id, 'NOT_CONFIGURED', 'хранилище проектов не сконфигурировано')); return; }
        const root = f.root.trim();
        const e = ensureProjectDir(root);
        if (e) { this.sendReply(ws, this.err(f.id, 'STORAGE_PATH', e.replace('путь проекта', 'путь хранилища'))); return; }
        this.projects.setRoot(root);
        console.log(`[storage] корень проектов: ${root}`);
        this.sendReply(ws, this.ack(f.id, { storage: this.storageInfo() }));
        return;
      }
      case 'cmd:project.inspect': {
        if (!this.projects) { this.sendReply(ws, this.err(f.id, 'NOT_CONFIGURED', 'хранилище проектов не сконфигурировано')); return; }
        const path = projectPath(this.projects.root(), f.slug, f.path);
        if (path === null || !isAbsolute(path)) {
          this.sendReply(ws, this.err(f.id, 'PROJECT_PATH', path === null ? 'нужна папка: имя (slug) или свой путь' : `путь должен быть абсолютным: ${path}`));
          return;
        }
        if (f.source === 'git' && f.gitUrl !== undefined && !validGitUrl(f.gitUrl)) {
          this.sendReply(ws, this.err(f.id, 'GIT_URL', `не похоже на адрес репозитория: ${maskUrl(f.gitUrl)}`));
          return;
        }
        const info = await inspectDir(path, this.git, GIT_INFO_TIMEOUT_MS);
        const pl = planFor(f.source, info, f.gitUrl);
        this.sendReply(ws, this.ack(f.id, {
          path, inStorage: insideRoot(this.projects.root(), path),
          exists: info.exists, isDir: info.isDir, empty: info.empty,
          ...(info.git ? { git: { ...info.git, origin: info.git.origin === null ? null : maskUrl(info.git.origin) } } : {}),
          plan: pl.plan,
          ...(pl.sameOrigin !== undefined ? { sameOrigin: pl.sameOrigin } : {}),
          ...(pl.reason !== undefined ? { reason: pl.reason } : {}),
        }));
        return;
      }
      case 'cmd:project.create': {
        if (!this.projects) { this.sendReply(ws, this.err(f.id, 'NOT_CONFIGURED', 'хранилище проектов не сконфигурировано')); return; }
        const name = f.name.trim();
        if (name === '' || this.projects.byName(name)) {
          this.sendReply(ws, this.err(f.id, 'PROJECT_EXISTS', name === '' ? 'у проекта нужно имя' : `проект «${name}» уже есть`));
          return;
        }
        if (f.profile !== undefined && !this.profiles.get(f.profile)) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет`));
          return;
        }
        const path = projectPath(this.projects.root(), f.slug, f.path);
        if (path === null || !isAbsolute(path)) {
          this.sendReply(ws, this.err(f.id, 'PROJECT_PATH', path === null ? 'нужна папка: имя (slug) или свой путь' : `путь должен быть абсолютным: ${path}`));
          return;
        }
        if (f.source === 'git' && (f.gitUrl === undefined || !validGitUrl(f.gitUrl))) {
          this.sendReply(ws, this.err(f.id, 'GIT_URL', f.gitUrl === undefined ? 'нужен адрес репозитория' : `не похоже на адрес репозитория: ${maskUrl(f.gitUrl)}`));
          return;
        }
        const info = await inspectDir(path, this.git, GIT_INFO_TIMEOUT_MS);
        const pl = planFor(f.source, info, f.gitUrl);
        let action: 'created' | 'cloned' | 'connected';
        if (pl.plan === 'conflict' || pl.plan === 'missing') {
          this.sendReply(ws, this.err(f.id, 'PROJECT_PATH', `${path}: ${pl.reason ?? 'папку не подключить'}`));
          return;
        }
        if (pl.plan === 'create') {
          const e = ensureProjectDir(path);
          if (e) { this.sendReply(ws, this.err(f.id, 'PROJECT_PATH', e)); return; }
          action = 'created';
        } else if (pl.plan === 'clone') {
          console.log(`[project] клон ${maskUrl(f.gitUrl!)} → ${path}`);
          const r = await this.git(['clone', '--', f.gitUrl!.trim(), path], { timeoutMs: GIT_CLONE_TIMEOUT_MS });
          if (r.code !== 0) {
            const why = r.timedOut ? 'клон не уложился в 10 минут' : gitTail(r) || 'git clone завершился с ошибкой';
            console.log(`[project] клон не удался: ${why}`);
            this.sendReply(ws, this.err(f.id, 'GIT_FAILED', `не удалось склонировать ${maskUrl(f.gitUrl!)}: ${why}`));
            return;
          }
          action = 'cloned';
        } else {
          action = 'connected';
        }
        // имя могли занять, пока шёл клон (второй клиент) — проверяем ещё раз перед записью
        if (this.projects.byName(name)) {
          this.sendReply(ws, this.err(f.id, 'PROJECT_EXISTS', `проект «${name}» уже есть`));
          return;
        }
        const project = this.projects.create({
          name, path,
          ...(f.profile !== undefined ? { profile: f.profile } : {}),
          ...(f.model !== undefined ? { model: f.model } : {}),
          ...(f.permissionMode !== undefined ? { permissionMode: f.permissionMode } : {}),
        });
        this.sendReply(ws, this.ack(f.id, { project, action, path }));
        return;
      }
      case 'cmd:project.scan': {
        if (!this.projects) { this.sendReply(ws, this.err(f.id, 'NOT_CONFIGURED', 'хранилище проектов не сконфигурировано')); return; }
        const root = this.projects.root();
        const list = this.projects.list();
        const projects = await Promise.all(list.map(async (p) => {
          const exists = isDir(p.path);
          const git = exists && existsSync(join(p.path, '.git')) ? await gitInfo(p.path, this.git, GIT_INFO_TIMEOUT_MS) : undefined;
          return {
            id: p.id, name: p.name, path: p.path, exists, inStorage: insideRoot(root, p.path),
            ...(git ? { git: { ...git, origin: git.origin === null ? null : maskUrl(git.origin) } } : {}),
          };
        }));
        const same = (a: string, b: string) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
        let orphans: string[] = [];
        try {
          orphans = readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
            .map((d) => d.name)
            .filter((n) => !list.some((p) => same(p.path, join(root, n))))
            .sort((a, b) => a.localeCompare(b));
        } catch { /* корня нет — пусто */ }
        this.sendReply(ws, this.ack(f.id, { storage: this.storageInfo(), projects, orphans }));
        return;
      }
      case 'cmd:project.mkdir': {
        const p = this.projects?.get(f.projectId);
        if (!p) { this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROJECT', `проекта ${f.projectId} нет`)); return; }
        const e = ensureProjectDir(p.path);
        if (e) { this.sendReply(ws, this.err(f.id, 'PROJECT_PATH', e)); return; }
        this.sendReply(ws, this.ack(f.id, { project: p }));
        return;
      }
      case 'cmd:project.rename': {
        const ok = this.projects?.rename(f.projectId, f.name) ?? false;
        this.sendReply(ws, ok ? this.ack(f.id) : this.err(f.id, 'UNKNOWN_PROJECT', `проекта ${f.projectId} нет`));
        return;
      }
      case 'cmd:project.delete': {
        const ok = this.projects?.remove(f.projectId) ?? false;
        this.sendReply(ws, ok ? this.ack(f.id) : this.err(f.id, 'UNKNOWN_PROJECT', `проекта ${f.projectId} нет`));
        return;
      }
      case 'cmd:message.send': {
        try {
          this.requireSession(f.sessionId ?? '');
          const imgBytes = (f.images ?? []).reduce((n, b64) => n + Math.round(b64.length * 0.75), 0);
          console.log(`[msg] session=${(f.sessionId ?? '').slice(0, 8)} text=${f.text.length} симв images=${f.images?.length ?? 0} (${imgBytes} байт)`);
          this.manager.send(f.sessionId ?? '', f.text, f.images);
          this.sendReply(ws, this.ack(f.id));
        } catch (err) {
          this.sendReply(ws, this.err(f.id, 'SESSION_NOT_FOUND', String(err)));
        }
        return;
      }
      case 'cmd:permission.respond': {
        // sessionId в шапке кадра
        const sid = f.sessionId ?? '';
        if (!this.manager.get(sid)) {
          this.sendReply(ws, this.err(f.id, 'SESSION_NOT_FOUND', `нет сессии ${sid}`));
          return;
        }
        const ok = this.manager.respondPermission(sid, f.requestId, f.behavior, f.updatedInput, f.updatedPermissions);
        this.sendReply(ws, ok ? this.ack(f.id) : this.err(f.id, 'PERMISSION_NOT_FOUND', 'запрос уже отвечен или чужой'));
        return;
      }
      case 'cmd:session.rename': {
        const ok = this.manager.rename(f.sessionId ?? '', f.name);
        this.sendReply(ws, ok ? this.ack(f.id, { session: this.publicSession(this.manager.get(f.sessionId ?? '')) }) : this.err(f.id, 'SESSION_NOT_FOUND', 'нет сессии'));
        return;
      }
      case 'cmd:session.archive': {
        const ok = this.manager.setArchived(f.sessionId ?? '', f.archived);
        this.sendReply(ws, ok ? this.ack(f.id, { session: this.publicSession(this.manager.get(f.sessionId ?? '')) }) : this.err(f.id, 'SESSION_NOT_FOUND', 'нет сессии'));
        return;
      }
      case 'cmd:session.delete': {
        const sid = f.sessionId ?? '';
        const info = this.manager.get(sid);
        if (!info) { this.sendReply(ws, this.err(f.id, 'SESSION_NOT_FOUND', `нет сессии ${sid}`)); return; }
        const r = this.manager.deleteSession(sid);
        if (r !== 'ok') {
          this.sendReply(ws, this.err(f.id, r === 'busy' ? 'SESSION_BUSY' : 'SESSION_NOT_FOUND', r === 'busy' ? 'сессия работает — дождитесь конца хода' : `нет сессии ${sid}`));
          return;
        }
        // история сессии — транскрипт профиля; удаление сессии = удаление истории
        if (info.claudeSessionId !== undefined && info.cwd !== undefined && info.state !== 'creating') {
          const tp = transcriptPath(this.configDirFor(info.profile), info.cwd, info.claudeSessionId);
          try { rmSync(tp); } catch { /* файла могло уже не быть */ }
        }
        // терминалы и подписки сессии гасим, как у session.stop
        this.panels.terminals.closeSession(sid);
        this.sendReply(ws, this.ack(f.id));
        return;
      }
      case 'cmd:interrupt': {
        void this.manager.interrupt(f.sessionId ?? '').then(
          () => this.sendReply(ws, this.ack(f.id)),
          (err) => this.sendReply(ws, this.err(f.id, 'INTERRUPT_FAILED', String(err))),
        );
        return;
      }
      case 'cmd:session.fork': {
        const newId = this.manager.fork(f.sessionId ?? '');
        if (!newId) {
          this.sendReply(ws, this.err(f.id, 'FORK_IMPOSSIBLE', 'сессия не найдена, ещё без claudeSessionId или форк не сконфигурирован'));
        } else {
          this.sendReply(ws, this.ack(f.id, { sessionId: newId }));
        }
        return;
      }
      case 'cmd:transcript.get': {
        const sid = f.sessionId ?? '';
        const info = this.manager.get(sid);
        if (!info) {
          this.sendReply(ws, this.err(f.id, 'SESSION_NOT_FOUND', `нет сессии ${sid}`));
          return;
        }
        const empty = () => this.ack(f.id, { sessionId: sid, items: [], lastSeq: this.manager.seqLast(sid) });
        // до первого system/init у сессии нет транскрипта — это пустая лента, а не ошибка
        if (!info.claudeSessionId) {
          this.sendReply(ws, empty());
          return;
        }
        if (!info.cwd) {
          this.sendReply(ws, this.err(f.id, 'NO_CWD', 'ресинк требует, чтобы сессия знала свой cwd'));
          return;
        }
        // транскрипт лежит в CLAUDE_CONFIG_DIR профиля сессии под настоящим id сессии claude
        const path = transcriptPath(this.configDirFor(info.profile), info.cwd, info.claudeSessionId);
        const r = readTranscriptItems(path, undefined, this.thinking ? { thinkingText: (sig) => this.thinking!.get(sig) } : {});
        // файла ещё нет (CLI пишет его с первой реплики) — тоже пустая лента
        this.sendReply(ws, r
          ? this.ack(f.id, { sessionId: sid, items: r.items, lastSeq: this.manager.seqLast(sid) })
          : empty());
        return;
      }
      case 'cmd:session.wake': {
        // окно открыло сессию / начали печатать: остывшую поднимаем заранее, живой продлеваем простой
        const sid = f.sessionId ?? '';
        if (!this.manager.get(sid)) { this.sendReply(ws, this.err(f.id, 'SESSION_NOT_FOUND', `нет сессии ${sid}`)); return; }
        this.sendReply(ws, this.ack(f.id, { result: this.manager.wake(sid) }));
        return;
      }
      case 'cmd:session.stop': {
        void this.manager.stop(f.sessionId ?? '').then(
          () => {
            // остановленная сессия забирает с собой свои терминалы
            this.panels.terminals.closeSession(f.sessionId ?? '');
            this.sendReply(ws, this.ack(f.id));
          },
          (err) => this.sendReply(ws, this.err(f.id, 'STOP_FAILED', String(err))),
        );
        return;
      }
      // ─── перенос сессии между средами (T-ряд) ───
      case 'cmd:session.export': {
        const sid = f.sessionId ?? '';
        const info = this.manager.get(sid);
        if (!info) { this.sendReply(ws, this.err(f.id, 'SESSION_NOT_FOUND', `нет сессии ${sid}`)); return; }
        if (!info.claudeSessionId || !info.cwd) {
          this.sendReply(ws, this.err(f.id, 'EMPTY_SESSION', 'у сессии ещё нет истории — переносить нечего'));
          return;
        }
        // работающую не переносим: аппрувы и середина хода не переедут
        if (info.state !== 'idle' && info.state !== 'dead') {
          this.sendReply(ws, this.err(f.id, 'SESSION_BUSY', 'сессия работает — дождитесь конца хода'));
          return;
        }
        const path = transcriptPath(this.configDirFor(this.manager.get(sid)?.profile), info.cwd, info.claudeSessionId);
        let transcript: string;
        try {
          transcript = readFileSync(path, 'utf8');
        } catch {
          this.sendReply(ws, this.err(f.id, 'NO_TRANSCRIPT', `транскрипт не читается: ${path}`));
          return;
        }
        // незакоммиченные правки: патч tracked-изменений + список новых файлов без git (их патч не несёт)
        const [head, patch, untracked] = await Promise.all([
          this.git(['-C', info.cwd, 'rev-parse', 'HEAD'], { timeoutMs: GIT_INFO_TIMEOUT_MS }),
          this.git(['-C', info.cwd, 'diff', 'HEAD', '--binary'], { timeoutMs: GIT_INFO_TIMEOUT_MS }),
          this.git(['-C', info.cwd, 'ls-files', '--others', '--exclude-standard'], { timeoutMs: GIT_INFO_TIMEOUT_MS }),
        ]);
        const moved = this.manager.markMoved(sid, f.to);
        if (moved !== 'ok') {
          this.sendReply(ws, this.err(f.id, moved === 'busy' ? 'SESSION_BUSY' : 'SESSION_NOT_FOUND', moved === 'busy' ? 'сессия работает — дождитесь конца хода' : `нет сессии ${sid}`));
          return;
        }
        const public_ = this.publicSession(this.manager.get(sid));
        this.sendReply(ws, this.ack(f.id, {
          sessionId: sid,
          transcript,
          headCommit: head.code === 0 ? head.stdout.trim() : null,
          patch: patch.code === 0 && patch.stdout.trim() !== '' ? patch.stdout : null,
          untracked: untracked.code === 0 ? untracked.stdout.split(/\r?\n/).filter((l) => l.trim() !== '') : [],
          meta: public_,
        }));
        return;
      }
      case 'cmd:session.import': {
        if (!this.projects) { this.sendReply(ws, this.err(f.id, 'NOT_CONFIGURED', 'хранилище проектов не сконфигурировано')); return; }
        // проект — по имени (правило синка); клиента просим создать заранее, молчаливое создание с чужой папкой не заводим
        const project = f.project !== undefined ? this.projects.byName(f.project) : undefined;
        if (f.project !== undefined && !project) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROJECT', `проекта «${f.project}» нет на этой машине — создайте его, потом переносите`));
          return;
        }
        // профиль цели: имя источника может здесь не существовать — клиент должен предложить выбор заранее
        if (f.profile !== undefined && !this.profiles.get(f.profile)) {
          this.sendReply(ws, this.err(f.id, 'UNKNOWN_PROFILE', `профиля «${f.profile}» нет в profiles.json`));
          return;
        }
        const profile = this.profiles.internal(f.profile ?? project?.profile);
        const cwd = project?.path ?? process.cwd();
        const model = f.model ?? project?.model;
        // усилие/ultracode должны поддерживаться аккаунтом-целью, как у session.new
        if (f.ultracode === true && !this.profiles.ultracodeAllowed(profile)) {
          this.sendReply(ws, this.err(f.id, 'ULTRACODE_DISABLED', `у аккаунта «${this.profiles.external(profile) ?? '—'}» ultracode выключен`));
          return;
        }
        const efforts = this.profiles.effortsFor(profile, model);
        if (f.effort !== undefined && efforts !== null && !efforts.includes(f.effort)) {
          this.sendReply(ws, this.err(f.id, 'EFFORT_UNSUPPORTED', effortText(model, efforts)));
          return;
        }
        // патч правок: только на ту же базу, что была у источника (расхождение веток ловим до применения)
        if (f.patch !== undefined) {
          const head = await this.git(['-C', cwd, 'rev-parse', 'HEAD'], { timeoutMs: GIT_INFO_TIMEOUT_MS });
          const headHere = head.code === 0 ? head.stdout.trim() : null;
          if (headHere === null || f.baseCommit === undefined || headHere !== f.baseCommit) {
            this.sendReply(ws, this.err(f.id, 'PATCH_BASE_MISMATCH', `ветки разошлись: источник на ${f.baseCommit?.slice(0, 7) ?? '—'}, здесь ${headHere?.slice(0, 7) ?? 'не git'} — правки не переношу`));
            return;
          }
          const check = await this.git(['-C', cwd, 'apply', '--check', '-'], { timeoutMs: GIT_INFO_TIMEOUT_MS, input: f.patch });
          if (check.code !== 0) {
            this.sendReply(ws, this.err(f.id, 'PATCH_FAILED', `патч не ложится: ${gitTail(check) || 'git apply --check завершился с ошибкой'}`));
            return;
          }
          const apply = await this.git(['-C', cwd, 'apply', '-'], { timeoutMs: GIT_INFO_TIMEOUT_MS, input: f.patch });
          if (apply.code !== 0) {
            this.sendReply(ws, this.err(f.id, 'PATCH_FAILED', `патч не применился: ${gitTail(apply) || 'git apply завершился с ошибкой'}`));
            return;
          }
        }
        // транскрипт — в папку слага здешнего cwd, с переписанным cwd внутри записей
        writeTranscript(this.configDirFor(profile), cwd, f.claudeSessionId, retargetTranscript(f.transcript, cwd));
        const sid = randomUUID();
        const info = this.manager.importSession(
          {
            id: sid,
            name: f.name,
            claudeSessionId: f.claudeSessionId,
            cwd,
            ...(model !== undefined ? { model } : {}),
            ...(f.permissionMode !== undefined ? { permissionMode: f.permissionMode } : {}),
            ...(profile !== undefined ? { profile } : {}),
            ...(project !== undefined ? { projectId: project.id } : {}),
            ...(f.effort !== undefined ? { effort: f.effort } : {}),
            ...(f.ultracode === true ? { ultracode: true } : {}),
            movedFrom: f.movedFrom,
            lastSeq: -1,
          },
          this.resumeFactory,
          this.forkFactory,
        );
        if (!info) {
          this.sendReply(ws, this.err(f.id, 'IMPORT_FAILED', 'не удалось зарегистрировать сессию'));
          return;
        }
        this.sendReply(ws, this.ack(f.id, { sessionId: sid, session: this.publicSession(info) }));
        return;
      }
      // ─── панели: файлы, git, порты, терминал ───
      case 'cmd:fs.list':
      case 'cmd:fs.read':
      case 'cmd:git.status':
      case 'cmd:net.ports':
      case 'cmd:term.open':
      case 'cmd:term.attach':
      case 'cmd:term.list':
      case 'cmd:term.input':
      case 'cmd:term.resize':
      case 'cmd:term.close':
        await this.handlePanel(ws, f);
        return;
      // ─── удалённый браузер (ретрансляция) ───
      case 'cmd:rb.open':
      case 'cmd:rb.list':
      case 'cmd:rb.attach':
      case 'cmd:rb.ack':
      case 'cmd:rb.navigate':
      case 'cmd:rb.input':
      case 'cmd:rb.resize':
      case 'cmd:rb.close':
        await this.handleRb(ws, f);
        return;
      case 'cmd:session.open':
      default: {
        // session.open в P0 не нужен (все события идут всем) — подтверждаем
        this.sendReply(ws, this.ack(f.id));
        return;
      }
    }
  }

  private handleHello(ws: WebSocket, f: Extract<Cmd, { type: 'cmd:hello' }>): void {
    const hello: Event = EventSchema.parse({
      v: PROTOCOL_VERSION, ts: Date.now(), seq: 0,
      type: 'event:hello',
      server: { version: SUPERVISOR_VERSION, uptimeMs: Date.now() - this.startedAt },
      sessions: this.manager.list().map((s) => {
        const profile = this.profiles.external(s.profile);
        return {
          id: s.id, name: s.name, state: s.state,
          ...(s.needs !== null && s.needs !== undefined ? { needs: s.needs } : {}),
          ...(s.model !== undefined ? { model: s.model } : {}),
          ...(s.permissionMode !== undefined ? { permissionMode: s.permissionMode } : {}),
          ...(profile !== undefined ? { profile } : {}),
          ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
          ...(s.archived !== undefined ? { archived: s.archived } : {}),
          ...(s.effort !== undefined ? { effort: s.effort } : {}),
          ...(s.ultracode === true ? { ultracode: true } : {}),
          ...(s.parentSessionId !== undefined ? { parentSessionId: s.parentSessionId } : {}),
          ...(s.agentOf !== undefined ? { agentOf: s.agentOf } : {}),
          ...(s.movedTo !== undefined ? { movedTo: s.movedTo } : {}),
          ...(s.movedFrom !== undefined ? { movedFrom: s.movedFrom } : {}),
        };
      }),
      profiles: this.profiles.infos(),
      ...((this.projects?.list().length ?? 0) > 0 ? { projects: this.projects!.list() } : {}),
      ...(this.pool ? { pool: { warm: this.pool.warm, target: this.pool.target } } : {}),
      ...(this.projects ? { storage: this.storageInfo() } : {}),
    });
    ws.send(JSON.stringify(hello));
    // догон по каждой известной клиенту сессии
    const known = f.lastSeq ?? {};
    for (const [sid, lastSeq] of Object.entries(known)) {
      const currentLast = this.manager.seqLast(sid);
      if (currentLast === null) continue; // такой сессии у сервера нет — догонять нечего (и sessionId может быть не uuid)
      const ring = this.rings.get(sid);
      let missed: Event[] | null;
      if (lastSeq > currentLast) {
        // клиент «впереди» сервера: после kill -9 персист seq отстал — номера будут переиспользованы
        missed = null;
      } else if (ring && ring.oldestSeq !== null) {
        missed = ring.since(lastSeq);
      } else {
        // буфер пуст (рестарт supervisor'а): если seq ушёл дальше — нужен ресинк из транскрипта
        missed = currentLast > lastSeq ? null : [];
      }
      if (missed === null) {
        ws.send(JSON.stringify({
          v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, seq: 0,
          type: 'event:error', code: 'RESYNC_NEEDED',
          message: `события ${lastSeq + 1}..${currentLast} недоступны из ринг-буфера — нужен ресинк из транскрипта`,
        } satisfies Event));
        // транскрипт не содержит висящих карточек — их досылаем отдельно;
        // если клиент «впереди», номера переиспользованы — шлём все
        this.sendPendingPermissions(ws, sid, lastSeq > currentLast ? -1 : lastSeq);
        continue;
      }
      for (const e of missed) ws.send(JSON.stringify(e));
    }
    // висящие карточки разрешений по сессиям, которых клиент не знает (свежий клиент / перезагрузка окна):
    // без них сессия в waiting_permission висит вечно — ответить нечем
    for (const s of this.manager.list()) {
      if (known[s.id] === undefined) this.sendPendingPermissions(ws, s.id, -1);
    }
    // с этого момента клиент получает живой поток (handleHello синхронный — ничего не вклинится)
    this.ready.add(ws);
    this.sendReply(ws, this.ack(f.id));
  }

  /** Команда панели: PanelError → err с её кодом; прочие исключения уходят в INTERNAL (handleFrame). */
  private async handlePanel(ws: WebSocket, f: PanelCmd): Promise<void> {
    const sink = this.termSink(ws);
    try {
      const data = await this.panels.handle(f, sink);
      this.sendReply(ws, this.ack(f.id, data));
    } catch (err) {
      if (err instanceof PanelError) {
        this.sendReply(ws, this.err(f.id, err.code, err.message));
        return;
      }
      throw err;
    } finally {
      // сокет закрылся, пока терминал открывался, — отписка по close уже прошла мимо него
      if (ws.readyState !== ws.OPEN && !this.termSinks.has(ws)) this.panels.terminals.unsubscribe(sink);
    }
  }

  /** Команда удалённого браузера: PanelError → err с её кодом. */
  private async handleRb(ws: WebSocket, f: Extract<Cmd, { type: `cmd:rb.${string}` }>): Promise<void> {
    const sink = this.rbSink(ws);
    try {
      let data: unknown;
      switch (f.type) {
        case 'cmd:rb.open':
          data = await this.rbrowser.open({
            width: f.width, height: f.height, subscriber: sink,
            ...(f.ackFrames ? { ackFrames: true } : {}),
            ...(f.url !== undefined ? { url: f.url } : {}),
            ...(f.quality !== undefined ? { quality: f.quality } : {}),
          });
          break;
        case 'cmd:rb.list': data = { browsers: this.rbrowser.list() }; break;
        case 'cmd:rb.attach': data = this.rbrowser.attach(f.rbId, sink, f.ackFrames === true); break;
        case 'cmd:rb.ack': this.rbrowser.frameAck(f.rbId, sink); return; // ответ не нужен — без лишнего трафика вниз
        case 'cmd:rb.navigate':
          await this.rbrowser.navigate(f.rbId, { ...(f.url !== undefined ? { url: f.url } : {}), ...(f.action !== undefined ? { action: f.action } : {}) });
          break;
        case 'cmd:rb.input': await this.rbrowser.input(f.rbId, f.input); break;
        case 'cmd:rb.resize': await this.rbrowser.resize(f.rbId, f.width, f.height); break;
        case 'cmd:rb.close': await this.rbrowser.close(f.rbId); break;
      }
      this.sendReply(ws, this.ack(f.id, data));
    } catch (err) {
      if (err instanceof PanelError) {
        this.sendReply(ws, this.err(f.id, err.code, err.message));
        return;
      }
      throw err;
    } finally {
      if (ws.readyState !== ws.OPEN && !this.rbSinks.has(ws)) this.rbrowser.unsubscribe(sink);
    }
  }

  /** Адресат кадров удалённого браузера для сокета: кадры без сжатия, при забитом канале кадр пропускается. */
  private rbSink(ws: WebSocket): RbSubscriber {
    let sink = this.rbSinks.get(ws);
    if (!sink) {
      sink = {
        send: (raw, kind, reliable) => {
          if (ws.readyState !== ws.OPEN) return;
          if (kind === 'frame') {
            if (!reliable && ws.bufferedAmount > RB_BACKPRESSURE_BYTES) return;
            ws.send(raw, { compress: false }); // JPEG в base64 почти не жмётся — не тратим CPU
            return;
          }
          ws.send(raw);
        },
      };
      if (ws.readyState === ws.OPEN) this.rbSinks.set(ws, sink);
    }
    return sink;
  }

  /** Адресат потока терминалов для сокета: только ему, мимо ринг-буфера и broadcast. */
  private termSink(ws: WebSocket): TermSubscriber {
    let sink = this.termSinks.get(ws);
    if (!sink) {
      sink = {
        send: (raw, kind) => {
          if (ws.readyState !== ws.OPEN) return;
          // медленный клиент: вывод не копим бесконечно (выход процесса — всегда доставляем)
          if (kind === 'output' && ws.bufferedAmount > TERM_BACKPRESSURE_BYTES) return;
          ws.send(raw);
        },
      };
      if (ws.readyState === ws.OPEN) this.termSinks.set(ws, sink);
    }
    return sink;
  }

  /** Досылка неотвеченных карточек (исходные кадры с исходным seq), которых клиент ещё не видел. */
  private sendPendingPermissions(ws: WebSocket, sid: string, seenSeq: number): void {
    for (const e of this.manager.pendingPermissionFrames(sid)) {
      if (e.seq > seenSeq) ws.send(JSON.stringify(e));
    }
  }

  // ─── модели и профили ─────────────────────────────────────────────────────

  /**
   * Обновить в фоне устаревшие списки моделей auto-аккаунтов (по одному: каждый запрос поднимает процесс claude).
   * Вызывает сборка supervisor'а после старта; без modelsFetcher — ничего не делает.
   */
  async refreshStaleModels(maxAgeMs = MODELS_MAX_AGE_MS): Promise<void> {
    if (!this.modelsFetcher) return;
    for (const name of this.profiles.staleAuto(maxAgeMs)) {
      await this.refreshModels(name).catch((err: unknown) => {
        console.log(`[models] ${name}: список моделей не получен — ${String((err as Error)?.message ?? err)}`);
      });
    }
  }

  /**
   * Проверить вход аккаунтов-подписок (`claude auth status`) — для «не вошёл · Войти» в UI.
   * Вызывает сборка supervisor'а после старта; по одному процессу, ~1 с на аккаунт.
   */
  async refreshAuth(only?: string[]): Promise<void> {
    let changed = false;
    for (const name of only ?? this.profiles.subscriptionNames()) {
      const p = this.profiles.get(name);
      if (!p) continue;
      try {
        const token: Record<string, string> = usesSubToken(p) ? { CLAUDE_CODE_OAUTH_TOKEN: p.env!['CLAUDE_CODE_OAUTH_TOKEN']! } : {};
        const st = await this.logins.status(explicitConfigDir(p), token);
        this.profiles.setAuth(name, st);
        changed = true;
      } catch (err) {
        console.log(`[auth] ${name}: вход не проверен — ${String((err as Error)?.message ?? err)}`);
      }
    }
    if (changed) this.broadcastProfiles();
  }

  /** Список моделей аккаунта у Claude Code → кэш → всем клиентам event:profiles. Повторный вызов ждёт идущий. */
  private refreshModels(name: string): Promise<void> {
    const running = this.modelsInflight.get(name);
    if (running) return running;
    const fetcher = this.modelsFetcher;
    if (!fetcher) return Promise.reject(new Error('получение списка моделей на этом supervisor не настроено'));
    const job = (async () => {
      const got = await fetcher(name);
      const { models: raw, from } = Array.isArray(got) ? { models: got, from: 'claude-code' as const } : got;
      // список Claude Code у шлюза — только модели, которые он подменяет на модели шлюза (иначе z.ai 1211 Unknown Model);
      // у провайдера id настоящие — как есть
      const p = this.profiles.get(name);
      const models = p && from === 'claude-code' ? gatewayModels(p, raw) : raw;
      this.profiles.setAutoModels(name, models, Date.now(), from);
      this.broadcastProfiles();
    })().finally(() => this.modelsInflight.delete(name));
    this.modelsInflight.set(name, job);
    return job;
  }

  /** Профили изменились — всем подключённым клиентам (seq 0, мимо ринга). */
  /**
   * Цели MCP: видимые аккаунты (кроме не вошедших подписок; all — и их), сгруппированные по файлу настроек
   * Claude Code.
   */
  private mcpTargets(all = false): McpTarget[] {
    const byFile = new Map<string, McpTarget>();
    for (const p of this.profiles.publicList()) {
      if (!all && this.profiles.info(p.name)?.auth?.loggedIn === false && !usesKey(p)) continue;
      const dir = explicitConfigDir(p);
      const file = globalConfigFile(dir);
      const t = byFile.get(file);
      if (t) { t.profiles.push(p); continue; }
      byFile.set(file, { id: p.name, profiles: [p], dir, env: usesSubToken(p) ? { CLAUDE_CODE_OAUTH_TOKEN: p.env!['CLAUDE_CODE_OAUTH_TOKEN']! } : {} });
    }
    return [...byFile.values()];
  }

  /** Ключи аккаунтов цели — для {{account-key}}. */
  private keysOf(t: McpTarget) {
    return t.profiles.map((p) => accountKeyOf(accountEnv(p), usesSubToken(p)));
  }

  /** Ключ аккаунта для MCP (токен шлюза или ключ API; у подписки — нет). */
  private accountKey(name: string): string | undefined {
    const p = this.profiles.get(name);
    return p ? accountKeyOf(accountEnv(p), usesSubToken(p)).key : undefined;
  }

  /**
   * Аккаунт сменил ключ API: старый ключ в MCP-серверах (набор z.ai у других аккаунтов — с ключом, с которым его
   * поставили) заменить новым — в запасной копии сразу, у аккаунтов (`claude mcp remove` + `add-json`) — фоном, по
   * очереди. Аккаунт, у которого старый ключ — его собственный (тот же ключ у двух аккаунтов), не трогаем.
   * Секреты не логируются: только имена серверов и аккаунтов.
   */
  private rekeyMcp(name: string, oldKey: string, newKey: string): Promise<void> {
    const stored = this.mcpStore.rekey(oldKey, newKey);
    if (stored.length) console.log(`[mcp] ${name}: новый ключ — в копиях общего списка (${stored.join(', ')})`);
    const job = async () => {
      const done: string[] = [];
      for (const t of this.mcpTargets(true)) {
        const mine = t.profiles.some((p) => p.name === name);
        if (!mine && this.keysOf(t).some((a) => a.key === oldKey)) continue;
        for (const [n, raw] of Object.entries(readUserMcp(t.dir))) {
          const cfg = toMcpConfig(raw);
          const next = cfg ? rekeyConfig(cfg, oldKey, newKey) : null;
          if (!cfg || !next) continue;
          try {
            // add-json поверх существующего Claude Code не пишет — сначала убрать; не добавился — вернуть как было
            await mcpRemove(this.mcpDeps, t.dir, n, t.env);
            try {
              await mcpAdd(this.mcpDeps, t.dir, n, next, t.env);
            } catch (err) {
              await mcpAdd(this.mcpDeps, t.dir, n, cfg, t.env).catch(() => undefined);
              throw err;
            }
            done.push(`${t.id}/${n}`);
          } catch (err) {
            const why = String((err as Error)?.message ?? err).split(newKey).join('***').split(oldKey).join('***');
            console.log(`[mcp] ${name}: новый ключ у ${t.id}/${n} не записан — ${why}`);
          }
        }
      }
      if (done.length) console.log(`[mcp] ${name}: новый ключ — в MCP аккаунтов (${done.join(', ')})`);
    };
    this.mcpRekeyQueue = this.mcpRekeyQueue.then(job).catch((err) => {
      console.log(`[mcp] ${name}: новый ключ в MCP не разнесён — ${String((err as Error)?.message ?? err)}`);
    });
    return this.mcpRekeyQueue;
  }

  /** Копия сервера в общем списке; нет — снять с первого аккаунта, у кого он есть (ключ аккаунта — в метку). */
  private ensureStored(name: string, targets: McpTarget[]): StoredMcp {
    const have = this.mcpStore.get(name);
    if (have) return have;
    for (const t of targets) {
      const raw = readUserMcp(t.dir)[name];
      if (!raw) continue;
      const config = toMcpConfig(raw);
      if (!config) throw new Error(`«${name}» — такой тип сервера между аккаунтами не переносится`);
      const keys = this.keysOf(t);
      const template = templateOf(config, keys.map((a) => a.key));
      // чей ключ попал в метку — его шлюз: команде потом подставим ключ только аккаунта того же шлюза
      const owner = template ? keys.find((a) => templateOf(config, [a.key]) !== undefined) : undefined;
      const keyHost = owner ? gatewayHostOf(owner) : undefined;
      const e: StoredMcp = { config, ...(template ? { template } : {}), ...(keyHost ? { keyHost } : {}) };
      this.mcpStore.put(name, e);
      return e;
    }
    throw new Error(`сервера «${name}» нет ни у одного аккаунта`);
  }

  /**
   * Добавить сервер в общий список и всем целям. Метка ключа: копия хранит шаблон, а «как есть» — с ключом первого
   * подходящего аккаунта (ни у кого не подходит — ошибка, как у одиночного добавления). keyHost — шлюз, чей ключ
   * означает метка; у команды не задан — шлюз первого аккаунта-шлюза с ключом (его же предлагает окно добавления).
   */
  private async sharedAdd(name: string, config: McpConfig, targets: McpTarget[], keyHost?: string): Promise<Array<{ profile: string; ok: boolean; error?: string }>> {
    const marked = JSON.stringify(config).includes(ACCOUNT_KEY_MARK);
    let literal: McpConfig | undefined = marked ? undefined : config;
    let why: unknown;
    const accounts = targets.flatMap((t) => this.keysOf(t));
    let host = keyHost;
    if (marked && config.type === 'stdio' && !host) {
      host = accounts.filter((a) => a.key).map(gatewayHostOf).find((h) => h !== undefined);
      if (!host) throw new Error('ключ аккаунта в команду ставится только от аккаунта-шлюза (z.ai и т. п.), а такого с ключом нет');
    }
    if (marked) {
      for (const a of accounts) {
        try {
          literal = withAccountKey(config, a, host);
          host ??= gatewayHostOf(a);
          break;
        } catch (err) { why = err; }
      }
    }
    if (!literal) throw why instanceof Error ? why : new Error('ни у одного аккаунта нет ключа для этого сервера');
    const e: StoredMcp = { config: literal, ...(marked ? { template: config } : {}), ...(marked && host ? { keyHost: host } : {}) };
    this.mcpStore.put(name, e);
    const results: Array<{ profile: string; ok: boolean; error?: string }> = [];
    for (const t of targets) {
      if (readUserMcp(t.dir)[name]) { results.push({ profile: t.id, ok: false, error: 'у аккаунта уже есть сервер с таким именем' }); continue; }
      try {
        await mcpAdd(this.mcpDeps, t.dir, name, configFor(e, this.keysOf(t)), t.env);
        results.push({ profile: t.id, ok: true });
      } catch (err) {
        results.push({ profile: t.id, ok: false, error: String((err as Error)?.message ?? err) });
      }
    }
    console.log(`[mcp] общий ${name} (${config.type}): добавлен у ${results.filter((r) => r.ok).map((r) => r.profile).join(', ') || 'никого'}`);
    return results;
  }

  /** Набор z.ai всем аккаунтам — те серверы, которых ещё нет ни в общем списке, ни у кого из аккаунтов. */
  private async installZaiPreset(): Promise<{ added: string[]; results: Record<string, Array<{ profile: string; ok: boolean; error?: string }>> }> {
    const targets = this.mcpTargets();
    const present = new Set([...Object.keys(this.mcpStore.all()), ...targets.flatMap((t) => Object.keys(readUserMcp(t.dir)))]);
    const added: string[] = [];
    const results: Record<string, Array<{ profile: string; ok: boolean; error?: string }>> = {};
    for (const [name, cfg] of Object.entries(ZAI_MCP_PRESET)) {
      if (present.has(name)) continue;
      results[name] = await this.sharedAdd(name, cfg, targets, ZAI_KEY_HOST);
      if (results[name]!.some((r) => r.ok)) added.push(name);
    }
    return { added, results };
  }

  /** Новый аккаунт получает общие MCP — все, что включены хоть у одного другого аккаунта (фоном, по одному). */
  private async syncSharedMcp(name: string): Promise<void> {
    try {
      const targets = this.mcpTargets();
      const mine = targets.find((t) => t.profiles.some((p) => p.name === name));
      if (!mine) return;
      const have = readUserMcp(mine.dir);
      const names = new Set(targets.filter((t) => t !== mine).flatMap((t) => Object.keys(readUserMcp(t.dir))));
      let added = 0;
      for (const n of names) {
        if (have[n]) continue;
        try {
          await mcpAdd(this.mcpDeps, mine.dir, n, configFor(this.ensureStored(n, targets), this.keysOf(mine)), mine.env);
          added += 1;
        } catch (err) {
          console.log(`[mcp] ${name}: общий ${n} не добавлен — ${String((err as Error)?.message ?? err)}`);
        }
      }
      if (added > 0) console.log(`[mcp] ${name}: добавлено общих MCP-серверов ${added}`);
    } catch (err) {
      console.log(`[mcp] ${name}: общие MCP не розданы — ${String((err as Error)?.message ?? err)}`);
    }
  }

  /** Лимиты аккаунта — всем клиентам (seq 0, мимо ринга). */
  private broadcastUsage(profile: string | undefined, usage: UsageInfo): void {
    const name = this.profiles.external(profile) ?? BASE_PROFILE;
    const frame = EventSchema.parse({ v: PROTOCOL_VERSION, ts: Date.now(), seq: 0, type: 'event:usage', profile: name, usage });
    this.broadcast(frame);
  }

  private broadcastProfiles(): void {
    const frame = EventSchema.parse({ v: PROTOCOL_VERSION, ts: Date.now(), seq: 0, type: 'event:profiles', profiles: this.profiles.infos() });
    this.broadcast(frame);
  }

  /** Хранилище проектов для клиента (hello, storage.set, project.scan). */
  private storageInfo(): { root: string; exists: boolean; freeBytes?: number } {
    const root = this.projects!.root();
    const exists = isDir(root);
    const free = exists ? freeBytes(root) : undefined;
    return { root, exists, ...(free !== undefined ? { freeBytes: free } : {}) };
  }

  /** Сессия для клиента: профиль под внешним именем (без профиля = аккаунт supervisor'а `default`). */
  private publicSession(s: SessionInfo | undefined): SessionInfo | undefined {
    if (!s) return s;
    const { profile: internal, ...rest } = s;
    const profile = this.profiles.external(internal);
    return { ...rest, ...(profile !== undefined ? { profile } : {}) };
  }

  /** CLAUDE_CONFIG_DIR профиля (там транскрипты его сессий). */
  private configDirFor(profile: string | undefined): string {
    return profileConfigDir(this.profiles.get(profile));
  }

  private requireSession(sid: string): void {
    if (!this.manager.get(sid)) throw new Error(`нет сессии ${sid}`);
  }

  private ack(id: string, data?: unknown): Reply {
    return { v: PROTOCOL_VERSION, ts: Date.now(), id, ok: true, ...(data !== undefined ? { data } : {}) };
  }

  private err(id: string, code: string, message: string): Reply {
    return { v: PROTOCOL_VERSION, ts: Date.now(), id, ok: false, code, message };
  }

  private sendReply(ws: WebSocket, reply: Reply): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
  }
}

/** Текст ошибки «модель не знает такого усилия». */
function effortText(model: string | undefined, efforts: EffortLevel[]): string {
  const m = model ?? 'по умолчанию';
  return efforts.length === 0
    ? `у модели ${m} усилие не настраивается`
    : `у модели ${m} нет такого уровня усилия (есть: ${efforts.join(', ')})`;
}

/** Короткий случайный слаг для папки нового аккаунта. */
function randomSlug(): string {
  return Math.random().toString(36).slice(2, 8);
}
