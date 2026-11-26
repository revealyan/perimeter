// Пакет protocol — ЕДИНСТВЕННОЕ место схемы кадров UI↔supervisor (АДР 003).
// Источник типов — zod-схемы (z.infer), чтобы тип и валидация не расходились.
// Совместимость: неизвестный type не роняет парсер (инвариант 5, docs/p0-design.md §5).

import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

// ─── Общие части кадров ────────────────────────────────────────────────────

const frameBase = z.object({
  v: z.literal(PROTOCOL_VERSION),
  ts: z.number().int().nonnegative(),
  sessionId: z.string().uuid().optional(),
});

// Команда UI → supervisor: подтверждается ack/err по id
const cmdBase = frameBase.extend({ id: z.string().min(1) });

// Событие supervisor → UI: монотонный seq на сессию, без дыр
const eventBase = frameBase.extend({ seq: z.number().int().nonnegative() });

// ─── Домен: сессия ─────────────────────────────────────────────────────────

export const SessionStateSchema = z.enum([
  'creating',        // создаём запись, claude ещё не запущен
  'initializing',    // процесс запущен, ждём system/init
  'idle',            // ждём сообщение
  'working',         // ход выполняется
  'waiting_permission', // стоим на canUseTool (карточка в UI)
  'waiting_input',   // стоим на AskUserQuestion
  'interrupted',     // оборвали ход (interrupt)
  'error',           // упало и не восстановилось само
  'dead',            // процесс мёртв, но транскрипт есть → respawn через --resume
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

/** Глубина усилия модели (SDK EffortLevel): чем выше, тем дольше думает и дороже ход. */
export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

const sessionSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  state: SessionStateSchema,
  needs: z.string().nullable().optional(), // текст вопроса, на котором стоим
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  profile: z.string().optional(), // аккаунт, под которым живёт сессия
  projectId: z.string().optional(), // проект, если сессия в проекте
  archived: z.boolean().optional(), // сессия в архиве (внизу сайдбара)
  effort: EffortLevelSchema.optional(), // усилие сессии; нет — по умолчанию модели/аккаунта
  ultracode: z.boolean().optional(), // ultracode включён для сессии
  /** окно автокомпакта сессии (autoCompactWindow, токены); нет — модели/аккаунта */
  compactWindow: z.number().int().optional(),
  /** сессия-воркер: id родительской сессии (сквозной сабагент по аккаунтам); нет — обычная сессия */
  parentSessionId: z.string().uuid().optional(),
  /** чем порождена (имя инструмента делегирования); справочно для UI */
  agentOf: z.string().optional(),
  /** сессия переехала в другую среду (архивная пометка «переехала → …», метка среды-цели) */
  movedTo: z.string().optional(),
  /** сессия приехала из другой среды (метка среды-источника — плашка в ленте) */
  movedFrom: z.string().optional(),
});

/** Модель аккаунта — для выбора в поле ввода. */
export const modelInfoSchema = z.object({
  /** идентификатор для API / --model (sonnet, opus, glm-5.3[1m]) */
  id: z.string().min(1),
  /** подпись в UI (Sonnet 5.5); нет — показываем id */
  label: z.string().optional(),
  /** пояснение под названием, как в Claude Code Desktop («Best for everyday, complex tasks») */
  description: z.string().max(200).optional(),
  /** уровни усилия модели; нет или пусто — усилие у модели не настраивается */
  efforts: z.array(EffortLevelSchema).optional(),
  /** окно контекста по данным провайдера (max_input_tokens из /v1/models); нет — неизвестно */
  ctx: z.number().int().positive().optional(),
});
export type ModelInfoFrame = z.infer<typeof modelInfoSchema>;

/** Границы окна контекста, которое Claude Code принимает (autoCompactWindow). */
export const CTX_MIN = 100_000;
export const CTX_MAX = 1_000_000;

/**
 * Своя модель аккаунта: та же модель с другим окном контекста (Claude Code сжимает переписку, дойдя до него).
 * id самоописывающий — `<база>@<K>k` (glm-5.3@400k): запуск понимает его и без записи в профиле,
 * так что удалённая своя модель у живой сессии запуск не ломает.
 */
export const customModelSchema = z.object({
  id: z.string().min(1).max(220),
  base: z.string().min(1).max(200),
  ctx: z.number().int().min(CTX_MIN).max(CTX_MAX),
  /** подпись; нет — «<база> · <окно>» */
  label: z.string().max(80).optional(),
});
export type CustomModel = z.infer<typeof customModelSchema>;

export function customModelId(base: string, ctx: number): string {
  return `${base}@${Math.round(ctx / 1000)}k`;
}

/** `glm-5.3@400k` → { base: 'glm-5.3', ctx: 400000 }; не своя модель (или окно вне границ) — null. */
export function parseCustomModelId(id: string | undefined): { base: string; ctx: number } | null {
  const m = id ? /^(.+)@(\d{3,4})k$/i.exec(id) : null;
  if (!m) return null;
  const ctx = Number(m[2]) * 1000;
  return ctx >= CTX_MIN && ctx <= CTX_MAX ? { base: m[1]!, ctx } : null;
}

