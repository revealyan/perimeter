import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { NewSession } from './components/NewSession';
import { NewProjectDialog } from './components/NewProjectDialog';
import { SessionHeader } from './components/SessionHeader';
import { SettingsDialog } from './components/SettingsDialog';
import { SyncDialog } from './components/SyncDialog';
import { TransferDialog } from './components/TransferDialog';
import { Feed } from './components/Feed';
import { Composer } from './components/Composer';
import { TaskStrip, showTaskStrip } from './components/TaskStrip';
import { EffortPicker, ModelPicker, ModePicker, UltracodeToggle } from './components/SessionPickers';
import { StatusBar } from './components/StatusBar';
import { Panel } from './components/Panel';
import { PendingBar } from './components/Ask';
import { TooltipLayer } from './components/ui';
import { ClientSet, envLabel, envShort, loadActiveEnv, type EnvId } from './supervisor';
import { undoTransfer } from './lib/transferModel';
import { LOCAL, connections } from './connections';
import { AUTO_POLL_MS, ports } from './ports';
import { answerHotkey, clampRect, normalizePanelState, panelHotkey, toggleTab, type PanelState, type PanelTab } from './lib/panelLayout';
import { extractPlan, fileChanges } from './lib/feedModel';
import { groupOf } from './lib/sessionGroups';
import { afterPaint, requestComposerInsert } from './composeBus';
import { COMPOSER_STYLE_KEY, draftKey, parseComposerStyle, type ComposerStyle } from './lib/composerModel';
import { localSupBusy } from './lib/localSup';
import { serverUpdateText } from './lib/updateModel';
import { isCold, sendHold } from './lib/wake';
import { FOREIGN_SCAN_MS, loadSeen, newForeign, saveSeen } from './lib/foreignScan';
import { notifications } from './notifications';
import { useUpdate } from './lib/useUpdate';
import { SessionSearch } from './components/SessionSearch';

const PANEL_KEY = 'perimeter:panel';

function loadPanel(): PanelState {
  try { return normalizePanelState(JSON.parse(localStorage.getItem(PANEL_KEY) ?? 'null')); } catch { return normalizePanelState(null); }
}

/** Фокус в поле ввода — одиночные клавиши (Y/N/A) не перехватываем. */
function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

