// Сайдбар S1 «Среды секциями» (Фигма, ряд «Обе среды сразу»): обе среды в одном списке.
// Сверху общий «Ждут тебя» (ответ прямо в карточке, метка среды), ниже секция на каждую среду
// (сворачивается, строки по статусу), внизу общий архив. Фильтр проектов — по имени: среды связаны по имени.
import { Fragment, useEffect, useRef, useState } from 'react';
import type { EnvId, SessionView, SupervisorClient, ClientSet } from '../supervisor';
import { envLabel, envShort, isRemote, profileLabel } from '../supervisor';
import { LOCAL, connections } from '../connections';
import { groupOf, waitingInfo, type GroupId } from '../lib/sessionGroups';
import { layoutEnvs, mergeProjects, projectGroups } from '../lib/envSections';
import { lastAction } from '../lib/feedModel';
import { STATE_LABEL, ago } from './labels';
import { Icon, type IconName } from './Icon';
import { MultiLine, ProjectTag, usePopover } from './ui';
import { localSupBusy } from '../lib/localSup';

const TRANSFER_TIP = 'история переедет, процесс здесь остановится';

/** «undefined» — все проекты, «null» — без проекта, иначе имя проекта (общее для сред). */
type ProjectFilter = string | null | undefined;
const FILTER_KEY = 'perimeter:project-filter-name';
const PROJ_CLOSED_KEY = 'perimeter:project-groups-closed';
function loadFilter(): ProjectFilter {
  const v = localStorage.getItem(FILTER_KEY);
  return v === null ? undefined : v === '' ? null : v;
}

const collapsedKey = (env: EnvId) => `perimeter:env-collapsed:${env}`;

/** Метка среды на карточке/строке (когда в списке обе среды). */
function EnvTag({ env }: { env: EnvId }) {
  return (
    <span className="env-tag" data-tip={envLabel(env)}>
      <Icon name={isRemote(env) ? 'server' : 'laptop'} size={12} />
      {envShort(env)}
    </span>
  );
}

function SessionMenu({ s, client, onRename, onTransfer }: { s: SessionView; client: SupervisorClient; onRename: () => void; onTransfer?: () => void }) {
  const pop = usePopover();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // переносим только спокойную сессию: ждущие аппрувы и середину хода не увезти
  const transferable = onTransfer !== undefined && (s.state === 'idle' || s.state === 'dead');
  return (
    <div className="row-menu-wrap" ref={pop.ref} onClick={(e) => e.stopPropagation()}>
      <button className="row-menu" aria-label="Действия с сессией" aria-haspopup="menu" aria-expanded={pop.open} onClick={() => pop.setOpen(!pop.open)}>
        <Icon name="more" />
      </button>
      {pop.open && (
        <div className="menu row-menu-pop" role="menu">
          <button role="menuitem" onClick={() => { pop.setOpen(false); onRename(); }}>Переименовать</button>
          <button role="menuitem" onClick={() => { pop.setOpen(false); void client.fork(s.id); }}>Форк — копия истории</button>
          {transferable
            ? <button role="menuitem" data-tip={TRANSFER_TIP} onClick={() => { pop.setOpen(false); onTransfer(); }}>Перенести в другую среду…</button>
            : <button role="menuitem" aria-disabled="true" className="is-disabled" data-tip="дождитесь конца хода — тогда перенесу">Перенести в другую среду…</button>}
          {s.state !== 'dead' && <button role="menuitem" onClick={() => { pop.setOpen(false); client.stopSession(s.id); }}>Остановить процесс</button>}
          <button role="menuitem" onClick={() => { pop.setOpen(false); client.archiveSession(s.id, !s.archived); }}>{s.archived ? 'Вернуть из архива' : 'В архив'}</button>
          {(s.state === 'idle' || s.state === 'dead') && (
            confirmDelete
              ? <button role="menuitem" className="danger-text" data-tip="Вместе с историей — возврата нет" onClick={() => { pop.setOpen(false); client.deleteSession(s.id); }}>Точно удалить с историей?</button>
              : <button role="menuitem" onClick={() => setConfirmDelete(true)}>Удалить…</button>
          )}
        </div>
      )}
    </div>
  );
}