/** Профиль аккаунта (мультиакк): окружение для субпроцесса claude. */
export const profileInfo = z.object({
  name: z.string(),
  /** человекочитаемое имя (в UI всегда оно; name — внутренний слаг) */
  displayName: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  /** модели аккаунта; нет — список ещё не получен (UI показывает подсказки) */
  models: z.array(modelInfoSchema).optional(),
  /** откуда список: auto — у провайдера (/v1/models; не ответил — у Claude Code), manual — задан руками */
  modelsSource: z.enum(['auto', 'manual']).optional(),
  /** кто отдал список auto: provider — /v1/models провайдера (настоящие id), claude-code — запасной список Claude Code */
  modelsFrom: z.enum(['provider', 'claude-code']).optional(),
  /** модели, которым включён контекст 1M: к id при запуске Claude Code добавляется [1m] */
  long: z.array(z.string()).optional(),
  /** свои модели: база + окно контекста */
  custom: z.array(customModelSchema).optional(),
  /** когда список auto получен (epoch ms) */
  modelsAt: z.number().int().optional(),
  /** усилие по умолчанию для новых сессий аккаунта */
  defaultEffort: EffortLevelSchema.optional(),
  /** ultracode разрешён (по умолчанию да); false — кнопки нет и слово «ultracode» не срабатывает */
  ultracode: z.boolean().optional(),
  /** делегирование разрешено (по умолчанию нет): сессии аккаунта получают инструмент delegate_to_agent */
  delegate: z.boolean().optional(),
  /** нативные субагенты (Task/Agent) видны; по умолчанию: Claude-аккаунты — да, шлюзы — нет (моделей Anthropic нет) */
  nativeAgents: z.boolean().optional(),
  /** лимит ответа модели (CLAUDE_CODE_MAX_OUTPUT_TOKENS), обычно; нет — по умолчанию Claude Code (32K у незнакомых ему моделей) */
  maxOutput: z.number().int().optional(),
  /** лимит ответа на усилии xhigh и выше; нет — как обычно */
  maxOutputHigh: z.number().int().optional(),
  /** список задач (TaskCreate/TaskUpdate…, как в Claude Code Desktop); по умолчанию да */
  tasks: z.boolean().optional(),
  /** моделям без сведений об усилии (шлюз не сообщает) — стандартные уровни; по умолчанию: шлюзы — да */
  effortFallback: z.boolean().optional(),
  /** окно автокомпакта по умолчанию у сессий аккаунта (токены); нет — как у модели */
  compactWindow: z.number().int().optional(),
  /** показывать лимиты аккаунта (usage); по умолчанию — где источник есть (подписка Claude, z.ai) */
  usage: z.boolean().optional(),
  /** у аккаунта есть источник лимитов (подписка Claude или z.ai) */
  usageSource: z.enum(['claude', 'zai']).optional(),
  /** ключ API задан: последние символы («…UDPw»); сам ключ клиенту не уходит никогда */
  keyHint: z.string().max(12).optional(),
  /** ключ можно задать из UI (аккаунт через шлюз или с ключом в env); у подписки Claude — нет */
  keyEditable: z.boolean().optional(),
  /** хост шлюза аккаунта (api.z.ai) — ключ аккаунта можно отдать MCP-серверам этого домена */
  gatewayHost: z.string().optional(),
  /**
   * Вход в Claude Code у аккаунта без ключа (подписка): loggedIn=false — в UI «не вошёл · Войти».
   * Нет поля — неизвестно (ещё не проверяли) или аккаунт на ключе API.
   */
  auth: z.object({
    loggedIn: z.boolean(),
    email: z.string().optional(),
    /** тариф/способ: «Claude Max», «Pro», «ключ Console»… */
    plan: z.string().optional(),
  }).optional(),
});
export type ProfileInfoFrame = z.infer<typeof profileInfo>;

/** Проект: именованная папка на сервере с дефолтами. */
export const projectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  profile: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
});
export type ProjectInfoFrame = z.infer<typeof projectInfoSchema>;

// ─── Контент-блоки ассистента ──────────────────────────────────────────────

const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const thinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string() });
const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export const ContentBlockSchema = z.discriminatedUnion('type', [textBlock, thinkingBlock, toolUseBlock]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// ─── Вопросы AskUserQuestion (карточка-вопрос) ────────────────────────────

const questionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
const question = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(questionOption).min(1),
  multiSelect: z.boolean().optional(),
});
export const QuestionSchema = question;
export type Question = z.infer<typeof QuestionSchema>;

// ─── Метрики хода (result) ─────────────────────────────────────────────────

const usage = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
});

const modelUsage = z.record(z.string(), z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
}));

// ─── Команды (UI → supervisor) ─────────────────────────────────────────────

