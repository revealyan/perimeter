import { useEffect, useState } from 'react';
import { envLabel, type SupervisorClient, type SyncSuggestion } from '../supervisor';
import { useEscape } from './ui';
import { guessPath } from '../lib/sync';

function Row({ sug, client }: { sug: SyncSuggestion; client: SupervisorClient }) {
  const local = client.environment === 'local';
  const [path, setPath] = useState(() => guessPath(sug, client.projects));
  const [exists, setExists] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const ipc = window.perimeterIPC;

  // на этом компьютере проверяем, что папка есть (на VPS проверит supervisor при запуске сессии)
  useEffect(() => {
    if (!local || !ipc?.pathExists || path.trim() === '') { setExists(null); return; }
    let live = true;
    void ipc.pathExists(path.trim()).then((ok) => { if (live) setExists(ok); });
    return () => { live = false; };
  }, [path, local]);

  const link = async () => {
    if (!path.trim()) return;
    setBusy(true);
    await client.linkProject(sug, path.trim());
    setBusy(false);
  };

  return (
    <div className="sync-row">
      <div className="sync-row-head">
        <span className="sync-name">{sug.name}</span>
        <span className="dim mono">{envLabel(sug.otherEnv)}: {sug.otherPath}</span>
      </div>
      <div className="field-inline">
        <input
          className="mono"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={local ? 'папка на этом компьютере' : 'путь на сервере, например /opt/…'}
          aria-label={`Папка проекта ${sug.name} здесь`}
        />
        {local && ipc?.pickFolder && (
          <button className="btn" type="button" onClick={() => void ipc.pickFolder().then((p) => { if (p) setPath(p); })}>Выбрать…</button>
        )}
      </div>
      <div className="sync-row-foot">
        {exists === true && <span className="ok-text">папка найдена</span>}
        {exists === false && <span className="warn-text">такой папки здесь нет</span>}
        <span className="spacer" />
        <button className="btn danger-ghost" type="button" onClick={() => client.dismissSync(sug.name)}>Не предлагать</button>
        <button className="btn primary" type="button" disabled={busy || path.trim() === '' || exists === false} onClick={() => void link()}>
          {busy ? 'Привязываем…' : 'Привязать'}
        </button>
      </div>
    </div>
  );
}

/** Синк проектов между средами: проект связан по имени, у каждой среды своя папка. */
export function SyncDialog({ client, onClose }: { client: SupervisorClient; onClose: () => void }) {
  useEscape(onClose);
  const from = [...new Set(client.syncSuggestions.map((s) => s.otherEnv))];
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-label="Синк проектов" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Синк проектов</div>
        <p className="dim sync-lead">
          Проекты из {from.length === 1 ? `«${envLabel(from[0]!)}»` : 'других подключений'}, которых нет в «{envLabel(client.environment)}».
          Проект связан по имени, а папка у каждой среды своя — укажите, где он лежит здесь.
          Сессии и их история остаются в своей среде.
        </p>
        {client.syncSuggestions.length === 0
          ? <div className="dim">Всё связано — предложений нет.</div>
          : client.syncSuggestions.map((s) => <Row key={s.name} sug={s} client={client} />)}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
  );
}
