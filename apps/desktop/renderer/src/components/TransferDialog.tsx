// Диалог переноса сессии между средами (T1): откуда → куда, что переедет, галочка правок
// с предупреждением о расхождении веток. Сам перенос — lib/transferModel, итог (T2) —наружу.
import { useEffect, useMemo, useState } from 'react';
import { envLabel, type ClientSet, type EnvId, type SessionView } from '../supervisor';
import { planTransfer, runTransfer, type TransferPlan } from '../lib/transferModel';
import { useEscape } from './ui';

export interface TransferDone {
  srcEnv: EnvId;
  srcSid: string;
  dstEnv: EnvId;
  dstSid: string;
  /** новые файлы без git на источнике — не переехали (для предупреждения в тосте) */
  untracked: number;
}

/** HEAD папки проекта (нужен сверке баз патча); null — не git или папки нет. */
async function headOf(clients: ClientSet, env: EnvId, path: string | undefined): Promise<string | null> {
  if (path === undefined) return null;
  try {
    const plan = await clients.get(env).inspectProject({ source: 'existing', path });
    return plan.git?.head ?? null;
  } catch {
    return null;
  }
}

export function TransferDialog({ clients, envs, fromEnv, sessionId, onDone, onClose }: {
  clients: ClientSet;
  envs: EnvId[];
  fromEnv: EnvId;
  sessionId: string;
  onDone: (r: TransferDone) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const src = clients.get(fromEnv);
  const session = src.sessions.get(sessionId) as SessionView | undefined;
  const targets = envs.filter((e) => e !== fromEnv && clients.get(e).status === 'live');
  const [dstEnv, setDstEnv] = useState<EnvId | null>(targets[0] ?? null);
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [dirty, setDirty] = useState(0); // незакоммиченные правки источника (для галочки)
  const [withPatch, setWithPatch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const srcProject = useMemo(
    () => (session?.projectId !== undefined ? src.projects.find((p) => p.id === session.projectId) : undefined),
    [src, session?.projectId],
  );

  // план: проекты/аккаунты цели + сверка HEAD обеих сторон (для патча правок)
  useEffect(() => {
    if (session === undefined) { setPlan(null); return; }
    if (dstEnv === null) { setPlan(null); return; }
    let live = true;
    void (async () => {
      const dst = clients.get(dstEnv);
      const dstProject = srcProject !== undefined ? dst.projects.find((p) => p.name === srcProject.name) : undefined;
      const [srcHead, dstHead] = await Promise.all([
        headOf(clients, fromEnv, srcProject?.path),
        headOf(clients, dstEnv, dstProject?.path),
      ]);
      if (!live) return;
      setPlan(planTransfer({
        session,
        ...(srcProject !== undefined ? { srcProject } : {}),
        dstProjects: dst.projects,
        dstProfiles: dst.profiles,
        srcHead,
        dstHead,
      }));
    })();
    return () => { live = false; };
  }, [clients, fromEnv, dstEnv, srcProject, session]);

  // незакоммиченные правки источника — счётчик у галочки патча
  useEffect(() => {
    if (session === undefined || src.status !== 'live') { setDirty(0); return; }
    let live = true;
    void src.gitStatus(session.id).then((g) => { if (live) setDirty(g?.files.length ?? 0); }, () => undefined);
    return () => { live = false; };
  }, [src, session, src.status]);

  if (session === undefined) return null;

  const go = async () => {
    if (dstEnv === null || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await runTransfer(src, clients.get(dstEnv), dstEnv, session.id, plan ?? planTransfer({
        session, dstProjects: [], dstProfiles: [], srcHead: null, dstHead: null,
      }), {
        withPatch: withPatch && (plan?.patchAllowed ?? false),
        dstLabel: envLabel(dstEnv),
        srcLabel: envLabel(fromEnv),
      });
      onDone({ srcEnv: fromEnv, srcSid: session.id, dstEnv, dstSid: r.sessionId, untracked: r.source.untracked.length });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'перенос не удался');
      setBusy(false);
    }
  };

  const busySession = session.state !== 'idle' && session.state !== 'dead';
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-label="Перенести сессию" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Перенести сессию</div>
        <p className="dim sync-lead">
          «{session.name}» переедет на другую сторону целиком: история и настройки, проект свяжется по названию.
          {' '}Процесс здесь остановится, сессия уйдёт в архив с пометкой «переехала».
        </p>
        {targets.length === 0
          ? <div className="warn-text">Нет другой подключённой среды — перенести некуда.</div>
          : <>
            <div className="field-row">
              <label className="field">
                <span>Откуда</span>
                <select value={fromEnv} disabled><option value={fromEnv}>{envLabel(fromEnv)}</option></select>
              </label>
              <label className="field">
                <span>Куда</span>
                <select value={dstEnv ?? ''} onChange={(e) => setDstEnv(e.target.value)}>
                  {targets.map((t) => <option key={t} value={t}>{envLabel(t)}</option>)}
                </select>
              </label>
            </div>
            <div className="sync-row">
              <div className="sync-row-head"><span className="sync-name">Что переедет</span></div>
              <div className="dim">История разговора · настройки (аккаунт, модель, режим) · проект «{srcProject?.name ?? 'без проекта'}» по названию</div>
              {plan?.createProject !== null && plan?.createProject !== undefined && (
                <div className="warn-text">Проекта на цели нет — создам пустую папку в хранилище; незакоммиченные правки не перенесу.</div>
              )}
              {plan !== null && plan.projectName !== undefined && plan.createProject === null && (
                <label className="field-inline" style={{ marginTop: 8 }}>
                  <input type="checkbox" checked={withPatch && plan.patchAllowed} disabled={!plan.patchAllowed || dirty === 0} onChange={(e) => setWithPatch(e.target.checked)} />
                  <span>
                    Незакоммиченные правки ({dirty}) — патчем
                    {plan.base === 'diverged' && <span className="warn-text"> · ветки разошлись: не перенесу, только история</span>}
                    {plan.base === 'nogit' && <span className="dim"> · папка не в git — патч невозможен</span>}
                  </span>
                </label>
              )}
              {plan !== null && !plan.profileKnown && (
                <div className="warn-text">Аккаунта «{session.profile}» на цели нет — сессия поедет с аккаунтом цели.</div>
              )}
            </div>
            {busySession && <div className="warn-text">Сессия работает — дождитесь конца хода, иначе перенос отменится.</div>}
            {error !== '' && <div className="err-text">{error}</div>}
            <div className="modal-actions">
              <span className="dim field-hint">Первое сообщение на цели поднимет сессию с полной историей</span>
              <span className="spacer" />
              <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
              <button className="btn primary" onClick={() => void go()} disabled={busy || dstEnv === null || busySession || plan === null}>
                {busy ? 'Переносим…' : `Перенести → ${dstEnv !== null ? envLabel(dstEnv) : ''}`}
              </button>
            </div>
          </>}
      </div>
    </div>
  );
}