export const cmdHello = cmdBase.extend({
  type: z.literal('cmd:hello'),
  // последний полученный seq по каждой сессии — для догона после обрыва
  lastSeq: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

export const cmdSessionList = cmdBase.extend({ type: z.literal('cmd:session.list') });

export const cmdSessionNew = cmdBase.extend({
  type: z.literal('cmd:session.new'),
  name: z.string().min(1).optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  /** профиль аккаунта (мультиакк): имя из profiles.json supervisor'а */
  profile: z.string().optional(),
  /** создать сессию внутри проекта (дефолты проекта применяются к незаданным полям) */
  projectId: z.string().optional(),
  /** усилие; нет — defaultEffort аккаунта, дальше — по умолчанию модели */
  effort: EffortLevelSchema.optional(),
  ultracode: z.boolean().optional(),
  /** окно автокомпакта (токены): Claude Code сжимает историю, когда контекст подходит к нему */
  compactWindow: z.number().int().min(20_000).max(10_000_000).optional(),
  /** создать дочернюю сессию-воркера (UI не шлёт; нужно тестам и демо-стенду) */
  parentSessionId: z.string().uuid().optional(),
  agentOf: z.string().optional(),
});

/**
 * Настройки живой сессии: модель/режим/усилие/ultracode — на лету (SDK setModel/setPermissionMode/applyFlagSettings);
 * профиль — между ходами (respawn). effort: null — вернуть усилие по умолчанию модели.
 */
export const cmdSessionSettings = cmdBase.extend({
  type: z.literal('cmd:session.settings'),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  effort: EffortLevelSchema.nullable().optional(),
  ultracode: z.boolean().optional(),
  profile: z.string().optional(),
  /** окно автокомпакта; null — как у модели/аккаунта. Claude Code берёт его при старте процесса — между ходами */
  compactWindow: z.number().int().min(20_000).max(10_000_000).nullable().optional(),
});

/**
 * Модели аккаунта. refresh — спросить у Claude Code заново (supportedModels; для manual-аккаунтов игнорируется).
 * ack: { profile: profileInfo }.
 */
/** Лимиты аккаунта (usage). refresh — спросить источник заново (иначе — последнее известное). ack: { usage }. */
export const cmdProfileUsage = cmdBase.extend({
  type: z.literal('cmd:profile.usage'),
  profile: z.string().min(1),
  refresh: z.boolean().optional(),
});

export const cmdProfileModels = cmdBase.extend({
  type: z.literal('cmd:profile.models'),
  profile: z.string().min(1),
  refresh: z.boolean().optional(),
});

/**
 * Правка не-секретной части профиля (env/токены отсюда не меняются и в UI не ходят); пишется в profiles.json.
 * models задаёт ручной список (и переводит аккаунт в modelsSource=manual); modelsSource='auto' — вернуться к списку из Claude Code.
 * model/defaultEffort: null — убрать значение. ack: { profile: profileInfo }; всем клиентам — event:profiles.
 */
export const cmdProfileUpdate = cmdBase.extend({
  type: z.literal('cmd:profile.update'),
  profile: z.string().min(1),
  /** подпись аккаунта в UI; null — убрать (показывается name) */
  displayName: z.string().min(1).max(60).nullable().optional(),
  models: z.array(modelInfoSchema).max(100).optional(),
  modelsSource: z.enum(['auto', 'manual']).optional(),
  model: z.string().min(1).nullable().optional(),
  /** модели с контекстом 1M (весь список целиком) */
  long: z.array(z.string().min(1).max(200)).max(200).optional(),
  /** свои модели (весь список); пустой — убрать все */
  custom: z.array(customModelSchema).max(50).optional(),
  defaultEffort: EffortLevelSchema.nullable().optional(),
  ultracode: z.boolean().optional(),
  /** делегирование сабагентов на другие аккаунты: включить/выключить у аккаунта-родителя */
  delegate: z.boolean().optional(),
  /** нативные субагенты (Task/Agent): показать/спрятать у аккаунта */
  nativeAgents: z.boolean().optional(),
  /** лимит ответа обычно / на xhigh и выше; null — убрать (по умолчанию Claude Code / как обычно) */
  maxOutput: z.number().int().min(1000).max(1_000_000).nullable().optional(),
  maxOutputHigh: z.number().int().min(1000).max(1_000_000).nullable().optional(),
  /** список задач у аккаунта */
  tasks: z.boolean().optional(),
  /** стандартные уровни усилия моделям без сведений */
  effortFallback: z.boolean().optional(),
  /** окно автокомпакта по умолчанию у сессий аккаунта; null — убрать */
  compactWindow: z.number().int().min(20_000).max(10_000_000).nullable().optional(),
  /** показывать лимиты аккаунта */
  usage: z.boolean().optional(),
  /** новый ключ API аккаунта — только запись (в env профиля); обратно не отдаётся */
  apiKey: z.string().min(8).max(512).regex(/^\S+$/, 'ключ без пробелов').optional(),
});

/** Снимок контекста живой сессии (кольцо в правой панели). */
export const cmdSessionContext = cmdBase.extend({
  type: z.literal('cmd:session.context'),
});

export const cmdProjectList = cmdBase.extend({ type: z.literal('cmd:project.list') });

export const cmdProjectNew = cmdBase.extend({
  type: z.literal('cmd:project.new'),
  name: z.string().min(1),
  path: z.string().min(1),
  profile: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
});

/** Имя папки проекта: латиница, цифры, . _ - (клиент делает его из названия транслитом). */
export const ProjectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'папка — латиница, цифры, . _ -');

/** Хранилище проектов среды: папка, в которой новые проекты создаются по имени. */
export const storageInfoSchema = z.object({
  /** абсолютный путь на машине supervisor'а */
  root: z.string(),
  exists: z.boolean(),
  /** свободно на диске (если удалось узнать) */
  freeBytes: z.number().int().nonnegative().optional(),
});
export type StorageInfoFrame = z.infer<typeof storageInfoSchema>;

/** Сменить папку хранилища (нет — создаётся). ack: { storage }. */
export const cmdStorageSet = cmdBase.extend({
  type: z.literal('cmd:storage.set'),
  root: z.string().min(1),
});

/** Откуда новый проект: пустая папка, клон git или папка, которая уже есть. */
export const ProjectSourceSchema = z.enum(['empty', 'git', 'existing']);

/** Сведения о git-папке. */
export const gitInfoSchema = z.object({
  origin: z.string().nullable(),
  branch: z.string().nullable(),
  /** незакоммиченных изменений (строк git status --porcelain) */
  changed: z.number().int().nonnegative(),
});

/**
 * Что станет с папкой проекта — превью для диалога «Новый проект» (по среде).
 * Путь: path (свой) или <хранилище>/<slug>.
 * ack: { path, inStorage, exists, isDir, empty, git?, plan, reason? }
 *  plan: create — папки нет, создам · clone — склонирую · connect — подключу как есть
 *        (пустая/готовая папка; git с тем же origin) · conflict — папка занята (не git, другой origin, файл) · missing — готовой папки нет
 */
export const cmdProjectInspect = cmdBase.extend({
  type: z.literal('cmd:project.inspect'),
  source: ProjectSourceSchema,
  slug: ProjectSlugSchema.optional(),
  path: z.string().min(1).optional(),
  gitUrl: z.string().min(1).max(500).optional(),
});

/**
 * Создать проект из хранилища: empty — создать папку <хранилище>/<slug> (или свой path); git — склонировать gitUrl
 * (папка с тем же origin — подключить); existing — подключить существующую папку path.
 * Клон может идти минутами — клиент ждёт дольше обычного.
 * ack: { project, action: 'created'|'cloned'|'connected', path }; ошибки: PROJECT_EXISTS, PROJECT_PATH, GIT_FAILED.
 */
export const cmdProjectCreate = cmdBase.extend({
  type: z.literal('cmd:project.create'),
  name: z.string().min(1).max(100),
  source: ProjectSourceSchema,
  slug: ProjectSlugSchema.optional(),
  path: z.string().min(1).optional(),
  gitUrl: z.string().min(1).max(500).optional(),
  profile: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
});

/**
 * Обзор проектов среды для «Настройки → Проекты»: папка есть ли, в хранилище ли, git; папки хранилища без проекта.
 * ack: { storage, projects: [{ id, name, path, exists, inStorage, git? }], orphans: string[] }
 */
export const cmdProjectScan = cmdBase.extend({ type: z.literal('cmd:project.scan') });

/** Создать пропавшую папку проекта. ack: { project }. */
export const cmdProjectMkdir = cmdBase.extend({
  type: z.literal('cmd:project.mkdir'),
  projectId: z.string(),
});

export const cmdProjectRename = cmdBase.extend({
  type: z.literal('cmd:project.rename'),
  projectId: z.string(),
  name: z.string().min(1),
});

export const cmdProjectDelete = cmdBase.extend({
  type: z.literal('cmd:project.delete'),
  projectId: z.string(),
});

export const cmdSessionOpen = cmdBase.extend({
  type: z.literal('cmd:session.open'),
  sessionId: z.string().uuid(), // и в шапке тоже продублируем при отправке
});

export const cmdMessageSend = cmdBase.extend({
  type: z.literal('cmd:message.send'),
  text: z.string().min(1),
  images: z.array(z.string()).optional(), // base64 без префикса data:
});

export const cmdPermissionRespond = cmdBase.extend({
  type: z.literal('cmd:permission.respond'),
  requestId: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
  updatedInput: z.unknown().optional(),
  /** «всегда разрешать»: правило, добавляемое к сессии (SDK updatedPermissions) */
  updatedPermissions: z.unknown().optional(),
});

export const cmdSessionRename = cmdBase.extend({
  type: z.literal('cmd:session.rename'),
  name: z.string().min(1),
});

export const cmdSessionArchive = cmdBase.extend({
  type: z.literal('cmd:session.archive'),
  archived: z.boolean(),
});

/**
 * Перенос сессии в другую среду (T-ряд): источник отдаёт транскрипт с настройками,
 * сессия останавливается и уходит в архив с пометкой movedTo = to (метка среды-цели,
 * как её называет клиент, например «VPS»). Отдаём и HEAD с патчем незакоммиченных правок —
 * клиент сам решает, просить ли применения (сверив коммиты двух сред до переноса).
 */
export const cmdSessionExport = cmdBase.extend({
  type: z.literal('cmd:session.export'),
  sessionId: z.string().optional(),
  /** метка среды-цели для архивной пометки «переехала → …» */
  to: z.string().min(1),
})

/** Нагрузка машины supervisor'а: процессор, память, диск — для строки статуса/панели мониторинга. */
export const cmdSysStats = cmdBase.extend({ type: z.literal('cmd:sys.stats') })

/** Удаление сессии вместе с историей (транскриптом); работающую не удаляем — дождитесь конца хода. */
export const cmdSessionDelete = cmdBase.extend({
  type: z.literal('cmd:session.delete'),
  sessionId: z.string().optional(),
})

/** Приём перенесённой сессии: транскрипт ложится в папку проекта этой среды, сессия создаётся остывшей. */
export const cmdSessionImport = cmdBase.extend({
  type: z.literal('cmd:session.import'),
  name: z.string().min(1),
  /** имя проекта (связь по имени, как в синке); нет — сессия без проекта */
  project: z.string().optional(),
  /** транскрипт claude одним куском jsonl */
  transcript: z.string().min(1),
  /** id сессии claude — имя файла транскрипта и ключ --resume */
  claudeSessionId: z.string().min(1),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  profile: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  ultracode: z.boolean().optional(),
  /** патч незакоммиченных правок (git diff HEAD источника) */
  patch: z.string().optional(),
  /** HEAD источника; если задан и не совпал с HEAD проекта здесь — патч не применяем */
  baseCommit: z.string().optional(),
  /** откуда приехала — метка среды-источника для ленты и сайдбара */
  movedFrom: z.string().min(1),
})

export const cmdInterrupt = cmdBase.extend({ type: z.literal('cmd:interrupt') });

export const cmdSessionFork = cmdBase.extend({ type: z.literal('cmd:session.fork') });

export const cmdTranscriptGet = cmdBase.extend({
  type: z.literal('cmd:transcript.get'),
  afterUuid: z.string().optional(),
});

export const cmdSessionStop = cmdBase.extend({ type: z.literal('cmd:session.stop') });
/**
 * Разбудить остывшую сессию заранее (окно открыло её или начали печатать): процесс с resume, без хода — к отправке
 * он уже готов (initializing → idle). Живую — только «потрогать» (продлить простой). Ответ: data.result —
 * woken | alive | limit (лимит живых процессов/памяти: проснётся сообщением, как раньше).
 */
export const cmdSessionWake = cmdBase.extend({ type: z.literal('cmd:session.wake') });
/**
 * «С сервера» (настройки подключения): открытые SSH-ключи пользователя службы — копировать в GitHub/на другие машины
 * (data.keys), создать ключ ed25519 без пароля (data.key), проверить вход в GitHub (data: ok, login?, message,
 * hostKeysAdded — дописаны опубликованные ключи хоста github.com). Приватные ключи сервер не отдаёт.
 */
export const cmdKeysList = cmdBase.extend({ type: z.literal('cmd:keys.list') });
export const cmdKeysCreate = cmdBase.extend({ type: z.literal('cmd:keys.create') });
export const cmdKeysCheck = cmdBase.extend({ type: z.literal('cmd:keys.check') });
/** Переезд: опись сервера (data: Inventory из migrate.ts) — только чтение, секреты флагом без значений. */
export const cmdMigrateInventory = cmdBase.extend({ type: z.literal('cmd:migrate.inventory') });

// ─── Панели: файлы, git, терминал, порты ───────────────────────────────────
// Корень всех путей — папка сессии из шапки кадра (sessionId); пути в кадрах — относительно корня.
// Выход за корень (.., абсолютные пути, симлинки наружу) supervisor отвергает (err OUTSIDE_ROOT).

/** Список папки. ack: { root, path, entries: [{ name, kind: 'file'|'dir'|'link', size, mtimeMs }] } */
export const cmdFsList = cmdBase.extend({
  type: z.literal('cmd:fs.list'),
  path: z.string().default(''),
});

/** Чтение файла. ack: { path, size, truncated, binary, content } (content — utf8; у binary — пусто) */
export const cmdFsRead = cmdBase.extend({
  type: z.literal('cmd:fs.read'),
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(2_000_000).optional(),
});

/** git-статус папки сессии. ack: { root, branch: string|null, files: [{ path, status }] } — status как в porcelain: 'M', 'A', 'D', 'R', '??' … */
export const cmdGitStatus = cmdBase.extend({ type: z.literal('cmd:git.status') });

/** Слушающие TCP-порты на машине supervisor'а (для превью dev-сервера). ack: { ports: [{ port, host, process? }] } */
export const cmdNetPorts = cmdBase.extend({ type: z.literal('cmd:net.ports') });

/** Открыть терминал в папке сессии (cwd — подпапка корня). ack: { termId, mode: 'pty'|'pipe', shell, cwd } */
export const cmdTermOpen = cmdBase.extend({
  type: z.literal('cmd:term.open'),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
  cwd: z.string().optional(),
});
/** Подключиться к уже открытому терминалу (после реконнекта/второе окно). ack: { termId, mode, shell, cwd, scrollback } */
export const cmdTermAttach = cmdBase.extend({ type: z.literal('cmd:term.attach'), termId: z.string().min(1) });
/** Открытые терминалы сессии. ack: { terms: [{ termId, shell, cwd, mode, alive }] } */
export const cmdTermList = cmdBase.extend({ type: z.literal('cmd:term.list') });
export const cmdTermInput = cmdBase.extend({
  type: z.literal('cmd:term.input'),
  termId: z.string().min(1),
  data: z.string().max(65_536),
});
export const cmdTermResize = cmdBase.extend({
  type: z.literal('cmd:term.resize'),
  termId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
});
export const cmdTermClose = cmdBase.extend({ type: z.literal('cmd:term.close'), termId: z.string().min(1) });

// ─── Удалённый браузер (ретрансляция) ──────────────────────────────────────
// Chromium запускается на машине supervisor'а (VPS), картинка идёт кадрами JPEG (CDP Page.startScreencast),
// ввод мыши/клавиатуры — обратно (CDP Input.*). Кадры — event:rb.frame адресно подписанным сокетам, seq 0, мимо ринга.

const rbSize = { width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(1600) };

/** Открыть браузер. ack: { rbId, url, title }. */
export const cmdRbOpen = cmdBase.extend({
  type: z.literal('cmd:rb.open'),
  url: z.string().max(4000).optional(),
  ...rbSize,
  /** качество JPEG (меньше — легче для медленного туннеля) */
  quality: z.number().int().min(20).max(90).optional(),
  /**
   * Кадры по подтверждению: следующий кадр приходит только после cmd:rb.ack на предыдущий
   * (всегда самый свежий). На медленном канале задержка не копится в туннеле.
   */
  ackFrames: z.boolean().optional(),
});

/** Открытые браузеры. ack: { browsers: [{ rbId, url, title, width, height }] }. */
export const cmdRbList = cmdBase.extend({ type: z.literal('cmd:rb.list') });

/** Подписаться на браузер (после реконнекта / из другого окна); последний кадр приходит сразу. ack: { rbId, url, title }. */
export const cmdRbAttach = cmdBase.extend({ type: z.literal('cmd:rb.attach'), rbId: z.string().min(1), ackFrames: z.boolean().optional() });

/** Кадр дошёл и показан — можно слать следующий (для подписки с ackFrames). Ответ не нужен. */
export const cmdRbAck = cmdBase.extend({ type: z.literal('cmd:rb.ack'), rbId: z.string().min(1) });

/** Перейти по адресу или назад/вперёд/обновить/стоп. */
export const cmdRbNavigate = cmdBase.extend({
  type: z.literal('cmd:rb.navigate'),
  rbId: z.string().min(1),
  url: z.string().max(4000).optional(),
  action: z.enum(['back', 'forward', 'reload', 'stop']).optional(),
});

/** Модификаторы CDP: Alt=1, Ctrl=2, Meta=4, Shift=8. Координаты — в пикселях кадра. */
export const rbInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    type: z.enum(['move', 'down', 'up', 'wheel']),
    x: z.number(),
    y: z.number(),
    button: z.enum(['none', 'left', 'middle', 'right']).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  z.object({
    kind: z.literal('key'),
    type: z.enum(['down', 'up']),
    key: z.string().max(32),
    code: z.string().max(32).optional(),
    /** печатаемый символ (для type=down) */
    text: z.string().max(8).optional(),
    keyCode: z.number().int().optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  /** вставка текста целиком (буфер обмена) */
  z.object({ kind: z.literal('text'), text: z.string().max(5000) }),
]);
export type RbInput = z.infer<typeof rbInputSchema>;

export const cmdRbInput = cmdBase.extend({ type: z.literal('cmd:rb.input'), rbId: z.string().min(1), input: rbInputSchema });
export const cmdRbResize = cmdBase.extend({ type: z.literal('cmd:rb.resize'), rbId: z.string().min(1), ...rbSize });
export const cmdRbClose = cmdBase.extend({ type: z.literal('cmd:rb.close'), rbId: z.string().min(1) });

// ─── Ответы на команды (supervisor → UI, без seq) ─────────────────────────

export const ackFrame = z.object({
  v: z.literal(PROTOCOL_VERSION),
  ts: z.number().int().nonnegative(),
  id: z.string().min(1),
  ok: z.literal(true),
  data: z.unknown().optional(),
});

export const errFrame = z.object({
  v: z.literal(PROTOCOL_VERSION),
  ts: z.number().int().nonnegative(),
  id: z.string().min(1),
  ok: z.literal(false),
  code: z.string(), // например SESSION_NOT_FOUND, RESYNC_NEEDED
  message: z.string(),
});

// ─── События (supervisor → UI) ─────────────────────────────────────────────

export const eventHello = eventBase.extend({
  type: z.literal('event:hello'),
  server: z.object({ version: z.string(), uptimeMs: z.number().int().nonnegative() }),
  sessions: z.array(sessionSummary),
  /** доступные профили аккаунтов (мультиакк) */
  profiles: z.array(profileInfo).optional(),
  /** проекты (папки с дефолтами) */
  projects: z.array(projectInfoSchema).optional(),
  /** пул тёплых процессов: сколько готово / целевой размер */
  pool: z.object({ warm: z.number().int(), target: z.number().int() }).optional(),
  /** хранилище проектов среды */
  storage: storageInfoSchema.optional(),
});

export const eventSessionState = eventBase.extend({
  type: z.literal('event:session.state'),
  state: SessionStateSchema,
  needs: z.string().nullable().optional(),
});

/**
 * Появилась новая сессия (создана делегированием или программно) — всем клиентам, seq 0, мимо ринга:
 * подключённый клиент иначе не узнает о сессии до следующего hello. Сводка полная, как в hello.
 */
export const eventSessionCreated = eventBase.extend({
  type: z.literal('event:session.created'),
  session: sessionSummary,
});

export const eventSessionInit = eventBase.extend({
  type: z.literal('event:session.init'),
  // паспорт окружения из system/init (recon §2.1); сознательно урезанный набор
  tools: z.array(z.string()),
  mcpServers: z.array(z.object({ name: z.string(), status: z.string() })),
  model: z.string(),
  permissionMode: z.string(),
  /** настоящий id сессии claude (имя файла транскрипта, хэндл для resume) */
  claudeSessionId: z.string().optional(),
  slashCommands: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
});

export const eventMessageAssistant = eventBase.extend({
  type: z.literal('event:message.assistant'),
  messageId: z.string(),
  block: ContentBlockSchema,
  parentToolUseId: z.string().nullable().optional(), // субагентская ветка
});

export const eventStreamDelta = eventBase.extend({
  type: z.literal('event:stream.delta'),
  kind: z.enum(['text', 'thinking', 'input_json']),
  delta: z.string(),
  /** input_json: имя инструмента — в первом кадре вызова (delta пустая), чтобы окно показало «готовит Write…» */
  tool: z.string().optional(),
});

export const eventMessageUser = eventBase.extend({
  type: z.literal('event:message.user'),
  toolUseId: z.string().optional(),
  toolName: z.string().optional(),
  result: z.unknown().optional(), // структурированный toolUseResult
  isError: z.boolean().optional(),
});

export const eventPermissionRequest = eventBase.extend({
  type: z.literal('event:permission.request'),
  requestId: z.string().min(1),
  toolName: z.string(),
  input: z.unknown(),
  questions: z.array(question).optional(), // AskUserQuestion
});

export const eventPermissionResult = eventBase.extend({
  type: z.literal('event:permission.result'),
  requestId: z.string(),
  behavior: z.enum(['allow', 'deny', 'timeout']),
  reason: z.string().optional(),
});

export const eventTurnResult = eventBase.extend({
  type: z.literal('event:turn.result'),
  subtype: z.string(),
  result: z.string().optional(),
  totalCostUsd: z.number().optional(),
  usage: usage.optional(),
  modelUsage: modelUsage.optional(),
  numTurns: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  permissionDenials: z.number().int().nonnegative().optional(),
});

export const eventSubagentStart = eventBase.extend({
  type: z.literal('event:subagent.start'),
  parentToolUseId: z.string(),
  agentType: z.string().optional(),
});

export const eventSubagentMessage = eventBase.extend({
  type: z.literal('event:subagent.message'),
  parentToolUseId: z.string(),
  kind: z.enum(['text', 'thinking']),
});

export const eventSubagentStop = eventBase.extend({
  type: z.literal('event:subagent.stop'),
  parentToolUseId: z.string(),
});

/**
 * Поток терминала. НЕ входит в ринг-буфер и seq сессии (seq всегда 0, sessionId нет):
 * адресуется по termId клиентам, которые открыли/подключили терминал. Пропуски при обрыве
 * восстанавливаются через cmd:term.attach (scrollback).
 */
export const eventTermOutput = eventBase.extend({
  type: z.literal('event:term.output'),
  termId: z.string(),
  data: z.string(),
});
/** Кадр удалённого браузера: JPEG base64 размером width×height. */
export const eventRbFrame = eventBase.extend({
  type: z.literal('event:rb.frame'),
  rbId: z.string(),
  data: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});
/** Адрес/заголовок/загрузка удалённого браузера изменились. */
export const eventRbState = eventBase.extend({
  type: z.literal('event:rb.state'),
  rbId: z.string(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
});
/** Браузер закрылся (закрыли, упал, простаивал слишком долго). */
export const eventRbExit = eventBase.extend({
  type: z.literal('event:rb.exit'),
  rbId: z.string(),
  reason: z.string().optional(),
});

export const eventTermExit = eventBase.extend({
  type: z.literal('event:term.exit'),
  termId: z.string(),
  code: z.number().int().nullable(),
});

/**
 * Запрос к API не прошёл и будет повторён (SDK system/api_retry): номер попытки, пауза, HTTP-статус
 * (null — нет ответа, обрыв/таймаут) и категория ошибки SDK (rate_limit, authentication_failed, …).
 */
export const eventApiRetry = eventBase.extend({
  type: z.literal('event:api.retry'),
  attempt: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  delayMs: z.number().int().nonnegative(),
  status: z.number().int().nullable(),
  error: z.string(),
});

/** Окно лимита аккаунта (как /usage в Claude Code): сколько использовано, когда сбросится. */
export const usageWindowSchema = z.object({
  /** five_hour, seven_day, seven_day_opus, zai:5h… — стабильный ключ */
  id: z.string(),
  /** «5 часов», «неделя», «неделя · Opus» */
  label: z.string(),
  /** использовано, 0–100 */
  pct: z.number(),
  /** когда сбросится (epoch ms) */
  resetsAt: z.number().optional(),
  /** allowed / allowed_warning / rejected — если источник сообщает */
  status: z.string().optional(),
  /** сколько из скольких (z.ai — кредиты), если известно */
  used: z.number().optional(),
  limit: z.number().optional(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageInfoSchema = z.object({
  /** откуда: claude — лимиты подписки (ответы API / /usage), zai — квота GLM Coding Plan */
  source: z.enum(['claude', 'zai']),
  /** тариф, если известен (max, pro, team…) */
  plan: z.string().optional(),
  windows: z.array(usageWindowSchema),
  /** когда получено (epoch ms) */
  at: z.number(),
  /** пояснение, когда окон нет (например, «появятся после первого хода») */
  note: z.string().optional(),
});
export type UsageInfo = z.infer<typeof usageInfoSchema>;

/** Лимиты аккаунта обновились (пришли с ответом API в ходе сессии) — всем клиентам; seq 0, мимо ринга. */
export const eventUsage = eventBase.extend({
  type: z.literal('event:usage'),
  profile: z.string(),
  usage: usageInfoSchema,
});

/** Профили изменились (правка или обновление моделей) — всем подключённым клиентам; seq 0, мимо ринга. */
export const eventProfiles = eventBase.extend({
  type: z.literal('event:profiles'),
  profiles: z.array(profileInfo),
});

/**
 * Ход входа в подписку (всем клиентам, seq 0): starting → waiting (rbId/url) → verifying → done | failed | cancelled.
 * rbError — браузер на сервере недоступен (UI сразу показывает запасной путь с кодом).
 */
export const eventProfileLogin = eventBase.extend({
  type: z.literal('event:profile.login'),
  loginId: z.string(),
  state: z.enum(['starting', 'waiting', 'verifying', 'done', 'failed', 'cancelled']),
  rbId: z.string().optional(),
  url: z.string().optional(),
  rbError: z.string().optional(),
  profile: z.string().optional(),
  email: z.string().optional(),
  plan: z.string().optional(),
  error: z.string().optional(),
});

export const eventError = eventBase.extend({
  type: z.literal('event:error'),
  code: z.string(), // RESYNC_NEEDED | INTERNAL | ...
  message: z.string(),
});

/** Шаблон аккаунта на ключе API: подставляет адрес, переменную ключа и модели. */
/** claude-token — токен подписки Claude (`claude setup-token`), уходит в CLAUDE_CODE_OAUTH_TOKEN */
export const KeyTemplateSchema = z.enum(['anthropic', 'zai', 'custom', 'claude-token']);
export type KeyTemplate = z.infer<typeof KeyTemplateSchema>;

/**
 * Новый аккаунт на ключе API (шаблон Anthropic / z.ai / свой адрес). Ключ — только запись в env профиля.
 * name — слаг (латиница, цифры, - _), displayName — подпись. ack: { profile: profileInfo }; всем — event:profiles.
 */
export const cmdProfileAdd = cmdBase.extend({
  type: z.literal('cmd:profile.add'),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  displayName: z.string().min(1).max(60).optional(),
  template: KeyTemplateSchema,
  /** адрес для custom (у шаблонов — свой) */
  baseUrl: z.string().url().max(500).optional(),
  apiKey: z.string().min(8).max(500),
  /** модели вместо шаблонных */
  models: z.array(modelInfoSchema).max(100).optional(),
});

/**
 * Проверить ключ мини-запросом (max_tokens 1): существующего аккаунта (profile) или черновика (template + apiKey).
 * ack: { ok, ms, status?, message? } — ошибка API приходит как ok:false со статусом и текстом сервиса.
 */
export const cmdProfileCheck = cmdBase.extend({
  type: z.literal('cmd:profile.check'),
  profile: z.string().min(1).optional(),
  template: KeyTemplateSchema.optional(),
  baseUrl: z.string().url().max(500).optional(),
  apiKey: z.string().min(8).max(500).optional(),
  model: z.string().min(1).optional(),
});

/**
 * Вход в подписку Claude на стороне сервера: supervisor запускает `claude auth login`, страницу входа
 * открывает во вкладке браузера на сервере (rbId) и сам забирает код со страницы-ответа.
 * profile — войти в существующий аккаунт (например, `default`); иначе — новый аккаунт (имя возьмётся из почты или name).
 * ack: { loginId, rbId?, url? }; дальше — event:profile.login.
 */
export const cmdProfileLoginStart = cmdBase.extend({
  type: z.literal('cmd:profile.login.start'),
  profile: z.string().min(1).optional(),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).optional(),
  displayName: z.string().min(1).max(60).optional(),
  width: z.number().int().min(320).max(2560),
  height: z.number().int().min(240).max(1600),
});
/** Код со страницы Anthropic руками (запасной путь). ack: {} */
export const cmdProfileLoginCode = cmdBase.extend({
  type: z.literal('cmd:profile.login.code'),
  loginId: z.string().min(1),
  code: z.string().min(4).max(2000),
});
/** Прервать вход: процесс входа и вкладка закрываются, новый аккаунт не создаётся. ack: {} */
export const cmdProfileLoginCancel = cmdBase.extend({
  type: z.literal('cmd:profile.login.cancel'),
  loginId: z.string().min(1),
});

/**
 * Выпустить токен подписки (`claude setup-token`) на машине этого supervisor'а: страницу входа Claude Code открывает
 * в браузере этой машины (у локального — в браузере владельца). ack: { loginId, url? }; ход — event:profile.login
 * (без токена); код руками — cmd:profile.login.code; отмена — cmd:profile.login.cancel; токен — cmd:profile.token.take.
 */
export const cmdProfileTokenStart = cmdBase.extend({ type: z.literal('cmd:profile.token.start') });
/** Забрать выпущенный токен — один раз. ack: { token } */
export const cmdProfileTokenTake = cmdBase.extend({ type: z.literal('cmd:profile.token.take'), loginId: z.string().min(1) });

// ─── MCP-подключения аккаунта (через `claude mcp`, user scope) ─────────────

const mcpNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const mcpConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['http', 'sse']), url: z.string().url().max(2000), headers: z.record(z.string(), z.string().max(4000)).optional() }),
  z.object({ type: z.literal('stdio'), command: z.string().min(1).max(500), args: z.array(z.string().max(1000)).max(50).optional(), env: z.record(z.string(), z.string().max(4000)).optional() }),
]);
export type McpConfigFrame = z.infer<typeof mcpConfigSchema>;