/** Имя сессии с переименованием по двойному клику. */
function useRename(s: SessionView, client: SupervisorClient) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.name);
  const commit = () => {
    const t = draft.trim();
    if (t && t !== s.name) client.renameSession(s.id, t);
    setEditing(false);
  };
  const start = () => { setDraft(s.name); setEditing(true); };
  const node = editing ? (
    <input
      className="rename-input"
      value={draft}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  ) : <span className="srow-name" onDoubleClick={(e) => { e.stopPropagation(); start(); }}>{s.name}</span>;
  return { node, start };
}

interface RowProps {
  s: SessionView;
  client: SupervisorClient;
  env: EnvId;
  /** в списке обе среды — показываем метку */
  showEnv: boolean;
  active: boolean;
  onSelect: () => void;
  project?: string | undefined;
  /** перенос в другую среду (меню «⋯»); нет — среда одна/переносить некуда */
  onTransfer?: () => void;
}

const GROUP_ICON: Record<GroupId, IconName> = { waiting: 'lock', working: 'activity', ready: 'check', fresh: 'circleDashed', cold: 'moon' };

/** Карточка «ждёт тебя»: что именно ждёт, ответ прямо здесь — в клиент среды этой сессии. */
function WaitingCard({ s, client, env, showEnv, active, onSelect, project, onTransfer }: RowProps) {
  const w = waitingInfo(s);
  const rename = useRename(s, client);
  const profile = s.profile ? profileLabel(client.profiles.find((p) => p.name === s.profile) ?? { name: s.profile }) : '';
  const since = s.permissions[0]?.at ?? s.lastActivity;
  const live = client.status === 'live';
  return (
    <div
      className={`wcard ${active ? 'active' : ''} ${live ? '' : 'off'}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onSelect(); }}
    >
      <div className="wcard-head">
        <span className="wcard-ico"><Icon name={w.kind === 'question' ? 'question' : 'lock'} /></span>
        {rename.node}
        {showEnv && <EnvTag env={env} />}
        <span className="srow-time">{ago(since)}</span>
        <SessionMenu s={s} client={client} onRename={rename.start} onTransfer={onTransfer} />
      </div>
      <div className="srow-sub"><ProjectTag name={project} extra={profile ? <span className="dim"> · {profile}</span> : null} /></div>
      {s.parentSessionId !== undefined && (
        <div className="srow-sub dim">сабагент · {client.sessions.get(s.parentSessionId)?.name ?? 'родитель скрыт'}</div>
      )}
      {w.kind === 'permission' && (
        <>
          <div className="wcard-what">{w.title}</div>
          <div className="wcard-cmd mono"><MultiLine text={w.target} /></div>
          <div className="wcard-actions">
            <button className="btn tint sm" disabled={!live} onClick={(e) => { e.stopPropagation(); client.respondPermission(s.id, w.card.requestId, 'allow'); }}>Разрешить</button>
            <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onSelect(); }}>Открыть</button>
          </div>
        </>
      )}
      {w.kind === 'question' && (
        <>
          <div className="wcard-what">Вопрос агента</div>
          <div className="wcard-q">«{w.question}»</div>
          <div className="wcard-actions wrap">
            {w.instant
              ? w.options.map((o) => (
                  <button key={o} className="btn tint sm" disabled={!live} onClick={(e) => { e.stopPropagation(); client.answerQuestions(s.id, w.card, { [w.card.questions![0]!.question]: o }); }}>{o}</button>
                ))
              : <button className="btn tint sm" onClick={(e) => { e.stopPropagation(); onSelect(); }}>Ответить</button>}
          </div>
        </>
      )}
      {w.kind === 'unknown' && <div className="wcard-what">{w.text}</div>}
      {!live && <div className="wcard-off dim">нет связи с «{envLabel(env)}» — ответить можно после переподключения</div>}
    </div>
  );
}

/** Строка сессии в секции среды. sub — строка воркера делегирования (с отступом под родителем, с меткой аккаунта). */
function SessionRow({ s, client, env, active, onSelect, project, group, inProject, sub, onTransfer }: RowProps & { group: GroupId; /** строка внутри группы проекта — метка проекта не нужна */ inProject?: boolean; sub?: boolean }) {
  const rename = useRename(s, client);
  const icon: IconName = s.state === 'error' ? 'alert' : GROUP_ICON[group];
  const workerAccount = sub && s.profile ? profileLabel(client.profiles.find((p) => p.name === s.profile) ?? { name: s.profile! }) : null;
  return (
    <div
      className={`srow g-${group} st-${s.state} ${active ? 'active' : ''} ${sub ? 'sub' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      title={STATE_LABEL[s.state] ?? s.state}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onSelect(); }}
      draggable={onTransfer !== undefined && !sub && (s.state === 'idle' || s.state === 'dead')}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', `perimeter-transfer:${env}:${s.id}`); e.dataTransfer.effectAllowed = 'move'; }}
    >
      <div className="srow-head">
        <span className="srow-ico"><Icon name={icon} /></span>
        {rename.node}
        {group !== 'working' && !inProject && <ProjectTag name={project} />}
        {workerAccount !== null && <span className="srow-badge" data-tip="аккаунт воркера">{workerAccount}</span>}
        <span className="srow-time">{ago(s.lastActivity)}</span>
        <SessionMenu s={s} client={client} onRename={rename.start} onTransfer={onTransfer} />
      </div>
      {group === 'working' && (
        <>
          <div className="srow-sub">
            {!inProject && <><ProjectTag name={project} /> · </>}
            <span className="srow-action mono">{lastAction(s.items, s.printing)}</span>
          </div>
          <div className="srow-progress" aria-hidden><span /></div>
        </>
      )}
    </div>
  );
}