export default function App() {
  const [, setTick] = useState(0);
  /** черновик новой сессии в центре (как в Claude Code Desktop): среда и проект, откуда пришли */
  const [draft, setDraft] = useState<{ env: EnvId; projectId?: string | null } | null>(null);
  /** диалог «Новый проект»: для какой среды и что сделать с созданным (выбрать в черновике) */
  const [newProject, setNewProject] = useState<{ env: EnvId; done?: (projectId: string) => void } | null>(null);
  /** настройки открыты: false — закрыты; true — «Общие»; id подключения или 'add' — сразу на нём */
  const [showSettings, setShowSettings] = useState<boolean | EnvId | 'add'>(false);
  /** синк проектов открыт для этой среды */
  const [syncEnv, setSyncEnv] = useState<EnvId | null>(null);
  /** перенос сессии (T-ряд): диалог открыт для этой сессии; done — тост с отменой */
  const [transfer, setTransfer] = useState<{ env: EnvId; sid: string } | null>(null);
  const [localSup, setLocalSup] = useState('');
  const [panel, setPanelState] = useState<PanelState>(loadPanel);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  /** вид поля ввода: карточка или панель с ручкой (настройки) */
  const [composerStyle, setComposerStyleState] = useState<ComposerStyle>(() => parseComposerStyle(localStorage.getItem(COMPOSER_STYLE_KEY)));
  const setComposerStyle = (v: ComposerStyle) => {
    localStorage.setItem(COMPOSER_STYLE_KEY, v);
    setComposerStyleState(v);
  };
  const workRef = useRef<HTMLDivElement | null>(null);

  // Подключения (как в Happy): «Этот компьютер» есть всегда, VPS — подключаемые, их может быть несколько.
  // По клиенту на подключение, все подключены сразу; центр показывает среду выбранной сессии.
  const [, setConnTick] = useState(0);
  useEffect(() => { connections.start(); return connections.subscribe(() => setConnTick((t) => t + 1)); }, []);
  // автопроброс портов: новые dev-серверы на VPS — сюда, как в VS Code Remote SSH (только в приложении)
  useEffect(() => {
    ports.start();
    if (!ports.available) return;
    const t = setInterval(() => {
      for (const c of connections.list) if (c.enabled && c.kind === 'vps') void ports.autoPass(c.id, clientsRef.current!.get(c.id));
    }, AUTO_POLL_MS);
    return () => clearInterval(t);
  }, []);
  const enabledConns = connections.list.filter((c) => c.enabled);
  // в списке: VPS-подключения по порядку, «Этот компьютер» — последним
  const enabled: EnvId[] = [...enabledConns.filter((c) => c.kind === 'vps'), ...enabledConns.filter((c) => c.kind === 'local')].map((c) => c.id);
  const [activeEnvPref, setActiveEnvPref] = useState<EnvId>(loadActiveEnv);
  const activeEnv: EnvId = enabled.includes(activeEnvPref) ? activeEnvPref : (enabled[0] ?? LOCAL);
  const clientsRef = useRef<ClientSet | null>(null);
  if (!clientsRef.current) {
    const set = new ClientSet();
    set.onCreate = (c) => {
      // проекты одной среды обновились — у остальных пересчитываются предложения синка (пары локаль ↔ VPS)
      c.onProjectsChanged = () => { for (const o of set.all()) if (o !== c) o.recomputeSync(); };
      c.subscribe(() => setTick((t) => t + 1));
    };
    clientsRef.current = set;
  }
  const clients = clientsRef.current;
  // открыт черновик новой сессии — панель и баннеры работают с его подключением, а не с последним активным
  const [draftEnv, setDraftEnv] = useState<EnvId | null>(null);
  const panelEnv: EnvId = draft ? (draftEnv && enabled.includes(draftEnv) ? draftEnv : draft.env) : activeEnv;
  const client = clients.get(panelEnv);
  // для отладки в dev-сборке: хранилище активной среды и все подключения доступны из консоли
  if (import.meta.env.DEV) Object.assign(window, { __perimeter: client, __perimeterEnvs: clients, __connections: connections });

  const setActiveEnv = (env: EnvId) => {
    setActiveEnvPref(env);
    localStorage.setItem('perimeter:env', env);
  };
  // стек последних сессий для Ctrl+Tab (ротация: переключаемся на предыдущую, она становится первой)
  const recentRef = useRef<Array<{ env: EnvId; sid: string }>>([]);
  const selectSession = (env: EnvId, id: string) => {
    setDraft(null); // открыли сессию — черновик новой закрывается
    recentRef.current = [{ env, sid: id }, ...recentRef.current.filter((x) => !(x.env === env && x.sid === id))].slice(0, 12);
    clients.get(env).select(id);
    setActiveEnv(env);
  };
  /** К следующей ждущей сессии (циклично по всем средам); null — ждущих нет. */
  const jumpToWaiting = (): boolean => {
    const waiting: Array<{ env: EnvId; sid: string; at: number }> = [];
    for (const env of enabled) {
      for (const s of clients.get(env).sessions.values()) {
        if (!s.archived && groupOf(s) === 'waiting') waiting.push({ env, sid: s.id, at: s.lastActivity });
      }
    }
    if (waiting.length === 0) return false;
    waiting.sort((a, b) => b.at - a.at);
    const cur = waiting.findIndex((w) => w.env === activeEnvRef.current && clients.get(w.env).activeId === w.sid);
    const next = waiting[(cur + 1) % waiting.length]!;
    selectSession(next.env, next.sid);
    return true;
  };
  const openCreate = (env?: EnvId, projectId?: string | null) => {
    setDraft({ env: env ?? activeEnv, ...(projectId !== undefined ? { projectId } : {}) });
  };
  const activeEnvRef = useRef(activeEnv);
  activeEnvRef.current = activeEnv;

  const setPanel = useCallback((fn: (s: PanelState) => PanelState) => setPanelState(fn), []);

  // состояние панели — в localStorage (с небольшой задержкой: ресайз шлёт десятки обновлений)
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(PANEL_KEY, JSON.stringify(panel)), 150);
    return () => clearTimeout(t);
  }, [panel]);

  // окно уменьшили — плавающая панель не уезжает за край
  useEffect(() => {
    const on = () => setPanel((s) => (s.dock === 'floating' ? { ...s, float: clampRect(s.float, { w: window.innerWidth, h: window.innerHeight }) } : s));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [setPanel]);

  // тема из настроек
  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', localStorage.getItem('perimeter:theme') === 'light');
  }, []);

  // ошибки команд (раньше — тосты поверх чата) → журнал уведомлений
  const errKey = enabled.map((e) => `${e}:${clients.get(e).lastError}`).join('|');
  useEffect(() => {
    for (const e of enabled) {
      const c = clients.get(e);
      if (!c.lastError) continue;
      notifications.push({ level: 'err', env: e, title: c.lastError });
      c.dismissError();
    }
  }, [errKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // связь: оборвалась (после того как была) / восстановилась — одной записью на среду
  const connKey = enabled.map((e) => `${e}:${clients.get(e).status}`).join('|');
  const wasLive = useRef(new Map<EnvId, boolean>());
  useEffect(() => {
    for (const e of enabled) {
      const live = clients.get(e).status === 'live';
      const was = wasLive.current.get(e);
      if (was === true && !live) notifications.push({ level: 'warn', env: e, key: `conn:${e}`, title: 'связь оборвалась — переподключаюсь', text: 'сессии на сервере продолжают работать' });
      else if (was === false && live && notifications.list.find((n) => n.key === `conn:${e}`)?.level === 'warn') notifications.push({ level: 'ok', env: e, key: `conn:${e}`, title: 'связь восстановилась' });
      if (live || was !== undefined) wasLive.current.set(e, live);
    }
  }, [connKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // обновление приложения скачано — в журнал с «перезапустить» (кнопка в строке статуса тоже есть)
  const appUpd = useUpdate();
  useEffect(() => {
    if (appUpd?.state === 'ready') notifications.push({ level: 'ok', key: 'app-update', title: `обновление ${appUpd.version ?? ''} скачано`, text: 'поставится тихо при перезапуске или выходе', action: { label: 'перезапустить', run: () => void window.perimeterIPC?.updateInstall?.() } });
    else if (appUpd?.state === 'error') notifications.push({ level: 'warn', key: 'app-update', title: 'обновление приложения не проверилось', ...(appUpd.message ? { text: appUpd.message } : {}) });
  }, [appUpd?.state, appUpd?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // фоновый поиск сессий Claude Code вне Perimeter: при подключении среды и раз в 10 минут; новые — тостом
  const liveKey = enabled.filter((e) => clients.get(e).status === 'live').join(',');
  useEffect(() => {
    let stop = false;
    const scan = async () => {
      for (const env of liveKey ? liveKey.split(',') : []) {
        try {
          const r = await clients.get(env).searchSessions('', true, 500);
          const first = localStorage.getItem(`perimeter:foreign-seen:${env}`) === null;
          const { fresh, seen } = newForeign(r.sessions, loadSeen(localStorage, env), first);
          saveSeen(localStorage, env, seen);
          if (stop || fresh.length === 0) continue;
          notifications.push({ level: 'info', env, key: `foreign:${env}`, title: `новых сессий Claude Code вне Perimeter — ${fresh.length}`, text: 'запущены Claude Code напрямую; откроются здесь с историей', action: { label: 'показать', run: () => setSearch({ foreign: true }) } });
          if (typeof document !== 'undefined' && !document.hasFocus()) window.perimeterIPC?.notify('perimeter', `«${envLabel(env)}»: новых сессий Claude Code вне Perimeter — ${fresh.length}`);
        } catch { /* supervisor старой версии без поиска — молча */ }
      }
    };
    void scan();
    const t = setInterval(() => void scan(), FOREIGN_SCAN_MS);
    return () => { stop = true; clearInterval(t); };
  }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // «не засыпать» (тумблер в настройках): пока хоть одна сессия работает или ждёт ответа
  const anyBusy = enabled.some((e) => [...clients.get(e).sessions.values()].some((s) => !s.archived && (s.state === 'working' || s.state === 'waiting_permission' || s.state === 'waiting_input' || s.state === 'initializing')));
  useEffect(() => {
    const on = localStorage.getItem('perimeter:keep-awake') === 'on';
    void window.perimeterIPC?.setKeepAwake?.(on && anyBusy).catch(() => undefined);
  }, [anyBusy]);

  // набор клиентов следует за списком подключений: включённые подключены, выключенные — нет, удалённые — забыты
  useEffect(() => {
    for (const c of connections.list) {
      const cl = clients.get(c.id);
      cl.setUrl(c.wsUrl);
      if (c.enabled) cl.ensureConnected(); else cl.close();
    }
    for (const id of clients.ids()) if (!connections.get(id)) clients.drop(id);
  }, [clients, connections.list]);
  // локальный supervisor — только когда среду включили (и при старте окна), а не на каждое изменение списка: статус
  // локального supervisor'а тоже меняет список, и просьбы «запустить» шли на каждый мегабайт докачки (23.11)
  const localOn = connections.get(LOCAL)?.enabled === true;
  useEffect(() => {
    if (localOn) void window.perimeterIPC?.startLocalSupervisor().catch(() => undefined);
  }, [localOn]);
  useEffect(() => () => { for (const c of clients.all()) c.close(); }, [clients]);

  useEffect(() => {
    const ipc = window.perimeterIPC;
    if (!ipc) return;
    let live = true;
    ipc.onLocalSupervisorStatus?.((s) => { if (live) { setLocalSup(s); connections.setLocalStatus(s); } })
      .then((initial) => { if (live && initial) { setLocalSup(initial); connections.setLocalStatus(initial); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const active = client.activeId ? client.sessions.get(client.activeId) : undefined;
  const modal = showSettings !== false || syncEnv !== null || newProject !== null;
  useEffect(() => { setSelectedFile(null); }, [active?.id]);

  // горячие клавиши: свежие значения — через ref, слушатель один
  const latest = useRef({ active, modal, panel, envs: enabled, clients });
  latest.current = { active, modal, panel, envs: enabled, clients };
  const jumpToWaitingRef = useRef(jumpToWaiting);
  jumpToWaitingRef.current = jumpToWaiting;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { active: a, modal: m, panel: p } = latest.current;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (e.code === 'KeyN') { e.preventDefault(); setDraft((d) => d ?? { env: activeEnvRef.current }); return; }
        if (e.code === 'Comma' || e.key === ',') { e.preventDefault(); setShowSettings(true); return; }
        // Ctrl+Tab — прыжок на предыдущую сессию (стек последних; повтор возвращает обратно)
        if (e.key === 'Tab') {
          e.preventDefault();
          const list = recentRef.current;
          const next = list[1];
          if (next) selectSession(next.env, next.sid);
          return;
        }
        // Ctrl+K — поиск сессий (как /resume в Claude Code)
        if (e.code === 'KeyK') { e.preventDefault(); setSearch({ foreign: false }); return; }
        // Ctrl+J — к следующей ждущей («Ждут тебя» по всем средам)
        if (e.code === 'KeyJ') { e.preventDefault(); jumpToWaitingRef.current(); return; }
      }
      if (m) return;
      const hk = panelHotkey(e);
      if (hk) {
        e.preventDefault();
        if (hk === 'toggle') setPanel((s) => ({ ...s, open: !s.open, fullscreen: false }));
        else if (hk === 'fullscreen') setPanel((s) => ({ ...s, open: true, fullscreen: !s.fullscreen }));
        else setPanel((s) => toggleTab(s, hk.tab));
        return;
      }
      if (e.key === 'Escape' && p.open && p.fullscreen && !e.defaultPrevented) {
        e.preventDefault();
        setPanel((s) => ({ ...s, fullscreen: false }));
        return;
      }
      // Y / N / A — ответ на верхний запрос разрешения активной сессии
      const ans = answerHotkey(e);
      if (ans && a && !isEditable(e.target)) {
        const card = a.permissions.find((c) => !c.questions?.length);
        if (!card || a.permissions[0] !== card) return;
        e.preventDefault();
        if (ans === 'allow') client.respondPermission(a.id, card.requestId, 'allow');
        else if (ans === 'deny') client.respondPermission(a.id, card.requestId, 'deny');
        else client.alwaysAllowTool(a.id, card.requestId, card.toolName);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client, setPanel]);

  // контекст: опрос активной сессии раз в 20 с и сразу после хода
  useEffect(() => {
    if (!active || client.status !== 'live') return;
    client.requestContext(active.id);
    const t = setInterval(() => client.requestContext(active.id), 20000);
    return () => clearInterval(t);
  }, [client, active?.id, client.status, active?.lastResult]);

  const openTab = (tab: PanelTab) => setPanel((s) => ({ ...s, open: true, tab }));
  const openChange = (path: string) => { setSelectedFile(path); openTab('changes'); };
  /** Прокрутить ленту к элементу (из панели); на весь экран — сначала свернуть. */
  // автообновление supervisor'а на серверах (main): ход — тостом; готово/не вышло — само скрывается через 12 с
  // поиск сессий (Ctrl+K); foreign — открыть сразу «вне Perimeter» (из уведомления фонового поиска)
  const [search, setSearch] = useState<false | { foreign: boolean }>(false);

  useEffect(() => window.perimeterIPC?.onServerUpdate?.((e) => {
    notifications.push({ level: e.state === 'failed' ? 'err' : e.state === 'done' ? 'ok' : 'info', key: `srvupd:${e.connId}`, title: serverUpdateText(e, envLabel(e.connId)) });
  }), []);
  // список задач над полем ввода (как в Desktop): план активной сессии
  const activePlan = active ? extractPlan(active.items) : null;
  const reveal = (itemId: string) => {
    setPanel((s) => (s.fullscreen ? { ...s, fullscreen: false } : s));
    requestAnimationFrame(() => {
      const el = document.getElementById(`feed-${itemId}`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1400);
    });
  };

  /** «@ Упомянуть» из панели «Файлы»: строка ввода должна быть видна — на весь экран сворачиваем. */
  const mention = (text: string) => {
    setPanel((s) => (s.fullscreen ? { ...s, fullscreen: false } : s));
    afterPaint(() => requestComposerInsert(text));
  };

  const full = panel.open && panel.fullscreen;
  const projectName = active?.projectId ? client.projects.find((p) => p.id === active.projectId)?.name : undefined;
  const hasChanges = active ? fileChanges(active.items).length > 0 : false;
  const statusBar = <StatusBar client={client} session={active} tunnel={connections.get(activeEnv)?.status === 'подключён' ? 'up' : connections.get(activeEnv)?.status ?? ''} onTab={openTab} onSettings={() => setShowSettings(activeEnv)} />;

  return (
    <div className={`app ${full ? 'is-full' : ''}`}>
      {!full && (
        <Sidebar
          clients={clients}
          envs={enabled}
          activeEnv={activeEnv}
          localSup={localSup}
          onSelect={selectSession}
          onCreate={openCreate}
          onNewProject={(env) => setNewProject({ env: env ?? activeEnv })}
          onAddConnection={() => setShowSettings('add')}
          onSync={setSyncEnv}
          onTransfer={(env, sid) => setTransfer({ env, sid })}
          onSearchAll={() => setSearch({ foreign: false })}
        />
      )}
      {syncEnv && <SyncDialog client={clients.get(syncEnv)} onClose={() => setSyncEnv(null)} />}
      {transfer && (
        <TransferDialog
          clients={clients}
          envs={enabled}
          fromEnv={transfer.env}
          sessionId={transfer.sid}
          onDone={(r) => {
            const dst = clients.get(r.dstEnv);
            notifications.push({
              level: r.untracked > 0 ? 'warn' : 'ok', env: r.srcEnv, key: `transfer:${r.dstSid}`,
              title: `сессия перенесена → ${envLabel(r.dstEnv)}${dst.sessions.get(r.dstSid) ? ` · «${dst.sessions.get(r.dstSid)!.name}»` : ''}`,
              ...(r.untracked > 0 ? { text: `новых файлов без git: ${r.untracked} — не переехали` } : {}),
              action: { label: 'отменить', run: () => {
                // отмена честна только пока на цели не начали работать (сессия «остывшая» после импорта)
                const moved = dst.sessions.get(r.dstSid);
                if (dst.status === 'live' && moved !== undefined && moved.state === 'dead') undoTransfer(clients.get(r.srcEnv), dst, r.srcSid, r.dstSid);
                else notifications.push({ level: 'warn', title: 'перенос уже не отменить — на новом месте начали работать' });
              } },
            });
          }}
          onClose={() => setTransfer(null)}
        />
      )}
      {newProject && (
        <NewProjectDialog
          clients={clients}
          envs={enabled}
          initialEnv={newProject.env}
          onClose={() => setNewProject(null)}
          onCreated={(ids) => {
            const id = ids[newProject.env];
            if (id) newProject.done?.(id);
            setNewProject(null);
          }}
        />
      )}
      {search !== false && <SessionSearch clients={clients} envs={enabled} foreignFirst={search.foreign} onOpen={(env, sid) => selectSession(env, sid)} onClose={() => setSearch(false)} />}
      {showSettings !== false && <SettingsDialog clients={clients} {...(typeof showSettings === 'string' ? { initial: showSettings } : {})} composerStyle={composerStyle} onComposerStyle={setComposerStyle} onClose={() => setShowSettings(false)} />}
      <div className={`work ${panel.open && !full && panel.dock !== 'floating' ? `with-${panel.dock}` : ''}`} ref={workRef}>
        <main className="center" hidden={full}>
          {draft
            ? null
            : active
            ? <SessionHeader
                session={active}
                client={client}
                projectName={projectName}
                panelOpen={panel.open}
                panelTab={panel.tab}
                hasChanges={hasChanges}
                onTab={(t) => setPanel((s) => toggleTab(s, t))}
                onTogglePanel={() => setPanel((s) => ({ ...s, open: !s.open, fullscreen: false }))}
              />
            : <header className="topbar"><div className="topbar-title"><span className="topbar-name">perimeter</span></div></header>}
          {client.status !== 'live' && (
            <div className="conn-banner" role="status">
              <span className="dot dot-amber" />
              {client.environment === 'local'
                ? `Локальный supervisor: ${localSup || 'нет связи'}${localSup === 'запущен' ? ' — подключаемся…' : ''}`
                : client.status === 'connecting' ? 'Подключаемся к supervisor…' : 'Нет связи с supervisor — переподключаемся. Сессии на сервере продолжают работать.'}
              {client.environment === 'local' && window.perimeterIPC && localSup !== 'запущен' && !localSupBusy(localSup) && (
                <button className="link-btn" onClick={() => void window.perimeterIPC?.startLocalSupervisor()}>запустить</button>
              )}
              {!(client.environment === 'local' && localSupBusy(localSup)) && <button className="link-btn" onClick={() => client.reconnectNow()}>повторить</button>}
            </div>
          )}
          {draft
            ? <NewSession
                key={`${draft.env}:${draft.projectId ?? ''}`}
                clients={clients}
                envs={enabled}
                initial={draft}
                composerStyle={composerStyle}
                onCancel={() => setDraft(null)}
                onStarted={(env, sid) => { setDraft(null); selectSession(env, sid); }}
                onNewProject={(env, done) => setNewProject({ env, done })}
                onEnv={setDraftEnv}
              />
            : active
            ? <>
                <Feed session={active} client={client} onOpenChange={openChange} onOpenSession={(id) => selectSession(activeEnv, id)} />
                {showTaskStrip(activePlan) && <TaskStrip key={`tasks:${activeEnv}:${active.id}`} plan={activePlan} running={active.state === 'working'} onReveal={reveal} />}
                <Composer
                  key={`${activeEnv}:${active.id}`}
                  variant={composerStyle}
                  draftKey={draftKey(activeEnv, active.id)}
                  tools={<><ModelPicker session={active} client={client} /><EffortPicker session={active} client={client} /><UltracodeToggle session={active} client={client} /><ModePicker session={active} client={client} /></>}
                  disabled={client.status !== 'live'}
                  busy={active.state === 'working' || active.state === 'waiting_permission' || active.state === 'waiting_input'}
                  // будим при выборе: «спит» видно, только если разбудить заранее не вышло (лимит, старый supervisor)
                  hint={isCold(active.state) && active.waking === undefined ? 'Сессия спит — первое сообщение разбудит её с историей' : undefined}
                  hold={client.status === 'live' ? sendHold(active, Date.now()) : null}
                  onInput={() => client.wake(active.id, 'typing')}
                  onSend={(text, images) => client.sendText(active.id, text, images)}
                  onStop={() => client.interrupt(active.id)}
                />
              </>
            : <div className="empty">
                <h2>perimeter</h2>
                <p className="dim">Сессии живут на сервере и переживают обрывы связи.</p>
                <button className="btn primary" onClick={() => openCreate()}>Новая сессия</button>
                {client.status !== 'live' && <p className="dim">supervisor недоступен ({client.url}) — проверьте туннель</p>}
              </div>}
          {statusBar}
        </main>
        {panel.open && (
          <Panel
            state={panel}
            setState={setPanel}
            session={active}
            client={client}
            workRef={workRef}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
            onReveal={reveal}
            onMention={mention}
          />
        )}
      </div>
      {full && (
        <div className="full-foot">
          {active && <PendingBar session={active} client={client} onOpenFeed={() => setPanel((s) => ({ ...s, fullscreen: false }))} />}
          {statusBar}
        </div>
      )}
      <TooltipLayer />
    </div>
  );
}
