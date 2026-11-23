// «Новый проект» (макеты P1/P2): проект — это имя, папку supervisor создаёт сам в хранилище каждой выбранной среды.
// Источник: пустой (папка по имени) · из git (клон; если там уже лежит тот же репозиторий — подключим) · готовая папка.
// Для каждой среды до нажатия «Создать» видно, что будет: создам / склонирую / подключу / занято.
import { useEffect, useMemo, useState } from 'react';
import type { EnvId, ProjectPlan, ProjectSource, SupervisorClient, ClientSet } from '../supervisor';
import { CmdError, envLabel, isRemote } from '../supervisor';
import { SLUG_RE, looksLikeGitUrl, projectSlug, repoNameFromUrl } from '../lib/naming';
import { Icon } from './Icon';
import { useEscape } from './ui';

type PlanState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; plan: ProjectPlan } | { kind: 'err'; text: string };
type RunState = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; action: string } | { kind: 'err'; text: string };

const SOURCES: Array<{ id: ProjectSource; label: string; icon: 'plus' | 'gitBranch' | 'folder' }> = [
  { id: 'empty', label: 'Пустой', icon: 'plus' },
  { id: 'git', label: 'Из git', icon: 'gitBranch' },
  { id: 'existing', label: 'Готовая папка', icon: 'folder' },
];

function errText(e: unknown): string {
  if (e instanceof CmdError && e.code === 'TIMEOUT') return 'supervisor не ответил вовремя — связь медленная';
  return e instanceof Error ? e.message : String(e);
}

/** Что будет с папкой — коротко для чипа. */
function planChip(p: ProjectPlan): { text: string; tone: 'ok' | 'info' | 'warn' | 'err' } {
  switch (p.plan) {
    case 'create': return { text: 'создам папку', tone: 'info' };
    case 'clone': return { text: 'склонирую', tone: 'info' };
    case 'connect': return p.git?.origin ? { text: 'уже есть — подключу', tone: 'ok' } : p.exists && !p.empty ? { text: 'папка есть — подключу как есть', tone: 'ok' } : { text: 'подключу', tone: 'ok' };
    case 'conflict': return { text: p.reason ? `занято: ${p.reason}` : 'папка занята', tone: 'err' };
    case 'missing': return { text: 'папки нет', tone: 'err' };
  }
}