type MergedProject = ReturnType<typeof mergeProjects>[number];

function ProjectFilterMenu({ projects, filter, setFilter, total, showEnv }: {
  projects: MergedProject[];
  filter: ProjectFilter;
  setFilter: (f: ProjectFilter) => void;
  total: number;
  showEnv: boolean;
}) {
  const pop = usePopover();
  const current = filter === undefined ? 'Все проекты' : filter === null ? 'Без проекта' : projects.find((p) => p.name.toLowerCase() === filter.toLowerCase())?.name ?? 'Все проекты';
  const pick = (f: ProjectFilter) => { setFilter(f); pop.setOpen(false); };
  return (
    <div className="side-title" ref={pop.ref}>
      <button className="side-title-btn" aria-haspopup="menu" aria-expanded={pop.open} onClick={() => pop.setOpen(!pop.open)}>
        <span className="side-title-name">{current}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <span className="side-count">{total} {total === 1 ? 'сессия' : total > 1 && total < 5 ? 'сессии' : 'сессий'}</span>
      {pop.open && (
        <div className="menu side-filter" role="menu">
          <button role="menuitemradio" aria-checked={filter === undefined} onClick={() => pick(undefined)}>Все проекты</button>
          {projects.map((p) => (
            <button
              key={p.name}
              role="menuitemradio"
              aria-checked={typeof filter === 'string' && filter.toLowerCase() === p.name.toLowerCase()}
              onClick={() => pick(p.name)}
              title={p.envs.map((e) => `${envLabel(e)}: ${p.paths[e] ?? ''}`).join('\n')}
            >
              <ProjectTag name={p.name} />
              <span className="spacer" />
              {showEnv && p.envs.map((e) => <EnvTag key={e} env={e} />)}
            </button>
          ))}
          <button role="menuitemradio" aria-checked={filter === null} onClick={() => pick(null)}><ProjectTag /></button>
        </div>
      )}
    </div>
  );
}

/** «:8791» из ws://127.0.0.1:8791 — подпись локальной среды. */
function portOf(url: string): string {
  try { return `:${new URL(url).port}`; } catch { return 'локально'; }
}

