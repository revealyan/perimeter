// Новая сессия без окна — как в Claude Code Desktop: «+» открывает в центре пустую сессию; над полем ввода —
// где (среда, проект), в поле — аккаунт·модель, усилие, ultracode, режим. Первое сообщение создаёт сессию,
// имя берётся из него. Выбор аккаунта/модели/режима запоминается на среду.
import { useEffect, useState } from 'react';
import type { EnvId, SessionView, SupervisorClient, ClientSet } from '../supervisor';
import { envLabel, isRemote } from '../supervisor';
import type { ComposerStyle } from '../lib/composerModel';
import { draftKey } from '../lib/composerModel';
import { effortsFor, ultracodeAllowed, type EffortLevel } from '../lib/modelsModel';
import { sessionNameFrom } from '../lib/naming';
import { Composer } from './Composer';
import { EffortPicker, ModePicker, ModelPicker, UltracodeToggle } from './SessionPickers';
import { Icon } from './Icon';
import { ProjectTag, usePopover } from './ui';

interface Choice { profile?: string; model?: string; permissionMode?: string; effort?: EffortLevel; ultracode?: boolean }

const lastKey = (env: EnvId) => `perimeter:new-session:${env}`;
function loadLast(env: EnvId): Choice & { projectId?: string | null } {
  try { return JSON.parse(localStorage.getItem(lastKey(env)) ?? '{}') as Choice & { projectId?: string | null }; } catch { return {}; }
}

function ProjectPicker({ client, projectId, onPick, onNewProject }: {
  client: SupervisorClient;
  projectId: string | null;
  onPick: (id: string | null) => void;
  onNewProject: () => void;
}) {
  const pop = usePopover();
  const cur = projectId ? client.projects.find((p) => p.id === projectId) : undefined;
  return (
    <div className="picker" ref={pop.ref}>
      <button className="hbtn newsess-project" onClick={() => pop.setOpen(!pop.open)} aria-haspopup="menu" aria-expanded={pop.open}>
        <Icon name="folder" /><ProjectTag name={cur?.name} /><Icon name="chevronDown" size={14} className="hbtn-chev" />
      </button>
      {pop.open && (
        <div className="menu picker-menu newsess-project-menu" role="menu">
          <div className="menu-title">Проекты · {envLabel(client.environment)}</div>
          {client.projects.map((p) => (
            <button key={p.id} role="menuitemradio" aria-checked={p.id === projectId} className="menu-2line" onClick={() => { pop.setOpen(false); onPick(p.id); }}>
              <span><ProjectTag name={p.name} /><span className="menu-hint mono">{p.path}</span></span>
              {p.id === projectId && <Icon name="check" size={14} />}
            </button>
          ))}
          <button role="menuitemradio" aria-checked={projectId === null} onClick={() => { pop.setOpen(false); onPick(null); }}>
            <ProjectTag />{projectId === null && <Icon name="check" size={14} />}
          </button>
          <div className="menu-sep" />
          <button role="menuitem" onClick={() => { pop.setOpen(false); onNewProject(); }}><Icon name="plus" size={14} /> Новый проект…</button>
        </div>
      )}
    </div>
  );
}

