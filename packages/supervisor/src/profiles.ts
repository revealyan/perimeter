// Профили аккаунтов (мультиакк): у каждого свой CLAUDE_CONFIG_DIR (креды/settings/projects),
// а тяжёлое общее (plugins/skills/кэши) делится симлинками на базовый каталог — см. docs/deploy.md.
// Профили живут на VPS в ~/.perimeter/profiles.json — токены не ходят в UI.
//
// Модели, усилие и ultracode по аккаунтам (макет A1):
// - список моделей: auto — у провайдера (GET /v1/models: настоящие id, окно контекста, усилия; см. providerModels.ts),
//   провайдер не ответил или ключа нет (подписка через `claude auth login`) — у самого Claude Code (supportedModels);
//   кэш в profiles-cache.json рядом, чтобы обновление списка не переписывало файл с токенами; manual — руками;
// - long — модели, которым включён контекст 1M: при запуске к id добавляется [1m] (не у всех тарифов/шлюзов он есть);
//   не задан — берётся из настроек Claude Code аккаунта (модели с [1m] в model / ANTHROPIC_*_MODEL), пустой — 1M выключен у всех;
// - custom — свои модели: база + окно контекста (`glm-5.3@400k`); запуск — база (с [1m], если окно больше 200K)
//   и autoCompactWindow при старте процесса (на ходу Claude Code окно не меняет — проверено на 2.1.319);
// - defaultEffort — усилие новых сессий аккаунта; ultracode — разрешён ли (у GLM его нет);
// - окружение самого supervisor'а (сессии без профиля) видно клиенту как профиль `default` — «По умолчанию»:
//   у него тоже есть модели и усилие. Внутри такие сессии по-прежнему без профиля (их обслуживает пул).

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EffortLevelSchema, customModelId, customModelSchema, modelInfoSchema, parseCustomModelId,
  type CustomModel, type EffortLevel, type ModelInfoFrame, type ProfileInfoFrame,
} from '@perimeter/protocol';

/** Чем запускать Claude Code: модель для --model и окно контекста (autoCompactWindow) — только при старте процесса. */
export interface Launch {
  model?: string;
  window?: number;
}

export interface Profile {
  name: string;
  /** человекочитаемое имя для UI; отсутствует — показываем name */
  displayName?: string;
  description?: string;
  model?: string;
  /** окружение субпроцесса claude (например, z.ai: ANTHROPIC_BASE_URL/AUTH_TOKEN) */
  env?: Record<string, string>;
  /** отдельный CLAUDE_CONFIG_DIR аккаунта; отсутствует = базовый (~/.claude сервиса) */
  configDir?: string;
  /** ручной список моделей (modelsSource=manual) */
  models?: ModelInfoFrame[];
  /** откуда список; нет — auto (у провайдера) */
  modelsSource?: 'auto' | 'manual';
  /** модели с контекстом 1M: Claude Code запускается с `<id>[1m]` */
  long?: string[];
  /** свои модели: база + окно контекста */
  custom?: CustomModel[];
  /** усилие новых сессий аккаунта */
  defaultEffort?: EffortLevel;
  /** ultracode разрешён; нет — по умолчанию (шлюз → нет, иначе да) */
  ultracode?: boolean;
  /** делегирование сабагентов на другие аккаунты; по умолчанию нет — осознанный opt-in (тратится квота другого аккаунта) */
  delegate?: boolean;
  /** нативные субагенты (Task/Agent); по умолчанию: шлюзы — нет (моделей Anthropic там нет), Claude — да */
  nativeAgents?: boolean;
  /** лимит ответа (CLAUDE_CODE_MAX_OUTPUT_TOKENS) обычно; нет — по умолчанию Claude Code */
  maxOutput?: number;
  /** лимит ответа на усилии xhigh и выше; нет — как обычно */
  maxOutputHigh?: number;
  /** список задач (TaskCreate/TaskUpdate…); по умолчанию да */
  tasks?: boolean;
  /** стандартные уровни усилия моделям без сведений; по умолчанию: шлюзы — да */
  effortFallback?: boolean;
}

export interface ProfilesFile {
  version: 1;
  profiles: Profile[];
}

/** Правка не-секретной части профиля из UI (cmd:profile.update). null — убрать значение. */
export interface ProfilePatch {
  /** подпись в UI; null — убрать */
  displayName?: string | null;
  models?: ModelInfoFrame[];
  modelsSource?: 'auto' | 'manual';
  model?: string | null;
  /** модели с контекстом 1M (весь список) */
  long?: string[];
  /** свои модели (весь список); пустой — убрать */
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
  /** новый ключ API (только запись в env профиля; в логи и клиенту не уходит) */
  apiKey?: string;
}

/** Переменная окружения с ключом профиля: токен подписки, API_KEY (часть шлюзов) или AUTH_TOKEN. */
export function keyVar(env: Record<string, string> | undefined): 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_OAUTH_TOKEN' {
  if (env?.['CLAUDE_CODE_OAUTH_TOKEN'] !== undefined) return 'CLAUDE_CODE_OAUTH_TOKEN';
  return env?.['ANTHROPIC_API_KEY'] !== undefined && env['ANTHROPIC_AUTH_TOKEN'] === undefined ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
}

