// Вкладка «Порты» (как Ports в VS Code Remote SSH): что слушает машина подключения, что проброшено сюда,
// ручной проброс и снятие, автопроброс новых dev-серверов. У «этого компьютера» проброс не нужен —
// порты открываются как есть.
import { useEffect, useState, type FormEvent } from 'react';
import { envLabel, isRemote, type SessionView, type SupervisorClient } from '../supervisor';
import { ports, ownPorts } from '../ports';
import { localAddress, portRows } from '../lib/portsModel';
import { panelErrorText, type PortInfo } from '../lib/panelData';
import { procName } from '../lib/browserNav';
import { Icon } from './Icon';

function ipcError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function openExternal(url: string): void {
  const ipc = window.perimeterIPC;
  if (ipc?.openExternal) void ipc.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

export function PortsTab({ session, client, onOpenInBrowser }: {
  session: SessionView;
  client: SupervisorClient;
  /** открыть адрес (порт машины подключения) во вкладке «Браузер» */
  onOpenInBrowser: (url: string) => void;
}) {
  const env = client.environment;
  const remote = isRemote(env);
  const live = client.status === 'live';
  const [, setTick] = useState(0);
  useEffect(() => { ports.start(); return ports.subscribe(() => setTick((t) => t + 1)); }, []);

  const [list, setList] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; items: PortInfo[]; error?: string }>({ status: 'idle', items: [] });
  const load = () => {
    setList((l) => ({ ...l, status: 'loading' }));
    client.netPorts(session.id).then(
      (items) => setList({ status: 'ok', items }),
      (e: unknown) => setList({ status: 'error', items: [], error: panelErrorText(e) }),
    );
  };
  // пока вкладка открыта — список свежий (раз в 5 с), как в VS Code
  useEffect(() => {
    if (!live) return;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [client, live, session.id]);

  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [manual, setManual] = useState('');
  const can = remote && ports.available;

  // подписи портов (localStorage) и «открыть браузер после проброса» — свои, на машину владельца
  const [labels, setLabels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('perimeter:port-labels') ?? '{}') as Record<string, string>; } catch { return {}; }
  });
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [openOnForward, setOpenOnForward] = useState(localStorage.getItem('perimeter:port-open') !== 'off');
  const labelOf = (port: number) => labels[`${env}:${port}`];
  const saveLabel = (port: number) => {
    const next = { ...labels };
    const v = draft.trim();
    if (v === '') delete next[`${env}:${port}`];
    else next[`${env}:${port}`] = v;
    setLabels(next);
    localStorage.setItem('perimeter:port-labels', JSON.stringify(next));
    setEditing(null);
  };

  const forward = async (port: number) => {
    setBusy(port);
    setErr('');
    try {
      const url = await ports.forward(env, port);
      if (openOnForward && url) openExternal(url);
    } catch (e) { setErr(`Порт ${port}: ${ipcError(e)}`); } finally { setBusy(null); }
  };
  const unforward = async (port: number) => {
    setBusy(port);
    setErr('');
    try { await ports.unforward(env, port); } catch (e) { setErr(`Порт ${port}: ${ipcError(e)}`); } finally { setBusy(null); }
  };
  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(manual.replace(/^:/, '').trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) { setErr('Номер порта — от 1 до 65535'); return; }
    setManual('');
    void forward(n);
  };

  const all = portRows(list.items, ports.forwards, env, ownPorts(env));
  // на виду: проброшенные, dev-серверы и всё, что слушает порт от 1024 (docker, приложения других
  // пользователей — их процесс не виден, но это тоже чьи-то веб-интерфейсы); системные (<1024) — по кнопке
  const [showAll, setShowAll] = useState(false);
  const main = all.filter((r) => r.forward || r.dev || r.port >= 1024);
  const rest = all.length - main.length;
  const rows = showAll ? all : main;
  const auto = ports.autoForward(env);

  return (
    <div className="ports-tab">
      <div className="ports-head">
        <div className="ports-title">
          <Icon name={remote ? 'server' : 'laptop'} size={14} />
          <b>Порты · {envLabel(env)}</b>
          <span className="dim">{remote ? (can ? 'пробрасываются сюда по ssh' : 'проброс — в приложении') : 'открываются напрямую'}</span>
        </div>
        <span className="spacer" />
        {can && (
          <label className="ports-auto" data-tip="Новые dev-серверы (node, vite, python…) на VPS пробрасываются сюда сами, как в VS Code">
            <input type="checkbox" checked={auto} onChange={(e) => ports.setAutoForward(env, e.target.checked)} /> автопроброс
          </label>
        )}
        {can && (
          <label className="ports-auto" data-tip="После проброса — сразу открыть адрес во внешнем браузере">
            <input type="checkbox" checked={openOnForward} onChange={(e) => { setOpenOnForward(e.target.checked); localStorage.setItem('perimeter:port-open', e.target.checked ? 'on' : 'off'); }} /> открывать
          </label>
        )}
        <button className={`icon-btn sm ${live ? '' : 'is-disabled'}`} aria-disabled={!live} onClick={() => live && load()} aria-label="Обновить список портов" data-tip="Обновить список">
          <Icon name={list.status === 'loading' ? 'loader' : 'refresh'} size={14} className={list.status === 'loading' ? 'spin' : ''} />
        </button>
      </div>

      {can && (
        <form className="ports-manual" onSubmit={submitManual}>
          <span className="dim">Пробросить порт</span>
          <input className="mono" value={manual} onChange={(e) => setManual(e.target.value.replace(/[^\d:]/g, ''))} placeholder="3000" inputMode="numeric" maxLength={6} aria-label="Номер порта" />
          <button className="btn sm" type="submit" disabled={!manual.trim() || busy !== null}>Пробросить</button>
        </form>
      )}
      {err && <div className="err-text ports-note" role="alert">{err}</div>}
      {!live && <div className="warn-text ports-note">Нет связи с «{envLabel(env)}» — список обновится после подключения.</div>}
      {list.status === 'error' && <div className="err-text ports-note">{list.error}</div>}

      <div className="ports-table" role="table" aria-label="Порты">
        <div className="ports-row head" role="row">
          <span role="columnheader">Порт</span>
          <span role="columnheader">Процесс</span>
          <span role="columnheader">{remote ? 'Адрес здесь' : 'Адрес'}</span>
          <span role="columnheader" />
        </div>
        {rows.length === 0 && list.status === 'ok' && (
          <div className="ports-empty dim">Dev-серверов не слушает — запустите его (например, в Терминале), он появится здесь.</div>
        )}
        {rows.map((r) => {
          const here = remote ? r.forward?.url : `http://localhost:${r.port}`;
          const isAuto = ports.auto.has(`${env}:${r.port}`);
          return (
            <div key={r.port} className={`ports-row ${r.forward ? 'fwd' : ''} ${r.listening ? '' : 'gone'}`} role="row">
              <span className="mono ports-port" role="cell" onDoubleClick={() => { setEditing(r.port); setDraft(labelOf(r.port) ?? ''); }} data-tip="Двойной клик — своя подпись порту" title="">
                {r.forward && <span className="dot dot-green" />}:{r.port}
                {editing === r.port
                  ? (
                    <input
                      className="ports-label-input"
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => saveLabel(r.port)}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') saveLabel(r.port); if (e.key === 'Escape') setEditing(null); }}
                      aria-label={`Подпись порта ${r.port}`}
                    />
                  )
                  : labelOf(r.port) !== undefined && <span className="ports-label">{labelOf(r.port)}</span>}
              </span>
              <span className="ports-proc" role="cell" title={r.process ?? ''}>
                {r.listening ? (r.process ? procName(r.process) : <span className="dim">—</span>) : <span className="dim">не слушает</span>}
                {r.host && r.host !== '127.0.0.1' && r.host !== '::1' && r.host !== 'localhost' && <span className="dim"> · {r.host}</span>}
              </span>
              <span className="ports-addr" role="cell">
                {here
                  ? <button className="link-btn mono" onClick={() => openExternal(here)} data-tip={`Открыть ${here} во внешнем браузере`}>{localAddress(here)}</button>
                  : <span className="dim">—</span>}
                {isAuto && <span className="ports-tag" data-tip="Проброшен автоматически">авто</span>}
              </span>
              <span className="ports-actions" role="cell">
                {r.listening && (
                  <button className="icon-btn sm" onClick={() => onOpenInBrowser(`http://localhost:${r.port}/`)} aria-label={`Открыть :${r.port} во вкладке «Браузер»`} data-tip="Открыть во вкладке «Браузер»">
                    <Icon name="globe" size={14} />
                  </button>
                )}
                {can && !r.forward && r.listening && (
                  <button className="btn sm" disabled={busy !== null} onClick={() => void forward(r.port)}>
                    {busy === r.port ? <Icon name="loader" size={12} className="spin" /> : null} Пробросить
                  </button>
                )}
                {can && r.forward && (
                  <button className="icon-btn sm" disabled={busy !== null} onClick={() => void unforward(r.port)} aria-label={`Снять проброс :${r.port}`} data-tip="Снять проброс (автопроброс этот порт больше не тронет)">
                    <Icon name={busy === r.port ? 'loader' : 'x'} size={14} className={busy === r.port ? 'spin' : ''} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {rest > 0 && (
          <button className="ports-more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
            <Icon name={showAll ? 'chevronDown' : 'chevronRight'} size={14} />
            {showAll ? 'Скрыть системные порты' : `Ещё портов: ${rest} — системные (ssh, dns, 80/443…)`}
          </button>
        )}
      </div>
      {remote && !ports.available && (
        <div className="dim ports-note">
          В браузере-стенде ssh-туннеля нет: проброс и автопроброс работают в приложении perimeter.
        </div>
      )}
    </div>
  );
}