/** Список MCP аккаунта со статусами (`claude mcp list`, до минуты). ack: { servers: [{ name, transport, target, status, statusText, scope, headerNames?, envNames? }] } */
export const cmdMcpList = cmdBase.extend({ type: z.literal('cmd:mcp.list'), profile: z.string().min(1) });
/** Добавить сервер аккаунту; секреты (заголовки/env) только записываются. ack: { servers } */
export const cmdMcpAdd = cmdBase.extend({ type: z.literal('cmd:mcp.add'), profile: z.string().min(1), name: mcpNameSchema, config: mcpConfigSchema });
/** Удалить сервер аккаунта. ack: { servers } */
export const cmdMcpRemove = cmdBase.extend({ type: z.literal('cmd:mcp.remove'), profile: z.string().min(1), name: mcpNameSchema });
/** Вход OAuth в MCP-сервер (`claude mcp login --no-browser`, вкладка браузера на сервере). ack: { loginId, rbId?, url? }; дальше — event:profile.login. */
export const cmdMcpLoginStart = cmdBase.extend({
  type: z.literal('cmd:mcp.login.start'), profile: z.string().min(1), name: mcpNameSchema,
  width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(1600),
});

/**
 * Поиск в каталоге MCP (официальный реестр). ack: { entries: [{ id, title, description, version, publisher, repo?, website?,
 * suggestedName, deprecated?, variants: [{ id, kind, label, runtime?, missing?, fields: [...], template: {...} }] }], skipped }.
 * Шаблон заполняет клиент («{{ключ}}» → значение поля) и ставит обычным cmd:mcp.add.
 */