/** Хост шлюза (ANTHROPIC_BASE_URL) — не секрет; нет шлюза или адрес битый — undefined. */
export function gatewayHost(p: Profile): string | undefined {
  const u = p.env?.['ANTHROPIC_BASE_URL'];
  if (!u) return undefined;
  try { return new URL(u).hostname; } catch { return undefined; }
}

/** Аккаунт на токене подписки Claude (`claude setup-token`). */
export function usesSubToken(p: Profile): boolean {
  return p.env?.['CLAUDE_CODE_OAUTH_TOKEN'] !== undefined;
}

/** Можно ли задать ключ из UI: шлюз или ключ уже в env. Подписку Claude (вход через claude login) не трогаем. */
export function keyEditable(p: Profile): boolean {
  if (p.name === BASE_PROFILE && isBaseLike(p)) return false; // ключ аккаунта supervisor'а — в настройках Claude Code
  return isGateway(p) || p.env?.['ANTHROPIC_AUTH_TOKEN'] !== undefined || p.env?.['ANTHROPIC_API_KEY'] !== undefined || usesSubToken(p);
}

/** «…UDPw» — последние символы ключа, как на сайте z.ai; короткий ключ не раскрываем вовсе. */
export function keyHint(p: Profile): string | undefined {
  const k = p.env?.[keyVar(p.env)];
  if (k === undefined || k === '') return undefined;
  return k.length >= 16 ? `…${k.slice(-4)}` : '…';
}

/** Имя, под которым клиенту виден аккаунт самого supervisor'а (сессии без профиля). */
export const BASE_PROFILE = 'default';
const BASE_LABEL = 'По умолчанию';
const BASE_DESCRIPTION = 'аккаунт, под которым запущен supervisor';

interface CacheEntry { at: number; models: ModelInfoFrame[]; from?: ModelsFrom }
export type ModelsFrom = 'provider' | 'claude-code';
/** 4 — список у провайдера с настоящими id (2026-11-12): старый кэш (псевдонимы Claude Code) перечитывается */
const CACHE_VERSION = 4;

/** Вход в Claude Code у аккаунта без ключа (по `claude auth status --json`). */
export interface AuthInfo { loggedIn: boolean; email?: string; plan?: string }

export class ProfileRegistry {
  private map = new Map<string, Profile>();
  private cache = new Map<string, CacheEntry>();
  /** вход аккаунтов-подписок (в памяти: проверяется при старте и после входа) */
  private auth = new Map<string, AuthInfo>();
  private readonly file: string | undefined;
  private readonly cacheFile: string | undefined;

  constructor(profiles: Profile[], opts: { file?: string; cacheFile?: string } = {}) {
    for (const p of profiles) this.map.set(p.name, p);
    this.file = opts.file;
    this.cacheFile = opts.cacheFile;
    if (this.cacheFile) this.cache = readCache(this.cacheFile);
  }