/** Шапка секции среды: свернуть/развернуть, точка связи, канал (ssh ✓ / :8791), счётчик. */
function EnvHeader({ env, client, collapsed, onToggle, count, status, onNewSession, onNewProject }: {
  env: EnvId;
  client: SupervisorClient;
  collapsed: boolean;
  onToggle: () => void;
  count: number;
  /** статус подключения (туннель / локальный supervisor) */
  status: string;
  onNewSession: () => void;
  onNewProject: () => void;
}) {
  const live = client.status === 'live';
  const ipc = typeof window !== 'undefined' ? window.perimeterIPC : undefined;
  const sshOk = status === 'up' || status === 'подключён';
  const link = isRemote(env)
    ? (!ipc ? <span className="dim" data-tip={client.url}>напрямую</span>
      : sshOk ? <span className="ok-text" data-tip={client.url}>ssh ✓</span>
      : <span className="warn-text" data-tip={client.url}>ssh {status || '…'}</span>)
    : <span className="dim" data-tip={client.url}>{portOf(client.url || 'ws://127.0.0.1:8791')}</span>;
  return (
    <div
      className={`env-head ${live ? '' : 'off'}`}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onToggle(); }}
      aria-expanded={!collapsed}
      data-tip={collapsed ? 'Развернуть' : 'Свернуть'}
    >
      <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} className="dim" />
      <Icon name={isRemote(env) ? 'server' : 'laptop'} />
      <span className="env-name">{envLabel(env)}</span>
      <span className={`dot dot-${live ? 'green' : client.status === 'connecting' ? 'yellow' : 'red'}`} />
      {live && link}
      {!live && client.fromCache && <span className="dim" data-tip="Список и открытые чаты — из локального кэша; обновятся, как только подключимся">из кэша</span>}
      <span className="spacer" />
      <span className="dim env-count">{count || ''}</span>
      <span className="env-actions">
        <button className="icon-btn sm" data-tip={`Новая сессия · ${envLabel(env)}`} aria-label={`Новая сессия в ${envLabel(env)}`} onClick={(e) => { e.stopPropagation(); onNewSession(); }}><Icon name="plus" size={14} /></button>
        <button className="icon-btn sm" data-tip={`Новый проект · ${envLabel(env)}`} aria-label={`Новый проект в ${envLabel(env)}`} onClick={(e) => { e.stopPropagation(); onNewProject(); }}><Icon name="folderPlus" size={14} /></button>
      </span>
    </div>
  );
}

/** Строка под шапкой среды без связи: что случилось и «запустить» / «повторить» (видна и у свёрнутой секции). */
function EnvOffline({ env, client, localSup }: { env: EnvId; client: SupervisorClient; localSup: string }) {
  const ipc = typeof window !== 'undefined' ? window.perimeterIPC : undefined;
  const text = env === 'local' && localSup && localSup !== 'запущен'
    ? `supervisor: ${localSup}`
    : client.status === 'connecting'
      ? 'подключаемся…'
      : isRemote(env) ? 'нет связи — сессии на сервере продолжают работать' : 'нет связи с локальным supervisor';
  // ставится/стартует — кнопки бесполезны (и мигали рядом с ходом установки): видна только строка хода
  const busy = env === 'local' && localSupBusy(localSup);
  const canStart = env === 'local' && ipc !== undefined && localSup !== 'запущен' && !busy;
  return (
    <div className="env-offline" role="status">
      {/* ход установки длинный («… · 45 из 153 МБ») — переносится, а не режется многоточием */}
      <span className={`warn-text env-off${busy ? ' wrap' : ''}`} data-tip={text}>{busy ? localSup : text}</span>
      {canStart && <button className="link-btn" onClick={() => void ipc?.startLocalSupervisor()}>запустить</button>}
      {!busy && <button className="link-btn" onClick={() => client.reconnectNow()}>повторить</button>}
    </div>
  );
}