export const cmdMcpCatalogSearch = cmdBase.extend({ type: z.literal('cmd:mcp.catalog.search'), query: z.string().max(200) });

/**
 * Общий список MCP среды: серверы всех аккаунтов (по именам) и у кого включены. Цель — аккаунты с общим файлом
 * настроек Claude Code. check — спросить статусы (`claude mcp list` у каждой цели, до минуты).
 * ack: { targets: [{ id, profiles }], servers: [{ name, transport, target, headerNames?, envNames?, accountKey, stored,
 * on: { <id цели>: { status, statusText } } }], other: [{ name, transport, target, targets }] }
 */
export const cmdMcpShared = cmdBase.extend({ type: z.literal('cmd:mcp.shared'), check: z.boolean().optional() });
/** Включить/выключить общий сервер у аккаунта (запись в его Claude Code из копии). ack: {} */
export const cmdMcpToggle = cmdBase.extend({ type: z.literal('cmd:mcp.toggle'), profile: z.string().min(1), name: mcpNameSchema, on: z.boolean() });
/** Добавить сервер всем аккаунтам (или перечисленным) и в общий список. ack: { results: [{ profile, ok, error? }] } */
export const cmdMcpSharedAdd = cmdBase.extend({
  type: z.literal('cmd:mcp.shared.add'), name: mcpNameSchema, config: mcpConfigSchema, profiles: z.array(z.string().min(1)).max(50).optional(),
});
/** Поставить стандартный набор (z.ai: поиск, чтение страниц, zread, изображения) всем аккаунтам — недостающие. ack: { added: string[], results } */
export const cmdMcpPreset = cmdBase.extend({ type: z.literal('cmd:mcp.preset'), preset: z.literal('zai') });
/** Удалить сервер у всех аккаунтов и из общего списка. ack: { results: [{ profile, ok, error? }] } */
export const cmdMcpSharedRemove = cmdBase.extend({ type: z.literal('cmd:mcp.shared.remove'), name: mcpNameSchema });