  static load(file: string | undefined): ProfileRegistry {
    if (!file) return new ProfileRegistry([]);
    const cacheFile = join(dirname(file), 'profiles-cache.json');
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as ProfilesFile;
      const list = raw.version === 1 && Array.isArray(raw.profiles) ? raw.profiles : [];
      return new ProfileRegistry(list.map(normalizeProfile).filter((p): p is Profile => p !== null), { file, cacheFile });
    } catch {
      // нет файла/битый — работаем без профилей; правка из UI создаст файл (битый не перезаписываем — см. update)
      return new ProfileRegistry([], { file, cacheFile });
    }
  }

  /** Профиль по имени; `default` — аккаунт самого supervisor'а (синтетический, если его нет в файле). */
  get(name: string | undefined): Profile | undefined {
    if (name === undefined) return undefined;
    return this.map.get(name) ?? (name === BASE_PROFILE ? this.syntheticBase() : undefined);
  }

  /** Профили из файла (без синтетического `default`). */
  list(): Profile[] {
    return [...this.map.values()];
  }

  /** Что видит клиент: профили файла + аккаунт supervisor'а (если его нет в файле как отдельного аккаунта). */
  publicList(): Profile[] {
    return this.allWithBase().filter((p) => !this.hiddenBase(p));
  }

  /** Профили файла + аккаунт supervisor'а (даже не вошедший). */
  private allWithBase(): Profile[] {
    const base = this.map.has(BASE_PROFILE) ? [] : [this.syntheticBase()];
    return [...this.list(), ...base];
  }

  /**
   * Аккаунт самого supervisor'а клиенту не показываем, если он нерабочий: не вошёл в Claude Code и без ключа/шлюза
   * (свежий сервер, где работают через добавленные аккаунты) — иначе пустая карточка «По умолчанию» висит зря.
   * Пока вход не проверен — показываем; вошёл (claude auth login на сервере) — появится сам после проверки.
   */
  private hiddenBase(p: Profile): boolean {
    return p.name === BASE_PROFILE && isBaseLike(p) && !usesKey(p) && this.auth.get(BASE_PROFILE)?.loggedIn === false;
  }

  /** Имя аккаунта supervisor'а для клиента; undefined — в файле есть настоящий профиль `default` со своим env. */
  baseName(): string | undefined {
    const real = this.map.get(BASE_PROFILE);
    return !real || isBaseLike(real) ? BASE_PROFILE : undefined;
  }

  /** Имя от клиента → профиль сессии внутри supervisor'а (`default` = без профиля). */
  internal(name: string | undefined): string | undefined {
    return name !== undefined && name === this.baseName() ? undefined : name;
  }

  /** Профиль сессии → имя для клиента (без профиля = `default`). */
  external(name: string | undefined): string | undefined {
    return name ?? this.baseName();
  }

  /** Откуда список моделей аккаунта. */
  modelsSource(name: string | undefined): 'auto' | 'manual' {
    const p = this.get(this.external(name));
    return p?.modelsSource ?? 'auto';
  }

  /** Разрешён ли ultracode аккаунту. */
  ultracodeAllowed(name: string | undefined): boolean {
    const p = this.get(this.external(name));
    if (!p) return true;
    return p.ultracode ?? !isGateway(p);
  }

  /** Разрешено ли аккаунту делегирование сабагентов (инструмент delegate_to_agent); по умолчанию нет. */
  delegateAllowed(name: string | undefined): boolean {
    const p = this.get(this.external(name));
    return p?.delegate === true;
  }

  /** Видны ли нативные субагенты (Task/Agent); по умолчанию шлюзы — нет (моделей Anthropic нет), Claude — да. */
  nativeAgentsAllowed(name: string | undefined): boolean {
    const p = this.get(this.external(name));
    if (!p) return true;
    return p.nativeAgents ?? !isGateway(p);
  }

  /** Список задач (инструменты TaskCreate/TaskUpdate…) у аккаунта; по умолчанию да. */
  tasksAllowed(name: string | undefined): boolean {
    return this.get(this.external(name))?.tasks ?? true;
  }

  /** Стандартные уровни усилия моделям без сведений; по умолчанию — у шлюзов. */
  effortFallback(name: string | undefined): boolean {
    const p = this.get(this.external(name));
    if (!p) return false;
    return p.effortFallback ?? isGateway(p);
  }

  /**
   * Лимит ответа сессии при этом усилии: undefined — аккаунт лимитов не задал (ничего не трогаем),
   * null — «по умолчанию Claude Code» (явный сброс, когда лимит на высоком усилии задан, а обычный — нет),
   * число — CLAUDE_CODE_MAX_OUTPUT_TOKENS.
   */
  outputTokens(name: string | undefined, effort: EffortLevel | undefined | null): number | null | undefined {
    const p = this.get(this.external(name));
    if (!p || (p.maxOutput === undefined && p.maxOutputHigh === undefined)) return undefined;
    return (isHighEffort(effort) ? p.maxOutputHigh ?? p.maxOutput : p.maxOutput) ?? null;
  }

  /**
   * Модель для запуска Claude Code (--model): включён 1M — `<id>[1m]`. Уже с [1m] (ручной список) — как есть.
   * Идемпотентно: повторный вызов не добавит второй суффикс.
   */
  launchModel(name: string | undefined, model: string | undefined): string | undefined {
    if (model === undefined || /\[1m\]$/i.test(model)) return model;
    const p = this.get(this.external(name));
    return p && effectiveLong(p).includes(model) ? `${model}[1m]` : model;
  }

  /**
   * Запуск модели сессии: своя модель (`glm-5.3@400k`) — база, с [1m] при окне больше 200K, и окно контекста
   * (кроме 1M — оно и так у [1m]); обычная — как launchModel. Своя модель узнаётся по id, даже если её удалили.
   */
  launch(name: string | undefined, model: string | undefined): Launch {
    const c = parseCustomModelId(model);
    if (c) {
      const m = c.ctx > 200_000 && !/\[1m\]$/i.test(c.base) ? `${c.base}[1m]` : c.base;
      return { model: m, ...(c.ctx < 1_000_000 ? { window: c.ctx } : {}) };
    }
    const m = this.launchModel(name, model);
    return m !== undefined ? { model: m } : {};
  }

  /** Модели аккаунта; undefined — список ещё не получен (auto без кэша). */
  models(name: string | undefined): ModelInfoFrame[] | undefined {
    const ext = this.external(name);
    const p = this.get(ext);
    if (!p || ext === undefined) return undefined;
    const list = this.modelsSource(ext) === 'manual' ? p.models ?? seedModels(p) : this.cache.get(ext)?.models;
    // шлюз не сообщает об усилии (z.ai: /v1/models без capabilities) — а Claude Code шлёт его любой модели
    // (output_config.effort, проверено подставным шлюзом 23.11): даём выбрать стандартные уровни
    if (!list || !this.effortFallback(ext)) return list;
    return list.map((m) => ((m.efforts ?? []).length === 0 ? { ...m, efforts: [...FALLBACK_EFFORTS] } : m));
  }

  /** Уровни усилия модели; null — неизвестно (списка нет или модели в нём нет) — тогда не проверяем. */
  effortsFor(name: string | undefined, model: string | undefined): EffortLevel[] | null {
    const list = this.models(name);
    if (!list) return null;
    const p = this.get(this.external(name));
    const picked = model ?? p?.model ?? 'default';
    // своя модель — усилия её базы
    const id = parseCustomModelId(picked)?.base ?? picked;
    const m = list.find((x) => x.id === id);
    if (!m) return null;
    return m.efforts ?? [];
  }

  /** Что уходит клиенту (event:hello / event:profiles / ack профиля). */
  info(name: string): ProfileInfoFrame | undefined {
    const p = this.get(name);
    if (!p) return undefined;
    const models = this.models(name);
    const long = effectiveLong(p);
    const source = this.modelsSource(name);
    const at = source === 'auto' ? this.cache.get(name)?.at : undefined;
    return {
      name: p.name,
      ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(models !== undefined ? { models } : {}),
      modelsSource: source,
      ...(at !== undefined ? { modelsAt: at } : {}),
      ...(source === 'auto' && this.cache.get(name)?.from ? { modelsFrom: this.cache.get(name)!.from! } : {}),
      ...(long.length ? { long } : {}),
      ...(p.custom?.length ? { custom: p.custom } : {}),
      ...(p.defaultEffort !== undefined ? { defaultEffort: p.defaultEffort } : {}),
      ultracode: this.ultracodeAllowed(name),
      delegate: this.delegateAllowed(name),
      nativeAgents: this.nativeAgentsAllowed(name),
      ...(p.maxOutput !== undefined ? { maxOutput: p.maxOutput } : {}),
      ...(p.maxOutputHigh !== undefined ? { maxOutputHigh: p.maxOutputHigh } : {}),
      tasks: this.tasksAllowed(name),
      effortFallback: this.effortFallback(name),
      ...(keyHint(p) !== undefined ? { keyHint: keyHint(p)! } : {}),
      keyEditable: keyEditable(p),
      ...(gatewayHost(p) ? { gatewayHost: gatewayHost(p)! } : {}),
      // вход: у подписок и у токена подписки (что видит Claude Code); у ключей API — нет
      ...(this.auth.has(name) && (!usesKey(p) || usesSubToken(p)) ? { auth: this.auth.get(name)! } : {}),
    };
  }

  /** Состояние входа аккаунта (для UI «не вошёл · Войти»). */
  setAuth(name: string, a: AuthInfo): void {
    this.auth.set(name, a);
  }

  /** Аккаунты, которым нужен вход в Claude Code (без ключа и не шлюз) — им проверяем `auth status`. */
  subscriptionNames(): string[] {
    // и скрытый аккаунт supervisor'а: вдруг в него вошли на сервере руками — тогда он появится
    return this.allWithBase().filter((p) => !usesKey(p) || usesSubToken(p)).map((p) => p.name);
  }

  /**
   * Новый аккаунт в profiles.json (атомарно, права файла сохраняются). Имя занято — ошибка.
   * Без файла (тесты/демо) — только в памяти.
   */
  create(profile: Profile): Profile {
    if (this.get(profile.name)) throw new Error(`аккаунт «${profile.name}» уже есть`);
    const entry = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
    if (this.file) {
      let raw: { version: number; profiles: Array<Record<string, unknown>> } & Record<string, unknown> = { version: 1, profiles: [] };
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { profiles?: unknown }).profiles)) {
          throw new Error('profiles.json не той формы — правьте руками');
        }
        raw = parsed as typeof raw;
      }
      raw.profiles.push(entry);
      writeAtomic(this.file, `${JSON.stringify(raw, null, 2)}
`);
    }
    const next = normalizeProfile(entry);
    if (!next) throw new Error(`аккаунт «${profile.name}» не прошёл проверку`);
    this.map.set(next.name, next);
    return next;
  }

  /** Свободное имя на основе желаемого: alex, alex-2, alex-3… */
  freeName(want: string): string {
    const base = slugify(want) || 'acc';
    if (!this.get(base)) return base;
    for (let i = 2; i < 1000; i += 1) if (!this.get(`${base}-${i}`)) return `${base}-${i}`;
    return `${base}-${Date.now().toString(36)}`;
  }

  infos(): ProfileInfoFrame[] {
    return this.publicList().map((p) => this.info(p.name)).filter((x): x is ProfileInfoFrame => x !== undefined);
  }

  /** auto-аккаунты без списка или со старым списком (обновить в фоне). */
  staleAuto(maxAgeMs: number, now = Date.now()): string[] {
    return this.publicList()
      .map((p) => p.name)
      .filter((n) => {
        if (this.modelsSource(n) !== 'auto') return false;
        const at = this.cache.get(n)?.at;
        return at === undefined || at < now - maxAgeMs;
      });
  }

  /** Список из Claude Code → кэш (отдельный файл; profiles.json с токенами не трогаем). */
  setAutoModels(name: string, models: ModelInfoFrame[], at = Date.now(), from?: ModelsFrom): void {
    this.cache.set(name, { at, models, ...(from ? { from } : {}) });
    if (!this.cacheFile) return;
    try {
      const out = { version: CACHE_VERSION, models: Object.fromEntries(this.cache) };
      writeAtomic(this.cacheFile, `${JSON.stringify(out, null, 2)}\n`);
    } catch { /* кэш — не главное: список останется в памяти до рестарта supervisor'а */ }
  }

  /**
   * Правка из UI. Пишется в profiles.json атомарно (tmp + rename); env, configDir и незнакомые поля
   * остаются как были. `default` без записи в файле — добавляется запись без env (настройки аккаунта supervisor'а).
   */
  update(name: string, patch: ProfilePatch): Profile {
    const current = this.get(name);
    if (!current) throw new Error(`профиля «${name}» нет`);
    if (patch.apiKey !== undefined && !keyEditable(current)) {
      throw new Error(name === BASE_PROFILE
        ? 'ключ аккаунта по умолчанию задаётся в настройках Claude Code на этой машине'
        : 'у этого аккаунта вход через подписку Claude — ключ здесь не нужен');
    }
    const apply = (r: Record<string, unknown>) => {
      if (patch.apiKey !== undefined) {
        const env = typeof r['env'] === 'object' && r['env'] !== null && !Array.isArray(r['env']) ? { ...(r['env'] as Record<string, string>) } : {};
        env[keyVar(env)] = patch.apiKey;
        r['env'] = env;
      }
      if (patch.displayName === null) delete r['displayName'];
      else if (patch.displayName !== undefined) r['displayName'] = patch.displayName;
      if (patch.models !== undefined) {
        r['models'] = patch.models;
        if (patch.modelsSource === undefined) r['modelsSource'] = 'manual';
      }
      if (patch.modelsSource !== undefined) r['modelsSource'] = patch.modelsSource;
      if (patch.model === null) delete r['model'];
      else if (patch.model !== undefined) r['model'] = patch.model;
      // пустой список храним: владелец выключил 1M у всех — настройки Claude Code больше не подставляются
      if (patch.long !== undefined) r['long'] = [...new Set(patch.long)];
      if (patch.custom !== undefined) {
        // id всегда из базы и окна — клиент мог прислать любой; повторы схлопываются
        const seen = new Set<string>();
        const list = patch.custom
          .map((c) => ({ ...c, id: customModelId(c.base, c.ctx) }))
          .filter((c) => !seen.has(c.id) && seen.add(c.id));
        if (list.length) r['custom'] = list;
        else delete r['custom'];
      }
      if (patch.defaultEffort === null) delete r['defaultEffort'];
      else if (patch.defaultEffort !== undefined) r['defaultEffort'] = patch.defaultEffort;
      if (patch.ultracode !== undefined) r['ultracode'] = patch.ultracode;
      if (patch.delegate !== undefined) r['delegate'] = patch.delegate;
      if (patch.nativeAgents !== undefined) r['nativeAgents'] = patch.nativeAgents;
      for (const k of ['maxOutput', 'maxOutputHigh'] as const) {
        if (patch[k] === null) delete r[k];
        else if (patch[k] !== undefined) r[k] = patch[k];
      }
      if (patch.tasks !== undefined) r['tasks'] = patch.tasks;
      if (patch.effortFallback !== undefined) r['effortFallback'] = patch.effortFallback;
    };

    let entry: Record<string, unknown>;
    if (this.file) {
      let raw: { version: number; profiles: Array<Record<string, unknown>> } & Record<string, unknown>;
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown; // битый файл — исключение: не затираем его
        if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { profiles?: unknown }).profiles)) {
          throw new Error('profiles.json не той формы — правьте руками');
        }
        raw = parsed as typeof raw;
      } else {
        raw = { version: 1, profiles: [] };
      }
      let found = raw.profiles.find((x) => typeof x === 'object' && x !== null && x['name'] === name);
      if (!found) {
        found = { name };
        raw.profiles.push(found);
      }
      apply(found);
      writeAtomic(this.file, `${JSON.stringify(raw, null, 2)}\n`);
      entry = found;
    } else {
      entry = { ...(this.map.get(name) ?? { name }) } as unknown as Record<string, unknown>;
      apply(entry);
    }
    const next = normalizeProfile(entry);
    if (!next) throw new Error(`профиль «${name}» после правки не прошёл проверку`);
    this.map.set(name, next);
    return next;
  }

  private syntheticBase(): Profile {
    return { name: BASE_PROFILE, displayName: BASE_LABEL, description: BASE_DESCRIPTION };
  }
}

