// Сборка supervisor'а: менеджер сессий + WSS + SDK-фабрики + профили (мультиакк) + пул + персистентность.

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SessionManager, type SpawnInfo } from './session/manager.js';
import { fetchSupportedModels, sdkFactory, thinkingOption } from './session/sdk.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { StateStore } from './state-store.js';
import { ThinkingStore } from './thinkingStore.js';
import { createDelegateServerConfig, DELEGATE_SERVER, type DelegateDeps } from './delegate.js';
import { TASK_TOOLS } from './session/tasks.js';
import { WssServer } from './wss.js';
import { RemoteBrowserManager, chromiumLauncher, findChromium } from './panels/rbrowser.js';
import { accountEnv, applyProfile, ProfileRegistry } from './profiles.js';
import { fetchProviderModels, providerAccess } from './providerModels.js';
import { accountsRoot } from './accounts.js';
import { ProjectStore } from './projects.js';
import { PrewarmPool, ProfilePools, poolProfiles } from './pool.js';

export interface SupervisorOptions {
  port: number;
  host?: string;
  model?: string;
  permissionMode?: 'acceptEdits' | 'default' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
  cwd?: string;
  ringCapacity?: number;
  /** файл реестра сессий; по умолчанию ~/.perimeter/state.json */
  stateFile?: string;
  /** файл профилей аккаунтов (мультиакк); по умолчанию ~/.perimeter/profiles.json */
  profilesFile?: string;
  /** файл проектов; по умолчанию ~/.perimeter/projects.json */
  projectsFile?: string;
  /** пул тёплых процессов: 0 = выкл; дефолт из env (для VPS рекомендуем 1-2, каждый ~250 МБ) */
  poolSize?: number;
  /**
   * тёплые процессы аккаунтов из profiles.json (PERIMETER_POOL_PROFILES): «all» или список через запятую;
   * по умолчанию — только аккаунт supervisor'а (сессии без профиля), как раньше
   */
  poolProfiles?: string;
  /** сколько тёплых процессов на профиль (PERIMETER_POOL_PROFILE_SIZE, по умолчанию 1) */
  poolProfileSize?: number;
  /** скашивание простоя: мс без активности до остановки процесса (0 = выкл; дефолт из env) */
  idleTimeoutMs?: number;
  /** спрашивать у Claude Code списки моделей auto-аккаунтов в фоне после старта (по умолчанию да) */
  refreshModels?: boolean;
  /**
   * профиль браузера на сервере (входы на сайты переживают закрытие): по умолчанию ~/.perimeter/rb-profile,
   * PERIMETER_RB_PROFILE — другой путь, «temp» — временный профиль на каждый запуск
   */
  rbProfileDir?: string;
}