// ─── Объединение ───────────────────────────────────────────────────────────

export const CmdSchema = z.discriminatedUnion('type', [
  cmdHello, cmdSessionList, cmdSessionNew, cmdSessionOpen,
  cmdMessageSend, cmdPermissionRespond, cmdInterrupt, cmdSessionFork, cmdTranscriptGet, cmdSessionStop, cmdSessionWake, cmdKeysList, cmdKeysCreate, cmdKeysCheck, cmdMigrateInventory,
  cmdSessionSettings, cmdSessionContext, cmdProfileModels, cmdProfileUsage, cmdProfileUpdate,
  cmdProfileAdd, cmdProfileCheck, cmdProfileLoginStart, cmdProfileLoginCode, cmdProfileLoginCancel,
  cmdProfileTokenStart, cmdProfileTokenTake,
  cmdMcpList, cmdMcpAdd, cmdMcpRemove, cmdMcpLoginStart, cmdMcpCatalogSearch,
  cmdMcpShared, cmdMcpToggle, cmdMcpSharedAdd, cmdMcpSharedRemove, cmdMcpPreset,
  cmdProjectList, cmdProjectNew, cmdProjectRename, cmdProjectDelete,
  cmdStorageSet, cmdProjectInspect, cmdProjectCreate, cmdProjectScan, cmdProjectMkdir,
  cmdSessionRename, cmdSessionArchive, cmdSessionDelete, cmdSessionExport, cmdSessionImport, cmdSysStats,
  cmdFsList, cmdFsRead, cmdGitStatus, cmdNetPorts,
  cmdTermOpen, cmdTermAttach, cmdTermList, cmdTermInput, cmdTermResize, cmdTermClose,
  cmdRbOpen, cmdRbList, cmdRbAttach, cmdRbAck, cmdRbNavigate, cmdRbInput, cmdRbResize, cmdRbClose,
]);
export type Cmd = z.infer<typeof CmdSchema>;