export function Sidebar({ clients, envs, activeEnv, localSup, onSelect, onCreate, onNewProject, onAddConnection, onSync, onTransfer }: {
  clients: ClientSet;
  /** включённые подключения (VPS…, этот компьютер) */
  envs: EnvId[];
  /** среда выбранной сессии */
  activeEnv: EnvId;
  /** статус локального supervisor'а из main (запускается…/запущен/упал…) */
  localSup?: string;
  onSelect: (env: EnvId, id: string) => void;
  /** новая сессия: среда и проект заранее (null — без проекта), если пришли из группы проекта */
  onCreate: (env?: EnvId, projectId?: string | null) => void;
  /** новый проект (в среде, если пришли из её шапки) */
  onNewProject: (env?: EnvId) => void;
  /** добавить подключение (VPS) — открывает настройки */
  onAddConnection: () => void;
  onSync: (env: EnvId) => void;
  /** перенос сессии в другую среду (T-ряд): открывает диалог */
  onTransfer: (env: EnvId, sid: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<EnvId, boolean>>({});
  const isCollapsedEnv = (env: EnvId) => collapsed[env] ?? localStorage.getItem(collapsedKey(env)) === 'on';
  const [filter, setFilterState] = useState<ProjectFilter>(loadFilter);
  // свёрнутые группы проектов: ключ «среда:id проекта» («-» — без проекта)
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(PROJ_CLOSED_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  const toggleProject = (key: string) => {
    const next = { ...closed, [key]: !closed[key] };
    if (!next[key]) delete next[key];
    setClosed(next);
    localStorage.setItem(PROJ_CLOSED_KEY, JSON.stringify(next));
  };
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  const setFilter = (f: ProjectFilter) => {
    setFilterState(f);
    if (f === undefined) localStorage.removeItem(FILTER_KEY);
    else localStorage.setItem(FILTER_KEY, f ?? '');
  };
  const toggleEnv = (env: EnvId) => {
    const next = !isCollapsedEnv(env);
    setCollapsed({ ...collapsed, [env]: next });
    localStorage.setItem(collapsedKey(env), next ? 'on' : 'off');
  };

  const showEnv = envs.length > 1;
  const projects = mergeProjects(envs.map((env) => ({ env, projects: clients.get(env).projects })));
  // проект из фильтра исчез (удалён, среду выключили) — показываем все
  const effFilter = typeof filter === 'string' && projects.length > 0 && !projects.some((p) => p.name.toLowerCase() === filter.toLowerCase()) ? undefined : filter;
  const nameOf = (env: EnvId) => (s: SessionView) => (s.projectId ? clients.get(env).projects.find((p) => p.id === s.projectId)?.name : undefined);
  const layout = layoutEnvs(
    envs.map((env) => ({ env, sessions: clients.get(env).sessions.values(), projectName: nameOf(env) })),
    { ...(effFilter !== undefined ? { project: effFilter } : {}), query: search },
  );
  const props = (env: EnvId, s: SessionView): RowProps => ({
    s, env, showEnv,
    client: clients.get(env),
    active: env === activeEnv && clients.get(env).activeId === s.id,
    onSelect: () => onSelect(env, s.id),
    project: nameOf(env)(s),
    // среда одна или сессия-воркер — переноса нет
    ...(envs.length > 1 && s.parentSessionId === undefined ? { onTransfer: () => onTransfer(env, s.id) } : {}),
  });
  // перетаскивание строки в секцию другой среды (S1): зона сброса — «Отпустите — перенесём»
  const [dropEnv, setDropEnv] = useState<EnvId | null>(null);
  const dropPayload = (e: React.DragEvent): { env: EnvId; sid: string } | null => {
    const m = /^perimeter-transfer:([^:]+):(.+)$/.exec(e.dataTransfer.getData('text/plain'));
    return m ? { env: m[1]!, sid: m[2]! } : null;
  };
  const dropProps = (env: EnvId) => ({
    onDragOver: (e: React.DragEvent) => {
      const p = dropPayload(e);
      if (!p || p.env === env) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropEnv(env);
    },
    onDragLeave: () => setDropEnv((cur) => (cur === env ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropEnv(null);
      const p = dropPayload(e);
      if (p && p.env !== env) onTransfer(p.env, p.sid);
    },
  });
  const filtered = search !== '' || effFilter !== undefined;
  // фильтр по проекту: его группа видна и пустой (с «+» для новой сессии) — иначе сайдбар просто пустеет
  const groupProjects = (env: EnvId) => typeof effFilter === 'string'
    ? clients.get(env).projects.filter((p) => p.name.toLowerCase() === effFilter.toLowerCase())
    : clients.get(env).projects;
  const showEmptyGroups = search === '' && (effFilter === undefined || typeof effFilter === 'string');

  return (
    <aside className="sidebar">
      <div className="side-head">
        <ProjectFilterMenu projects={projects} filter={effFilter} setFilter={setFilter} total={layout.total} showEnv={showEnv} />
        <button className={`icon-btn boxed ${searchOpen ? 'on' : ''}`} data-tip="Поиск по сессиям" onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setSearch(''); }} aria-label="Поиск по сессиям"><Icon name="search" /></button>
        <button className="icon-btn boxed" data-tip="Новый проект" onClick={() => onNewProject()} aria-label="Новый проект"><Icon name="folderPlus" /></button>
        <button className="icon-btn boxed" data-tip="Новая сессия" data-key="Ctrl N" onClick={() => onCreate()} aria-label="Новая сессия"><Icon name="plus" /></button>
      </div>
      {searchOpen && (
        <input
          ref={searchRef}
          className="side-search"
          placeholder="Имя сессии…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); } }}
        />
      )}

      <div className="side-scroll">
        {layout.waiting.length > 0 && (
          <section className="sgroup g-waiting">
            <div className="sgroup-title" data-tip="Ctrl J — к следующей ждущей"><span className="sgroup-dot" />Ждут тебя · {layout.waiting.length}</div>
            {layout.waiting.map(({ env, s }) => <WaitingCard key={`${env}:${s.id}`} {...props(env, s)} />)}
          </section>
        )}

        {layout.sections.map((sec) => {
          const env = sec.env;
          const client = clients.get(env);
          const live = client.status === 'live';
          const isCollapsed = isCollapsedEnv(env);
          const nSync = client.syncSuggestions.length;
          return (
            <section key={env} className="env-section" aria-label={envLabel(env)}>
              <EnvHeader
                env={env}
                client={client}
                collapsed={isCollapsed}
                onToggle={() => toggleEnv(env)}
                count={sec.total}
                status={connections.get(env)?.status ?? ''}
                onNewSession={() => onCreate(env)}
                onNewProject={() => onNewProject(env)}
              />
              {!live && <EnvOffline env={env} client={client} localSup={localSup ?? ''} />}
              {!isCollapsed && (
                <div className={`env-rows ${live ? '' : 'off'} ${dropEnv === env ? 'drop' : ''}`} {...dropProps(env)}>
                  {nSync > 0 && live && (
                    <button className="sync-banner" onClick={() => onSync(env)} data-tip="Проекты другой среды, которых здесь нет">
                      <span>Из «{syncFrom(client)}»: {nSync} {nSync === 1 ? 'проект' : nSync < 5 ? 'проекта' : 'проектов'} без папки здесь</span>
                      <span className="sync-banner-cta">Привязать</span>
                    </button>
                  )}
                  {projectGroups(sec.rows, groupProjects(env), { includeEmpty: showEmptyGroups && live }).map((g) => {
                    const key = `${env}:${g.projectId ?? '-'}`;
                    const isClosed = closed[key] === true;
                    return (
                      <div key={key} className="pgroup">
                        <div
                          className="pgroup-head"
                          role="button"
                          tabIndex={0}
                          aria-expanded={!isClosed}
                          onClick={() => toggleProject(key)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) toggleProject(key); }}
                        >
                          <Icon name={isClosed ? 'chevronRight' : 'chevronDown'} size={12} className="dim" />
                          <ProjectTag name={g.name ?? undefined} />
                          {g.rows.length > 0 && <span className="pgroup-count">{g.rows.length}</span>}
                          <span className="spacer" />
                          <button
                            className="icon-btn sm pgroup-add"
                            data-tip={g.name ? `Новая сессия в «${g.name}»` : 'Новая сессия без проекта'}
                            aria-label={g.name ? `Новая сессия в проекте ${g.name}` : 'Новая сессия без проекта'}
                            onClick={(e) => { e.stopPropagation(); onCreate(env, g.projectId); }}
                          >
                            <Icon name="plus" size={12} />
                          </button>
                        </div>
                        {!isClosed && g.rows.map(({ s, group }) => (
                          <Fragment key={s.id}>
                            <SessionRow {...props(env, s)} group={group} inProject />
                            {(sec.children.get(s.id) ?? []).map((w) => (
                              <SessionRow key={w.id} {...props(env, w)} group={groupOf(w)} inProject sub />
                            ))}
                          </Fragment>
                        ))}
                      </div>
                    );
                  })}
                  {sec.total === 0 && !filtered && live && (
                    <div className="side-empty">Сессий нет. <button className="link-btn" onClick={() => onCreate(env)}>Создать</button> — {isRemote(env) ? 'она будет жить на сервере.' : 'она будет жить на этом компьютере.'}</div>
                  )}
                  {sec.total === 0 && !filtered && !live && <div className="side-empty">Сессии появятся после подключения.</div>}
                  {sec.total === 0 && filtered && !(showEmptyGroups && live && groupProjects(env).length > 0) && <div className="side-empty">Ничего не найдено</div>}
                  {sec.total > 0 && sec.rows.length === 0 && <div className="side-empty">Все сессии этой среды ждут ответа — выше.</div>}
                </div>
              )}
            </section>
          );
        })}

        {layout.archived.length > 0 && (
          <section className="sgroup">
            <button className="archive-toggle" onClick={() => setShowArchive(!showArchive)} aria-expanded={showArchive}>
              <Icon name="archive" />
              <span>Архив · {layout.archived.length}</span>
              <span className="spacer" />
              <Icon name={showArchive ? 'chevronDown' : 'chevronRight'} size={14} />
            </button>
            {showArchive && layout.archived.map(({ env, s }) => (
              <div
                key={`${env}:${s.id}`}
                className={`srow archived ${env === activeEnv && clients.get(env).activeId === s.id ? 'active' : ''}`}
                onClick={() => onSelect(env, s.id)}
                role="button"
                tabIndex={0}
              >
                <div className="srow-head">
                  <span className="srow-name">{s.name}</span>
                  {s.movedTo !== undefined && <span className="srow-badge" data-tip="Сессия переехала в другую среду">→ {s.movedTo}</span>}
                  <ProjectTag name={nameOf(env)(s)} />
                  {showEnv && <EnvTag env={env} />}
                  {s.movedTo === undefined && (
                    <button className="row-menu" data-tip="Вернуть из архива" aria-label="Вернуть из архива" onClick={(e) => { e.stopPropagation(); clients.get(env).archiveSession(s.id, false); }}><Icon name="archiveRestore" /></button>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}
        {connections.get(LOCAL)?.enabled === false && (
          <div className="env-head off env-disabled">
            <Icon name="laptop" />
            <span className="env-name">Этот компьютер</span>
            <span className="dim">выключен</span>
            <span className="spacer" />
            <button className="link-btn" onClick={() => connections.setLocalEnabled(true)}>включить</button>
          </div>
        )}
        <button className="side-add-conn" onClick={onAddConnection} data-tip="Подключить ещё один VPS (ssh)">
          <Icon name="plus" size={14} /> Подключение
        </button>
      </div>
    </aside>
  );
}

/** Откуда предложения синка: одна среда — её имя, несколько — «других подключений». */
function syncFrom(client: SupervisorClient): string {
  const from = [...new Set(client.syncSuggestions.map((x) => x.otherEnv))];
  return from.length === 1 ? envLabel(from[0]!) : 'других подключений';
}