/** Запись `default` без своего окружения — это настройки аккаунта supervisor'а, а не отдельный аккаунт. */
function isBaseLike(p: Profile): boolean {
  return p.env === undefined && p.configDir === undefined;
}

/**
 * ANTHROPIC_BASE_URL из settings.json Claude Code (блок env): Claude Code применяет его поверх окружения процесса.
 * Так настроен GLM у владельца локально (~/.claude/settings.json → api.z.ai) — по одному env supervisor'а этого не видно.
 */
export function settingsBaseUrl(configDir: string): string | undefined {
  return settingsEnv(configDir)['ANTHROPIC_BASE_URL'];
}

/** Строковые переменные блока env из settings.json Claude Code; нет файла или битый — пусто. */
export function settingsEnv(configDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { env?: Record<string, unknown> };
    const env = raw.env ?? {};
    return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string' && v !== '')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Модель по умолчанию из settings.json Claude Code (`"model": "glm-5.3[1m]"`); нет — undefined. */
export function settingsModel(configDir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { model?: unknown };
    return typeof raw.model === 'string' && raw.model !== '' ? raw.model : undefined;
  } catch {
    return undefined;
  }
}

/** Переменные, которыми шлюзу задают модели (z.ai: GLM вместо sonnet/opus/haiku). */
const MODEL_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'] as const;