export const EventSchema = z.discriminatedUnion('type', [
  eventHello, eventSessionState, eventSessionCreated, eventSessionInit, eventMessageAssistant,
  eventStreamDelta, eventMessageUser, eventPermissionRequest, eventPermissionResult,
  eventTurnResult, eventSubagentStart, eventSubagentMessage, eventSubagentStop, eventError,
  eventTermOutput, eventTermExit, eventProfiles, eventApiRetry,
  eventRbFrame, eventRbState, eventRbExit, eventProfileLogin, eventUsage,
]);
export type Event = z.infer<typeof EventSchema>;

export const ReplySchema = z.discriminatedUnion('ok', [ackFrame, errFrame]);
export type Reply = z.infer<typeof ReplySchema>;

export const FrameSchema = z.union([CmdSchema, EventSchema, ReplySchema]);
export type Frame = z.infer<typeof FrameSchema>;

// Список известных типов — для терпимости к неизвестным (прямая совместимость)
export const KNOWN_EVENT_TYPES: readonly string[] = [
  'event:hello', 'event:session.state', 'event:session.created', 'event:session.init', 'event:message.assistant',
  'event:stream.delta', 'event:message.user', 'event:permission.request', 'event:permission.result',
  'event:turn.result', 'event:subagent.start', 'event:subagent.message', 'event:subagent.stop',
  'event:error',
  'event:term.output', 'event:term.exit', 'event:profiles', 'event:api.retry',
  'event:rb.frame', 'event:rb.state', 'event:rb.exit', 'event:profile.login', 'event:usage',
] as const;