export function NewSession({ clients, envs, initial, composerStyle, onCancel, onStarted, onNewProject, onEnv }: {
  clients: ClientSet;
  envs: EnvId[];
  /** откуда пришли: среда и проект (undefined — как в прошлый раз, null — без проекта) */
  initial: { env: EnvId; projectId?: string | null };
  composerStyle: ComposerStyle;
  onCancel: () => void;
  onStarted: (env: EnvId, sid: string) => void;
  /** открыть «Новый проект» для среды; созданный проект выбирается сам */
  onNewProject: (env: EnvId, done: (projectId: string) => void) => void;
  /** выбранная в черновике среда (панель справа работает с ней) */
  onEnv?: (env: EnvId) => void;
}) {
  const [env, setEnv] = useState<EnvId>(envs.includes(initial.env) ? initial.env : envs[0]!);
  const client = clients.get(env);
  useEffect(() => { onEnv?.(env); }, [env]);
  const last = loadLast(env);
  const [projectId, setProjectId] = useState<string | null>(initial.projectId !== undefined ? initial.projectId : last.projectId ?? null);
  const [choice, setChoice] = useState<Choice>(() => ({ ...last }));

  // смена среды: проект и выбор — как в прошлый раз в той среде
  const switchEnv = (e: EnvId) => {
    if (e === env) return;
    const l = loadLast(e);
    setEnv(e);
    setProjectId(l.projectId ?? null);
    setChoice({ ...l });
  };
  // проекта больше нет в среде — без проекта
  const project = projectId ? client.projects.find((p) => p.id === projectId) : undefined;
  useEffect(() => { if (projectId && client.projects.length > 0 && !project) setProjectId(null); }, [projectId, project, client.projects.length]);

  // проект задаёт свои умолчания аккаунта/модели/режима — если явно не выбрано другое
  // аккаунт не выбран: аккаунт supervisor'а, если он вошёл, иначе первый рабочий (не «не вошёл»)
  const usable = client.profiles.filter((p) => p.auth?.loggedIn !== false);
  const fallback = client.profiles.find((p) => p.name === 'default' && p.auth?.loggedIn !== false) ? undefined : usable[0]?.name;
  const profile = choice.profile ?? project?.profile ?? fallback;
  const model = choice.model ?? project?.model ?? client.profiles.find((p) => p.name === profile)?.model;
  const permissionMode = choice.permissionMode ?? project?.permissionMode;
  const profileInfo = client.profiles.find((p) => p.name === profile);
  const levels = effortsFor(profileInfo, model);
  const effort = choice.effort !== undefined && levels.includes(choice.effort) ? choice.effort : undefined;
  const ultracode = choice.ultracode === true && ultracodeAllowed(profileInfo);

  // «сессия» для переключателей — текущий выбор черновика
  const draft: SessionView = {
    id: 'new', name: '', state: 'idle', needs: null, lastActivity: 0, items: [], permissions: [], printing: null,
    ...(profile !== undefined ? { profile } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ultracode,
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onCancel(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const live = client.status === 'live';
  const start = async (text: string, images?: string[]): Promise<boolean> => {
    const sid = await client.newSession({
      name: sessionNameFrom(text),
      ...(projectId ? { projectId } : {}),
      ...(profile !== undefined ? { profile } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(ultracode ? { ultracode: true } : {}),
    });
    if (!sid) return false; // ошибка уже в тосте; текст остаётся в поле
    client.sendText(sid, text, images);
    localStorage.setItem(lastKey(env), JSON.stringify({ ...choice, projectId }));
    onStarted(env, sid);
    return true;
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-title"><span className="topbar-name">Новая сессия</span></div>
        <div className="topbar-controls">
          <button className="hbtn" onClick={onCancel} data-tip="Вернуться к сессии" data-key="Esc"><Icon name="x" /><span className="hbtn-label">Отмена</span></button>
        </div>
      </header>
      <div className="newsess">
        <div className="newsess-hero">
          <h2>С чего начнём?</h2>
          <p className="dim">Сессия появится с первым сообщением — имя возьмётся из него.</p>
          <div className="newsess-where">
            {envs.length > 1 && (
              <div className="seg env-seg" role="radiogroup" aria-label="Среда">
                {envs.map((e) => (
                  <button key={e} type="button" role="radio" aria-checked={env === e} className={env === e ? 'on' : ''} onClick={() => switchEnv(e)}>
                    <Icon name={isRemote(e) ? 'server' : 'laptop'} size={14} /> {envLabel(e)}
                  </button>
                ))}
              </div>
            )}
            <ProjectPicker client={client} projectId={projectId} onPick={setProjectId} onNewProject={() => onNewProject(env, (id) => setProjectId(id))} />
          </div>
          {project && <div className="newsess-path mono dim">{project.path}</div>}
          {!project && <div className="newsess-path dim">без проекта — папка supervisor'а; лучше выбрать или создать проект</div>}
          {!live && <div className="warn-text newsess-path">Нет связи со средой «{envLabel(env)}» — сессию создать нельзя, пока не подключится.</div>}
        </div>
      </div>
      <Composer
        key={`new:${env}`}
        variant={composerStyle}
        draftKey={draftKey(env, 'new')}
        autoFocus
        placeholder="Опишите задачу — Enter создаст сессию"
        disabled={!live}
        busy={false}
        tools={(
          <>
            <ModelPicker session={draft} client={client} onPick={(p, m) => setChoice({ ...choice, profile: p, model: m })} />
            <EffortPicker session={draft} client={client} onPick={(e) => setChoice({ ...choice, ...(e === null ? { effort: undefined } : { effort: e }) })} />
            <UltracodeToggle session={draft} client={client} onToggle={(on) => setChoice({ ...choice, ultracode: on })} />
            <ModePicker session={draft} client={client} onPick={(m) => setChoice({ ...choice, permissionMode: m })} />
          </>
        )}
        onSend={start}
        onStop={() => undefined}
      />
    </>
  );
}