export function NewProjectDialog({ clients, envs, initialEnv, onClose, onCreated }: {
  clients: ClientSet;
  envs: EnvId[];
  initialEnv: EnvId;
  onClose: () => void;
  /** id созданных проектов по средам */
  onCreated: (ids: Partial<Record<EnvId, string>>) => void;
}) {
  useEscape(onClose);
  const [source, setSource] = useState<ProjectSource>('empty');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [slugOverride, setSlugOverride] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [paths, setPaths] = useState<Partial<Record<EnvId, string>>>({});
  // по умолчанию — все подключённые среды (одинаковое имя → одинаковая папка → перенос сессий без настройки)
  const [targets, setTargets] = useState<Record<EnvId, boolean>>(() =>
    Object.fromEntries(envs.map((e) => [e, e === initialEnv || clients.get(e).status === 'live'])));
  const [plans, setPlans] = useState<Partial<Record<EnvId, PlanState>>>({});
  const [runs, setRuns] = useState<Partial<Record<EnvId, RunState>>>({});
  const [busy, setBusy] = useState(false);

  // из git — название из ссылки, пока его не правили руками
  const effName = source === 'git' && !nameTouched ? repoNameFromUrl(gitUrl) : name;
  const slug = slugOverride ?? projectSlug(effName);
  const slugOk = SLUG_RE.test(slug);
  const urlOk = source !== 'git' || looksLikeGitUrl(gitUrl);
  const chosen = envs.filter((e) => targets[e]);

  const query = useMemo(() => {
    const out: Partial<Record<EnvId, { source: ProjectSource; slug?: string; path?: string; gitUrl?: string } | null>> = {};
    for (const e of envs) {
      const custom = (paths[e] ?? '').trim();
      if (source === 'existing') { out[e] = custom ? { source, path: custom } : null; continue; }
      if (!custom && (!effName.trim() || !slugOk)) { out[e] = null; continue; }
      if (source === 'git' && !urlOk) { out[e] = null; continue; }
      out[e] = { source, ...(custom ? { path: custom } : { slug }), ...(source === 'git' ? { gitUrl: gitUrl.trim() } : {}) };
    }
    return out;
  }, [envs, source, paths, effName, slugOk, slug, urlOk, gitUrl]);

  // Превью по средам — с паузой в наборе. Перезапрос только когда поменялся сам запрос или связь среды:
  // envs/clients приходят новыми на каждое событие supervisor'а — по ним превью моргало «проверяю…» ↔ итог по кругу.
  const planKey = JSON.stringify(envs.map((e) => {
    const c = clients.get(e);
    return [e, targets[e] ? query[e] ?? null : null, c.status === 'live' && c.storage ? c.storage.root : null];
  }));
  useEffect(() => {
    let alive = true; // ответ на устаревший запрос (ввод уже другой) не перетирает свежий
    const t = setTimeout(() => {
      for (const e of envs) {
        const q = query[e];
        const c = clients.get(e);
        if (!targets[e] || !q || c.status !== 'live' || !c.storage) { setPlans((p) => ({ ...p, [e]: { kind: 'idle' } })); continue; }
        setPlans((p) => ({ ...p, [e]: { kind: 'loading' } }));
        void c.inspectProject(q).then(
          (plan) => { if (alive) setPlans((p) => ({ ...p, [e]: { kind: 'ok', plan } })); },
          (err: unknown) => { if (alive) setPlans((p) => ({ ...p, [e]: { kind: 'err', text: errText(err) } })); },
        );
      }
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [planKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const planOk = (e: EnvId) => {
    const st = plans[e];
    return st?.kind === 'ok' && st.plan.plan !== 'conflict' && st.plan.plan !== 'missing';
  };
  const canCreate = !busy && effName.trim() !== '' && chosen.length > 0 && urlOk && chosen.every(planOk);

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    const ids: Partial<Record<EnvId, string>> = {};
    let failed = false;
    for (const e of chosen) {
      if (runs[e]?.kind === 'done') continue; // повтор после частичной ошибки — уже созданное не трогаем
      setRuns((r) => ({ ...r, [e]: { kind: 'running' } }));
      const custom = (paths[e] ?? '').trim();
      try {
        const res = await clients.get(e).createProject({
          name: effName.trim(),
          source,
          ...(custom ? { path: custom } : source === 'existing' ? {} : { slug }),
          ...(source === 'git' ? { gitUrl: gitUrl.trim() } : {}),
        });
        ids[e] = res.project.id;
        setRuns((r) => ({ ...r, [e]: { kind: 'done', action: res.action } }));
      } catch (err) {
        failed = true;
        setRuns((r) => ({ ...r, [e]: { kind: 'err', text: errText(err) } }));
      }
    }
    setBusy(false);
    if (!failed) onCreated(ids);
  };

  const pickFolder = async (e: EnvId) => {
    const p = await window.perimeterIPC?.pickFolder?.();
    if (p) setPaths((x) => ({ ...x, [e]: p }));
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal np" role="dialog" aria-label="Новый проект" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="modal-title">Новый проект</div>
        <p className="dim np-sub">Проект — это папка с кодом. {source === 'existing' ? 'Подключим папку, которая уже есть.' : 'Папку создадим сами в выбранных средах — путь вводить не нужно.'}</p>

        <div className="seg env-seg np-source" role="radiogroup" aria-label="Откуда проект">
          {SOURCES.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={source === s.id} className={source === s.id ? 'on' : ''} onClick={() => setSource(s.id)}>
              <Icon name={s.icon} size={14} /> {s.label}
            </button>
          ))}
        </div>

        {source === 'git' && (
          <label className="field">
            <span>Ссылка на репозиторий</span>
            <input className="mono" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="git@github.com:owner/repo.git" autoFocus spellCheck={false} />
            {gitUrl.trim() !== '' && !urlOk && <span className="err-text field-hint">Не похоже на ссылку git (https://…, ssh://… или git@host:owner/repo)</span>}
          </label>
        )}

        <label className="field">
          <span>Название</span>
          <input
            value={effName}
            onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
            placeholder={source === 'git' ? 'из ссылки' : 'например: лендинг студии'}
            autoFocus={source !== 'git'}
          />
          {source !== 'existing' && (
            <span className="np-slug field-hint">
              <span className="dim">Папка</span>
              {slugOverride === null
                ? <><code className="np-slug-chip">{slug}</code><span className="dim">— из названия латиницей</span><button type="button" className="link-btn" onClick={() => setSlugOverride(slug)}>Изменить</button></>
                : <><input className="mono np-slug-input" value={slugOverride} onChange={(e) => setSlugOverride(e.target.value.toLowerCase())} spellCheck={false} aria-label="Имя папки" />
                  <button type="button" className="link-btn" onClick={() => setSlugOverride(null)}>как в названии</button>
                  {!slugOk && <span className="err-text">латиница, цифры, . _ -</span>}</>}
            </span>
          )}
        </label>

        <div className="field">
          <span>{source === 'existing' ? 'Папка в каждой среде' : 'Где создать'}</span>
          <div className="np-envs">
            {envs.map((e) => {
              const c = clients.get(e);
              const live = c.status === 'live';
              const old = live && !c.storage;
              const st = plans[e];
              const run = runs[e];
              const on = targets[e];
              const chip = st?.kind === 'ok' ? planChip(st.plan) : null;
              const shownPath = st?.kind === 'ok' ? st.plan.path
                : (paths[e] ?? '').trim() || (source !== 'existing' && c.storage ? `${c.storage.root}${c.storage.root.includes('\\') ? '\\' : '/'}${slug}` : '');
              return (
                <div key={e} className={`np-env ${on ? 'on' : ''}`}>
                  <label className="np-env-head">
                    <input type="checkbox" checked={on} disabled={busy || !live || old} onChange={(ev) => setTargets((t) => ({ ...t, [e]: ev.target.checked }))} />
                    <Icon name={isRemote(e) ? 'server' : 'laptop'} />
                    <b>{envLabel(e)}</b>
                    <span className="spacer" />
                    {!live && <span className="dim">нет связи</span>}
                    {old && <span className="warn-text">старый supervisor — обновите</span>}
                    {live && !old && on && st?.kind === 'loading' && <span className="dim">проверяю…</span>}
                    {live && !old && on && chip && run?.kind !== 'done' && run?.kind !== 'running' && <span className={`np-chip tone-${chip.tone}`}>{chip.text}</span>}
                    {run?.kind === 'running' && <span className="np-chip tone-info">{source === 'git' ? 'клонирую…' : 'создаю…'}</span>}
                    {run?.kind === 'done' && <span className="np-chip tone-ok">готово</span>}
                  </label>
                  {on && source === 'existing' && (
                    <div className="field-inline np-path-edit">
                      <input className="mono" value={paths[e] ?? ''} onChange={(ev) => setPaths((x) => ({ ...x, [e]: ev.target.value }))} placeholder={e === 'local' ? 'C:\\путь\\к\\папке' : '/home/…/папка'} spellCheck={false} />
                      {e === 'local' && window.perimeterIPC?.pickFolder && <button type="button" className="btn sm" onClick={() => void pickFolder(e)}><Icon name="folder" size={12} /> Выбрать</button>}
                    </div>
                  )}
                  {on && source !== 'existing' && shownPath && <div className="mono dim np-path">{shownPath}</div>}
                  {on && st?.kind === 'ok' && st.plan.git?.origin && <div className="dim np-path">git: {st.plan.git.origin}{st.plan.git.branch ? ` · ${st.plan.git.branch}` : ''}{st.plan.git.changed > 0 ? ` · изменено ${st.plan.git.changed}` : ''}</div>}
                  {on && st?.kind === 'err' && <div className="err-text np-path">{st.text}</div>}
                  {run?.kind === 'err' && <div className="err-text np-path">{run.text}</div>}
                </div>
              );
            })}
          </div>
          {source !== 'existing' && chosen.length > 1 && <span className="dim field-hint">{chosen.length === 2 ? 'В обеих средах' : 'Во всех выбранных средах'} — одна и та же папка по имени, поэтому сессии проекта потом можно переносить между ними.</span>}
        </div>

        {source !== 'existing' && (
          <div className="np-adv">
            <button type="button" className="link-btn np-adv-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={12} /> Дополнительно <span className="dim">— своя папка вместо хранилища</span>
            </button>
            {advanced && envs.filter((e) => targets[e]).map((e) => (
              <label key={e} className="field np-adv-row">
                <span>{envLabel(e)} — своя папка (пусто — в хранилище)</span>
                <span className="field-inline">
                  <input className="mono" value={paths[e] ?? ''} onChange={(ev) => setPaths((x) => ({ ...x, [e]: ev.target.value }))} placeholder={clients.get(e).storage ? `${clients.get(e).storage!.root}…` : ''} spellCheck={false} />
                  {e === 'local' && window.perimeterIPC?.pickFolder && <button type="button" className="btn sm" onClick={() => void pickFolder(e)}><Icon name="folder" size={12} /></button>}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={!canCreate}>{busy ? (source === 'git' ? 'Клонирую…' : 'Создаю…') : 'Создать проект'}</button>
        </div>
      </form>
    </div>
  );
}