export async function startSupervisor(opts: SupervisorOptions): Promise<{ manager: SessionManager; server: WssServer; port: number; stop: () => Promise<void>; pool: ProfilePools | null }> {
  const manager = new SessionManager(opts.idleTimeoutMs ?? 0);
  const stateFile = opts.stateFile ?? join(homedir(), '.perimeter', 'state.json');
  const store = new StateStore(stateFile);
  // текст размышлений — рядом с реестром (транскрипт Claude Code хранит thinking без текста)
  const thinking = new ThinkingStore(join(dirname(stateFile), 'thinking.log'));
  manager.thinkingSink = (signature, text) => thinking.put(signature, text);

  const base = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
  };
  const profilesFile = opts.profilesFile ?? join(homedir(), '.perimeter', 'profiles.json');
  const profiles = ProfileRegistry.load(profilesFile);
  const projects = new ProjectStore(opts.projectsFile ?? join(homedir(), '.perimeter', 'projects.json'));

  // параметры субпроцесса: сессионные настройки поверх профиля аккаунта (мультиакк)
  const buildOptions = (sess: SpawnInfo) => {
    // сессия без профиля — аккаунт supervisor'а: его модель по умолчанию (правится из UI) важнее PERIMETER_MODEL
    // у аккаунта из profiles.json — его модель по умолчанию (applyProfile); PERIMETER_MODEL — только аккаунту supervisor'а:
    // иначе GLM из службы уходил в сессии подписки Claude (ошибка «модель не найдена», просьба войти)
    const baseModel = sess.profile === undefined ? profiles.get(profiles.baseName())?.model ?? base.model : undefined;
    const picked = applyProfile(profiles.get(sess.profile), { ...(baseModel !== undefined || sess.model !== undefined ? { model: sess.model ?? baseModel } : {}) });
    // включён 1M у модели аккаунта — Claude Code получает `<id>[1m]`; своя модель — базу и окно контекста
    // окно автокомпакта: сессии → своей модели → умолчание аккаунта (Claude Code берёт его при старте процесса)
    const launch = profiles.launchSession(sess.profile, picked.model, sess.compactWindow);
    const withProfile = {
      ...picked,
      ...(launch.model !== undefined ? { model: launch.model } : {}),
      ...(launch.window !== undefined ? { window: launch.window } : {}),
    };
    const ultracodeKeyword = profiles.ultracodeAllowed(sess.profile);
    // лимит ответа аккаунта при усилии сессии (на ходу меняется вместе с усилием — wss → setFlags)
    const outputTokens = profiles.outputTokens(sess.profile, sess.effort);
    return {
      ...withProfile,
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(base.cwd !== undefined || sess.cwd !== undefined ? { cwd: sess.cwd ?? base.cwd } : {}),
      ...(sess.permissionMode !== undefined ? { permissionMode: sess.permissionMode as typeof base.permissionMode }
        : base.permissionMode !== undefined ? { permissionMode: base.permissionMode } : {}),
      ...(sess.effort !== undefined ? { effort: sess.effort } : {}),
      ...(sess.ultracode === true && ultracodeKeyword ? { ultracode: true } : {}),
      ...(!ultracodeKeyword ? { ultracodeKeyword: false } : {}),
    };
  };

  // Инструменты аккаунта — фиксируются на старте процесса (и на prewarm тёплого): холодный путь и пул одинаково.
  // - нативные Task/Agent внутрипроцессные (в дереве сессий не видны, чужих аккаунтов не умеют) — прячем у шлюзов
  //   (настройка nativeAgents, по умолчанию выкл: моделей Anthropic там нет);
  // - список задач (как в Claude Code Desktop): в режиме SDK Claude Code даёт TaskCreate/TaskUpdate… только старым
  //   моделям; явное перечисление в allowedTools включает их любой (проверено подставным шлюзом 23.11; env
  //   CLAUDE_CODE_ENABLE_TODO_TOOLS — нет) и заодно не спрашивает разрешения — они ничего не меняют вне сессии.
  // режим размышлений (summarized) — тоже на старте процесса: тёплому — в prewarm (thinkingOption, sdk.ts)
  const thinkingDisplay = thinkingOption();
  const prewarmBase = (profile: string | undefined): Options => ({ ...toolOptions(profile), ...(thinkingDisplay !== undefined ? { thinking: thinkingDisplay } : {}) });
  const toolOptions = (profile: string | undefined): { allowedTools?: string[]; disallowedTools?: string[] } => ({
    ...(profiles.tasksAllowed(profile) ? { allowedTools: [...TASK_TOOLS] } : {}),
    ...(!profiles.nativeAgentsAllowed(profile) ? { disallowedTools: ['Task', 'Agent'] } : {}),
  });

  // фабрика с учётом делегирования: воркер (parentSessionId) — read-only и без инструмента;
  // родителю, чьему профилю разрешён delegate — встроенный MCP-сервер (in-process, только этому query:
  // Options.mcpServers, к .claude.json аккаунта не пишется). id сессии известен заранее —
  // хендлер инструмента знает родителя, не доверяя модели.
  const factoryFor = (
    sess: SpawnInfo & { parentSessionId?: string; editable?: boolean },
    sessionId: string,
    extra: { resume?: string; forkSession?: boolean } = {},
  ) => {
    const delegateOn = sess.parentSessionId === undefined && profiles.delegateAllowed(sess.profile);
    return sdkFactory({
      ...buildOptions(sess),
      ...extra,
      // воркер без worktree — read-only; worktree-воркер правит свою копию свободно
      ...(sess.parentSessionId !== undefined && sess.editable !== true ? { readonly: true } : {}),
      ...toolOptions(sess.profile),
      ...(delegateOn
        ? { mcpServers: { [DELEGATE_SERVER]: createDelegateServerConfig(delegateDeps, { callerId: sessionId }) } }
        : {}),
    });
  };

  // resume: родительство берём из реестра (SpawnInfo его не хранит — форк родителем не становится),
  // иначе после idle-reap/respawn инструмент делегирования молча пропадёт из сессии
  const resumeFactory = (sid: string, info: SpawnInfo & { claudeSessionId?: string }) => {
    const parent = manager.get(sid)?.parentSessionId;
    return factoryFor(
      { ...info, ...(parent !== undefined ? { parentSessionId: parent } : {}) },
      sid,
      // resume по настоящему id сессии claude; если init не успели получить — резюмировать нечем
      { ...(info.claudeSessionId !== undefined ? { resume: info.claudeSessionId } : {}) },
    );
  };

  const delegateDeps: DelegateDeps = {
    manager,
    profiles,
    factoryFor: (sess, sessionId) => factoryFor(sess, sessionId),
    resumeFactory: (sid, info) => resumeFactory(sid, info),
  }; // git для worktree — настоящий (realGit по умолчанию внутри delegate)

  // форк: копия истории до текущего момента в новую сессию (SDK resume + forkSession)
  const forkFactory: NonNullable<import('./session/manager.js').SessionCreateOptions['forkFactory']> =
    (claudeSessionId, info) => sdkFactory({
      ...buildOptions(info),
      resume: claudeSessionId,
      forkSession: true,
    });

  // инвариант 2: после kill -9 реестр восстанавливается, сессии resumable (и форкаемые)
  const restored = store.load();
  if (restored.length > 0) manager.restore(restored, resumeFactory, forkFactory);

  // пул тёплых процессов по аккаунтам: у профиля свой процесс (env фиксируется на prewarm), fill в фоне;
  // claim получает те же дефолты модели/режима/cwd, что и холодный путь (buildOptions)
  const poolSize = opts.poolSize ?? 0;
  const perProfile = opts.poolProfileSize ?? 1;
  const warmFor = poolProfiles(opts.poolProfiles, profiles.list().map((p) => p.name), poolSize);
  const pool = warmFor.length > 0
    ? new ProfilePools((profile) => {
        // инструменты аккаунта (задачи, нативные субагенты) — те же, что у холодного пути: фиксируются на prewarm
        if (profile === undefined) return poolSize > 0 ? new PrewarmPool(poolSize, prewarmBase(undefined), { defaults: base }) : null;
        if (perProfile <= 0 || !profiles.get(profile)) return null;
        // env профиля (z.ai/свой CLAUDE_CONFIG_DIR) — как у холодного пути через applyProfile
        const env = applyProfile(profiles.get(profile), {}).env;
        return new PrewarmPool(perProfile, { ...(env !== undefined ? { env } : {}), ...prewarmBase(profile) }, { defaults: base });
      }, warmFor)
    : null;
  pool?.fill();

  const rbProfile = opts.rbProfileDir ?? process.env['PERIMETER_RB_PROFILE'] ?? join(homedir(), '.perimeter', 'rb-profile');
  const rbrowser = new RemoteBrowserManager({ launcher: chromiumLauncher(findChromium(), rbProfile === 'temp' ? {} : { profileDir: rbProfile }) });

  const server = new WssServer(manager, {
    ensureDirs: true,
    rbrowser,
    port: opts.port,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.ringCapacity !== undefined ? { ringCapacity: opts.ringCapacity } : {}),
    thinking,
    profiles,
    projects,
    accounts: { root: accountsRoot(profilesFile), mcpSharedFile: join(dirname(profilesFile), 'mcp-shared.json') },
    ...(pool ? { pool } : {}),
    sessionFactory: (sess, id) => factoryFor(sess, id),
    resumeFactory,
    forkFactory,
    // модели аккаунта: у провайдера (/v1/models — настоящие id); нет ключа или провайдер не ответил — у Claude Code
    // (временный процесс с env профиля, без сообщения, см. fetchSupportedModels)
    modelsFetcher: async (name) => {
      const p = profiles.get(name);
      const access = p ? providerAccess(accountEnv(p)) : null;
      if (access) {
        try {
          return { models: await fetchProviderModels(access), from: 'provider' as const };
        } catch (err) {
          console.log(`[models] ${name}: у провайдера список не получен (${String((err as Error)?.message ?? err)}) — беру у Claude Code`);
        }
      }
      const env = applyProfile(profiles.get(profiles.internal(name)), {}).env;
      const models = await fetchSupportedModels({ ...(env !== undefined ? { env } : {}), ...(base.cwd !== undefined ? { cwd: base.cwd } : {}) });
      return { models, from: 'claude-code' as const };
    },
  });
  const port = await server.start();
  // списки моделей auto-аккаунтов: нет или устарели — спросим в фоне (клиенты получат event:profiles)
  if (opts.refreshModels !== false) void server.refreshStaleModels();
  // вход аккаунтов-подписок — для «не вошёл · Войти» в настройках
  if (opts.refreshModels !== false) void server.refreshAuth();

  const persist = () => {
    try { store.save(manager.snapshot()); } catch { /* запись реестра не должна ронять сервер */ }
  };
  // флеш на каждом кадре с коалесценцией 200 мс: окно потери персиста при kill -9 минимально
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  manager.setPersistHook(() => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      persist();
    }, 200);
  });
  const safetyTimer = setInterval(persist, 5000);

  const stop = async () => {
    if (flushTimer) clearTimeout(flushTimer);
    clearInterval(safetyTimer);
    manager.setPersistHook(null);
    persist();
    pool?.stop();
    await server.stop();
  };
  return { manager, server, port, stop, pool };
}