/**
 * Модели с контекстом 1M. Задано у аккаунта (`long`, в том числе пустой список) — оно. Не задано — из настроек
 * Claude Code аккаунта: модели с [1m] в его модели, в `model` settings.json и в ANTHROPIC_*_MODEL (env и settings.json).
 * Так аккаунт supervisor'а у владельца (GLM на 1M в ~/.claude/settings.json) и выбранную в сессии glm-5.3 запускает с 1M.
 */
export function effectiveLong(p: Profile): string[] {
  if (p.long !== undefined) return p.long;
  const base = p.name === BASE_PROFILE && isBaseLike(p);
  const ownDir = base || p.configDir !== undefined || p.env?.['CLAUDE_CONFIG_DIR'] !== undefined;
  const env = accountEnv(p);
  const ids = [p.model, ownDir ? settingsModel(profileConfigDir(p)) : undefined, ...MODEL_VARS.map((k) => env[k])]
    .filter((x): x is string => typeof x === 'string' && /\[1m\]$/i.test(x))
    .map((x) => x.replace(/\[1m\]$/i, ''));
  return [...new Set(ids)];
}

/**
 * Стартовый ручной список, пока владелец не задал свой: модель профиля + модели из его env
 * и из settings.json его папки конфигурации (так у владельца локально настроен GLM). Усилия у шлюзов нет.
 */
