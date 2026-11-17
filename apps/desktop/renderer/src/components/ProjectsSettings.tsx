// Настройки → Проекты (макет P3): хранилище среды и проекты — где папка есть, где пропала, что вне хранилища;
// проекты другой среды, которых здесь нет (создать / склонировать сюда); папки хранилища без проекта (добавить).
import { useCallback, useEffect, useState } from 'react';
import type { EnvId, ProjectScan, SupervisorClient, ClientSet } from '../supervisor';
import { CmdError, envLabel, isRemote } from '../supervisor';
import { projectSlug } from '../lib/naming';
import { Icon } from './Icon';
import { ProjectTag } from './ui';

function errText(e: unknown): string {
  if (e instanceof CmdError && e.code === 'TIMEOUT') return 'supervisor не ответил вовремя — связь медленная';
  return e instanceof Error ? e.message : String(e);
}

const gb = (b: number | undefined) => (b === undefined ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} ГБ` : `${Math.round(b / 1e6)} МБ`);
const join = (root: string, name: string) => `${root}${root.includes('\\') ? '\\' : '/'}${name}`;

export function ProjectsSettings({ clients, envs, initialEnv }: { clients: ClientSet; envs: EnvId[]; initialEnv: EnvId }) {
  const [env, setEnv] = useState<EnvId>(envs.includes(initialEnv) ? initialEnv : envs[0]!);
  const client = clients.get(env);
  const other = envs.find((e) => e !== env);
  const [scan, setScan] = useState<Partial<Record<EnvId, ProjectScan | null>>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string>(''); // ключ действия, которое идёт
  const [rootDraft, setRootDraft] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const refresh = useCallback(() => {
    for (const e of envs) {
      const c = clients.get(e);
      if (c.status !== 'live' || !c.storage) { setScan((s) => ({ ...s, [e]: null })); continue; }
      void c.scanProjects().then((r) => setScan((s) => ({ ...s, [e]: r })), (x: unknown) => { if (e === env) setErr(errText(x)); });
    }
  }, [envs, clients, env]);
  useEffect(() => { refresh(); }, [refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr('');
    try { await fn(); refresh(); } catch (x) { setErr(errText(x)); } finally { setBusy(''); }
  };

  const here = scan[env];
  const there = other ? scan[other] : undefined;
  const live = client.status === 'live';
  const old = live && !client.storage;
  const root = client.storage?.root ?? '';
  // проекты другой среды, которых здесь нет (связь по имени)
  const haveNames = new Set(client.projects.map((p) => p.name.trim().toLowerCase()));
  const missingHere = other ? clients.get(other).projects.filter((p) => !haveNames.has(p.name.trim().toLowerCase())) : [];
  const originOf = (id: string) => there?.projects.find((p) => p.id === id)?.git?.origin ?? null;

  return (
    <div className="field projects-settings">
      <span>Проекты — где лежат и что с папками (одинаковое имя связывает проект между средами)</span>
      {envs.length > 1 && (
        <div className="seg env-seg" role="tablist" aria-label="Среда">
          {envs.map((e) => <button key={e} type="button" role="tab" aria-selected={env === e} className={env === e ? 'on' : ''} onClick={() => { setEnv(e); setErr(''); setRootDraft(null); }}>{envLabel(e)}</button>)}
        </div>
      )}
      {!live && <div className="warn-text acct-note">Нет связи со средой «{envLabel(env)}».</div>}
      {old && <div className="warn-text acct-note">supervisor этой среды старой версии — хранилище проектов не поддерживает. Обновите его.</div>}

      {live && !old && (
        <>
          <div className="acct ps-storage">
            <div className="acct-head"><Icon name="folder" /><b>Хранилище</b><span className="dim acct-desc">— куда по имени создаются новые проекты</span></div>
            <div className="field-inline">
              <input className="mono" value={rootDraft ?? root} onChange={(e) => setRootDraft(e.target.value)} spellCheck={false} aria-label="Папка хранилища" />
              {rootDraft !== null && rootDraft.trim() !== root && (
                <button className="btn sm" disabled={busy !== ''} onClick={() => void run('root', async () => { await client.setStorage(rootDraft.trim()); setRootDraft(null); })}>Сменить</button>
              )}
              {env === 'local' && window.perimeterIPC?.pickFolder && (
                <button className="btn sm" onClick={() => void window.perimeterIPC!.pickFolder().then((p) => { if (p) setRootDraft(p); })}><Icon name="folder" size={12} /></button>
              )}
            </div>
            <div className="dim acct-note">
              {client.storage?.exists === false ? 'папки нет — создастся при первом проекте' : `проектов в хранилище: ${here?.projects.filter((p) => p.inStorage).length ?? '…'}`}
              {client.storage?.freeBytes !== undefined && ` · свободно ${gb(client.storage.freeBytes)}`}
            </div>
          </div>

          <div className="ps-list">
            {client.projects.length === 0 && <div className="dim acct-note">Проектов в этой среде нет — создайте из новой сессии («+» → проект → «Новый проект…»).</div>}
            {client.projects.map((p) => {
              const sc = here?.projects.find((x) => x.id === p.id);
              const key = `p:${p.id}`;
              return (
                <div key={p.id} className="ps-row">
                  <div className="ps-row-head">
                    <ProjectTag name={p.name} />
                    <span className="spacer" />
                    {sc && !sc.exists && <span className="np-chip tone-err">папки нет</span>}
                    {sc && sc.exists && !sc.inStorage && <span className="np-chip tone-warn" data-tip="Папка вне хранилища — проект работает, но в другой среде папка по имени не найдётся сама">вне хранилища</span>}
                    {sc?.git && <span className="np-chip tone-info">{sc.git.branch ?? 'git'}{sc.git.changed > 0 ? ` · изменено ${sc.git.changed}` : ''}</span>}
                  </div>
                  <div className="mono dim ps-path">{p.path}</div>
                  {sc?.git?.origin && <div className="dim ps-path">origin: {sc.git.origin}</div>}
                  <div className="ps-actions">
                    {sc && !sc.exists && <button className="btn sm" disabled={busy !== ''} onClick={() => void run(key, () => client.mkdirProject(p.id))}>Создать папку</button>}
                    {confirmDel === p.id
                      ? <>
                          <span className="dim">Убрать «{p.name}» из списка? Папка на диске останется.</span>
                          <button className="btn sm stop" disabled={busy !== ''} onClick={() => void run(key, async () => { await client.deleteProject(p.id); setConfirmDel(null); })}>Убрать</button>
                          <button className="btn sm" onClick={() => setConfirmDel(null)}>Нет</button>
                        </>
                      : <button className="link-btn" onClick={() => setConfirmDel(p.id)}>убрать из списка</button>}
                  </div>
                </div>
              );
            })}
          </div>

          {other && missingHere.length > 0 && (
            <div className="acct ps-missing">
              <div className="acct-head"><Icon name={isRemote(other) ? 'server' : 'laptop'} /><b>Есть в «{envLabel(other)}», нет здесь</b></div>
              {missingHere.map((p) => {
                const origin = originOf(p.id);
                const slug = projectSlug(p.name);
                const key = `m:${p.name}`;
                return (
                  <div key={p.id} className="ps-row">
                    <div className="ps-row-head">
                      <ProjectTag name={p.name} />
                      <span className="spacer" />
                      {origin && <button className="btn sm" disabled={busy !== ''} onClick={() => void run(key, () => client.createProject({ name: p.name, source: 'git', gitUrl: origin, slug }))}>{busy === key ? 'Клонирую…' : 'Склонировать сюда'}</button>}
                      <button className="btn sm" disabled={busy !== ''} onClick={() => void run(key, () => client.createProject({ name: p.name, source: 'empty', slug }))}>Создать здесь</button>
                    </div>
                    <div className="mono dim ps-path">{root ? join(root, slug) : ''}{origin ? ` · из ${origin}` : ''}</div>
                  </div>
                );
              })}
            </div>
          )}

          {here && here.orphans.length > 0 && (
            <div className="acct ps-orphans">
              <div className="acct-head"><Icon name="folderOpen" /><b>В хранилище есть папки без проекта</b></div>
              <div className="ps-actions">
                {here.orphans.map((name) => (
                  <button key={name} className="btn sm" disabled={busy !== ''} onClick={() => void run(`o:${name}`, () => client.createProject({ name, source: 'existing', path: join(root, name) }))}>
                    <Icon name="plus" size={12} /> {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {err && <div className="err-text acct-err" role="alert">{err}</div>}
    </div>
  );
}