export const KNOWN_CMD_TYPES: readonly string[] = [
  'cmd:hello', 'cmd:session.list', 'cmd:session.new', 'cmd:session.open',
  'cmd:message.send', 'cmd:permission.respond', 'cmd:interrupt', 'cmd:session.fork', 'cmd:transcript.get',
  'cmd:session.stop', 'cmd:session.wake', 'cmd:keys.list', 'cmd:keys.create', 'cmd:keys.check', 'cmd:migrate.inventory', 'cmd:session.settings', 'cmd:session.context', 'cmd:profile.models', 'cmd:profile.usage', 'cmd:profile.update',
  'cmd:profile.add', 'cmd:profile.check', 'cmd:profile.login.start', 'cmd:profile.login.code', 'cmd:profile.login.cancel',
  'cmd:profile.token.start', 'cmd:profile.token.take',
  'cmd:mcp.list', 'cmd:mcp.add', 'cmd:mcp.remove', 'cmd:mcp.login.start', 'cmd:mcp.catalog.search',
  'cmd:mcp.shared', 'cmd:mcp.toggle', 'cmd:mcp.shared.add', 'cmd:mcp.shared.remove', 'cmd:mcp.preset',
  'cmd:project.list', 'cmd:project.new', 'cmd:project.rename', 'cmd:project.delete',
  'cmd:storage.set', 'cmd:project.inspect', 'cmd:project.create', 'cmd:project.scan', 'cmd:project.mkdir',
  'cmd:session.rename', 'cmd:session.archive', 'cmd:session.delete', 'cmd:session.export', 'cmd:session.import', 'cmd:sys.stats',
  'cmd:fs.list', 'cmd:fs.read', 'cmd:git.status', 'cmd:net.ports',
  'cmd:term.open', 'cmd:term.attach', 'cmd:term.list', 'cmd:term.input', 'cmd:term.resize', 'cmd:term.close',
  'cmd:rb.open', 'cmd:rb.list', 'cmd:rb.attach', 'cmd:rb.ack', 'cmd:rb.navigate', 'cmd:rb.input', 'cmd:rb.resize', 'cmd:rb.close',
] as const;

// ─── Парсер ────────────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; frame: Frame }
  | { ok: true; unknownType: string; raw: unknown } // новый тип от сервера новее клиента — игнорируем
  | { ok: false; code: 'VERSION' | 'SCHEMA'; error: string };

export function parseFrame(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'SCHEMA', error: 'кадр не объект' };
  }
  const r = raw as Record<string, unknown>;
  if (r['v'] !== PROTOCOL_VERSION) {
    return { ok: false, code: 'VERSION', error: `неизвестная версия протокола: ${String(r['v'])}` };
  }
  const t = typeof r['type'] === 'string' ? r['type'] : null;
  const isReply = r['ok'] !== undefined; // ack/err различаются полем ok
  if (!t && !isReply) {
    return { ok: false, code: 'SCHEMA', error: 'кадр без type' };
  }
  if (t !== null && !KNOWN_EVENT_TYPES.includes(t) && !KNOWN_CMD_TYPES.includes(t)) {
    return { ok: true, unknownType: t, raw };
  }
  const parsed = FrameSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'SCHEMA', error: parsed.error.message };
  }
  return { ok: true, frame: parsed.data };
}

// ─── Гварды-хелперы ────────────────────────────────────────────────────────

export function isEvent(f: Frame): f is Event {
  return typeof (f as { type?: string }).type === 'string' && (f as { type: string }).type.startsWith('event:');
}

export function isCmd(f: Frame): f is Cmd {
  return typeof (f as { type?: string }).type === 'string' && (f as { type: string }).type.startsWith('cmd:');
}

export function makeAck(id: string, data?: unknown): Reply {
  return { v: PROTOCOL_VERSION, ts: Date.now(), id, ok: true, ...(data !== undefined ? { data } : {}) };
}

export function makeErr(id: string, code: string, message: string): Reply {
  return { v: PROTOCOL_VERSION, ts: Date.now(), id, ok: false, code, message };
}