export function seedModels(p: Profile): ModelInfoFrame[] {
  const base = p.name === BASE_PROFILE && isBaseLike(p);
  const ownDir = base || p.configDir !== undefined || p.env?.['CLAUDE_CONFIG_DIR'] !== undefined;
  const fromSettings = ownDir ? settingsEnv(profileConfigDir(p)) : {};
  const ids = [p.model, ...MODEL_VARS.map((k) => p.env?.[k]), ...MODEL_VARS.map((k) => fromSettings[k])]
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return [...new Set(ids)].map((id) => ({ id, efforts: [] }));
}

/**
 * Модели Claude Code для аккаунта через шлюз (z.ai): Claude Code подменяет на модели шлюза только opus/sonnet/haiku —
 * по ANTHROPIC_DEFAULT_*_MODEL (env профиля или settings.json его папки); остальные псевдонимы (fable и т. п.) уходят
 * в шлюз как есть (`claude-fable-5-1`) → z.ai «1211 Unknown Model». Проверено подставным шлюзом на Claude Code 2.1.319.
 * Оставляем только подменяемые (и «по умолчанию»), подпись — во что подменяется: «glm-5.3 · вместо Opus».
 */
export function gatewayModels(p: Profile, models: ModelInfoFrame[]): ModelInfoFrame[] {
  if (!isGateway(p)) return models;
  const base = p.name === BASE_PROFILE && isBaseLike(p);
  const ownDir = base || p.configDir !== undefined || p.env?.['CLAUDE_CONFIG_DIR'] !== undefined;
  const env = { ...(ownDir ? settingsEnv(profileConfigDir(p)) : {}), ...(p.env ?? {}) };
  const slot: Record<string, string | undefined> = {
    opus: env['ANTHROPIC_DEFAULT_OPUS_MODEL'], sonnet: env['ANTHROPIC_DEFAULT_SONNET_MODEL'], haiku: env['ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  };
  const out: ModelInfoFrame[] = [];
  for (const m of models) {
    const id = m.id.toLowerCase();
    if (id === 'default') { out.push({ ...m, label: 'По умолчанию' }); continue; }
    const target = slot[id];
    if (target) {
      const shown = target.replace(/\[1m\]$/i, ' · 1M');
      out.push({ ...m, label: shown, description: `вместо ${m.label ?? m.id}` });
      continue;
    }
    // не псевдоним Claude (модель самого шлюза, например из discovery) — оставляем
    if (!/^(opus|sonnet|haiku|fable|claude)/i.test(id)) out.push(m);
  }
  return out;
}

/**
 * Окружение, с которым Claude Code аккаунта ходит к провайдеру: процесс supervisor'а (только у его аккаунта),
 * блок env из settings.json папки (у аккаунта supervisor'а и профилей со своей папкой), env профиля.
 * Нужно списку моделей у провайдера (адрес и ключ); наружу не уходит.
 */
export function accountEnv(p: Profile): Record<string, string> {
  const base = p.name === BASE_PROFILE && isBaseLike(p);
  const ownDir = base || p.configDir !== undefined || p.env?.['CLAUDE_CONFIG_DIR'] !== undefined;
  return { ...(base ? inheritedEnv() : {}), ...(ownDir ? settingsEnv(profileConfigDir(p)) : {}), ...(p.env ?? {}) };
}

/** Профиль ходит не к Anthropic (z.ai и т. п.): Claude Code отдаёт для него чужой список моделей, ultracode нет. */
export function isGateway(p: Profile): boolean {
  const base = p.name === BASE_PROFILE && isBaseLike(p);
  // settings.json смотрим у аккаунта supervisor'а и у профиля со своей папкой конфигурации:
  // так шлюз виден там, где он реально настроен, а профили с явным env решают сами
  const ownDir = base || p.configDir !== undefined || p.env?.['CLAUDE_CONFIG_DIR'] !== undefined;
  const url = p.env?.['ANTHROPIC_BASE_URL']
    ?? (ownDir ? settingsBaseUrl(profileConfigDir(p)) : undefined)
    ?? (base ? process.env['ANTHROPIC_BASE_URL'] : undefined);
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return !(host === 'anthropic.com' || host.endsWith('.anthropic.com'));
  } catch {
    return true;
  }
}

/**
 * profiles.json правится руками: поле не той формы ("model": null, "displayName": 5) иначе
 * доезжает до event:hello, кадр не проходит схему — и UI не может подключиться вовсе.
 */
function normalizeProfile(raw: unknown): Profile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['name'] !== 'string' || r['name'] === '') return null;
  const str = (k: string) => (typeof r[k] === 'string' ? { [k]: r[k] as string } : {});
  const env = r['env'];
  const envOk = typeof env === 'object' && env !== null && !Array.isArray(env)
    ? Object.fromEntries(Object.entries(env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    : undefined;
  const models = Array.isArray(r['models'])
    ? (r['models'] as unknown[]).map((m) => modelInfoSchema.safeParse(m)).filter((x) => x.success).map((x) => x.data!)
    : undefined;
  const source = r['modelsSource'] === 'auto' || r['modelsSource'] === 'manual' ? r['modelsSource'] : undefined;
  const long = Array.isArray(r['long']) ? (r['long'] as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '') : undefined;
  const custom = Array.isArray(r['custom'])
    ? (r['custom'] as unknown[]).map((c) => customModelSchema.safeParse(c)).filter((x) => x.success).map((x) => x.data!)
    : undefined;
  const effort = EffortLevelSchema.safeParse(r['defaultEffort']);
  return {
    name: r['name'],
    ...str('displayName'), ...str('description'), ...str('model'), ...str('configDir'),
    ...(envOk !== undefined ? { env: envOk } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(source !== undefined ? { modelsSource: source } : {}),
    ...(long !== undefined ? { long } : {}),
    ...(custom?.length ? { custom } : {}),
    ...(effort.success ? { defaultEffort: effort.data } : {}),
    ...(typeof r['ultracode'] === 'boolean' ? { ultracode: r['ultracode'] } : {}),
    ...(typeof r['delegate'] === 'boolean' ? { delegate: r['delegate'] } : {}),
    ...(typeof r['nativeAgents'] === 'boolean' ? { nativeAgents: r['nativeAgents'] } : {}),
    ...(tokens(r['maxOutput']) !== undefined ? { maxOutput: tokens(r['maxOutput'])! } : {}),
    ...(tokens(r['maxOutputHigh']) !== undefined ? { maxOutputHigh: tokens(r['maxOutputHigh'])! } : {}),
    ...(typeof r['tasks'] === 'boolean' ? { tasks: r['tasks'] } : {}),
    ...(typeof r['effortFallback'] === 'boolean' ? { effortFallback: r['effortFallback'] } : {}),
  };
}

/** Лимит токенов из файла: целое 1000…1 000 000, иначе нет. */
function tokens(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1000 && v <= 1_000_000 ? v : undefined;
}

/** Уровни усилия по умолчанию — моделям, о которых шлюз ничего не сообщает (Claude Code всё равно шлёт усилие). */
export const FALLBACK_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Усилие «высокое» для лимита ответа: xhigh и выше. */
export const isHighEffort = (e: EffortLevel | undefined | null): boolean => e === 'xhigh' || e === 'max';

function readCache(file: string): Map<string, CacheEntry> {
  const out = new Map<string, CacheEntry>();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; models?: Record<string, { at?: unknown; models?: unknown; from?: unknown }> };
    if (raw.version !== CACHE_VERSION || typeof raw.models !== 'object' || raw.models === null) return out;
    for (const [name, e] of Object.entries(raw.models)) {
      if (typeof e?.at !== 'number' || !Array.isArray(e.models)) continue;
      const models = e.models.map((m) => modelInfoSchema.safeParse(m)).filter((x) => x.success).map((x) => x.data!);
      const from = e.from === 'provider' || e.from === 'claude-code' ? e.from : undefined;
      out.set(name, { at: e.at, models, ...(from ? { from } : {}) });
    }
  } catch { /* нет кэша — спросим у провайдера / Claude Code */ }
  return out;
}

/** Запись через временный файл: обрыв посередине не оставляет полупустой profiles.json; права файла сохраняются. */
function writeAtomic(file: string, text: string): void {
  let mode = 0o600; // в profiles.json токены
  try { mode = statSync(file).mode & 0o777; } catch { /* новый файл */ }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode });
  renameSync(tmp, file);
}

/** Окружение процесса supervisor'а без undefined-значений (форма Options.env). */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Слить профиль в параметры фабрики SDK: env + configDir + модель по умолчанию.
 * ВАЖНО: Options.env SDK ЗАМЕНЯЕТ окружение субпроцесса целиком (не мёржит с process.env) —
 * поэтому наследуем окружение supervisor'а (PATH, HOME, …) и кладём профиль поверх.
 */
export function applyProfile(
  p: Profile | undefined,
  base: { model?: string; env?: Record<string, string> },
): { model?: string; env?: Record<string, string> } {
  if (!p) return base;
  return {
    ...(base.model !== undefined || p.model !== undefined ? { model: base.model ?? p.model } : {}),
    env: {
      ...inheritedEnv(),
      ...(base.env ?? {}),
      ...(p.env ?? {}),
      ...(p.configDir !== undefined ? { CLAUDE_CONFIG_DIR: p.configDir } : {}),
    },
  };
}

/**
 * Папка Claude Code, заданная явно (у аккаунта или у самого supervisor'а). Нет — аккаунт живёт там же, где обычный
 * Claude Code пользователя: CLAUDE_CONFIG_DIR детям НЕ ставим, иначе глобальные настройки (MCP, вход) ищутся в
 * ~/.claude/.claude.json вместо ~/.claude.json и «пропадают».
 */
export function explicitConfigDir(p: Profile | undefined): string | undefined {
  return p?.configDir ?? p?.env?.['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'];
}

/** Каталог конфигурации claude, под которым живёт профиль (там его projects/ — транскрипты). */
export function profileConfigDir(p: Profile | undefined): string {
  return p?.configDir
    ?? p?.env?.['CLAUDE_CONFIG_DIR']
    ?? process.env['CLAUDE_CONFIG_DIR']
    ?? join(homedir(), '.claude');
}

/** Аккаунт на ключе API или через шлюз — входа в Claude Code ему не нужно. */
export function usesKey(p: Profile): boolean {
  return isGateway(p) || p.env?.['ANTHROPIC_AUTH_TOKEN'] !== undefined || p.env?.['ANTHROPIC_API_KEY'] !== undefined || usesSubToken(p);
}

/** Слаг имени аккаунта: латиница, цифры, - и _; из почты — часть до @. */
export function slugify(s: string): string {
  const local = s.includes('@') ? s.slice(0, s.indexOf('@')) : s;
  return local.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32);
}

/** Шаблоны аккаунтов на ключе API (окно «Добавить аккаунт» → «Ключ API»). */
export interface KeyTemplateDef {
  /** адрес API; нет — Anthropic по умолчанию */
  baseUrl?: string;
  /** куда класть ключ: x-api-key (Anthropic), Bearer (шлюзы) или токен подписки Claude */
  keyVar: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_OAUTH_TOKEN';
  model?: string;
  models?: ModelInfoFrame[];
  modelsSource: 'auto' | 'manual';
  /** модели с контекстом 1M сразу (у шлюза известно из его документации) */
  long?: string[];
  ultracode: boolean;
  /** модель для проверки ключа мини-запросом */
  checkModel: string;
  description: string;
}

export type KeyTemplateId = 'anthropic' | 'zai' | 'custom' | 'claude-token';

export const KEY_TEMPLATES: Record<KeyTemplateId, KeyTemplateDef> = {
  anthropic: {
    keyVar: 'ANTHROPIC_API_KEY', modelsSource: 'auto', ultracode: true,
    checkModel: 'claude-haiku-5-5', description: 'ключ Anthropic API',
  },
  zai: {
    baseUrl: 'https://api.z.ai/api/anthropic', keyVar: 'ANTHROPIC_AUTH_TOKEN',
    // список — у z.ai (/v1/models); по docs.z.ai/devpack/latest-model (2026-11) у GLM 5.3 окно 1M — включено сразу
    model: 'glm-5.3', long: ['glm-5.3', 'glm-5.3-flash'],
    modelsSource: 'auto', ultracode: false, checkModel: 'glm-5.3-flash', description: 'z.ai GLM · кодинг-план',
  },
  custom: {
    keyVar: 'ANTHROPIC_AUTH_TOKEN', modelsSource: 'auto', ultracode: false,
    checkModel: 'claude-haiku-5-5', description: 'свой адрес (совместимый с Anthropic API)',
  },
  // токен подписки работает только внутри Claude Code: проверка — через сам Claude Code (checkToken), не мини-запросом
  'claude-token': {
    keyVar: 'CLAUDE_CODE_OAUTH_TOKEN', modelsSource: 'auto', ultracode: true,
    checkModel: 'claude-haiku-5-5', description: 'подписка Claude · токен',
  },
};

/** Профиль аккаунта на ключе по шаблону. */
export function profileFromTemplate(
  p: { name: string; displayName?: string; template: KeyTemplateId; baseUrl?: string; apiKey: string; models?: ModelInfoFrame[]; configDir?: string },
): Profile {
  const t = KEY_TEMPLATES[p.template];
  const baseUrl = p.template === 'custom' ? p.baseUrl : t.baseUrl;
  if (p.template === 'custom' && !baseUrl) throw new Error('для «Свой адрес» нужен адрес API');
  const models = p.models ?? t.models;
  return {
    name: p.name,
    ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
    description: t.description,
    ...(t.model !== undefined ? { model: t.model } : models?.[0] ? { model: models[0].id } : {}),
    env: { ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}), [t.keyVar]: p.apiKey },
    ...(p.configDir !== undefined ? { configDir: p.configDir } : {}),
    ...(models !== undefined ? { models } : {}),
    modelsSource: models !== undefined ? 'manual' : t.modelsSource,
    ...(t.long ? { long: t.long } : {}),
    ultracode: t.ultracode,
  };
}
