// Блок «Supervisor на сервере» в настройках подключения VPS (АДР 004): что стоит на сервере и у приложения,
// «Установить/Обновить», «Откатить», ход установки строками. Само ничего не ставит — только по кнопке.
import { useEffect, useRef, useState } from 'react';
import type { Conn } from '../connections';
import { describeServer, packagesLine, type ServerStatus } from '../lib/serverInstallModel';

const TONE_CLASS = { ok: 'ok-text', warn: 'warn-text', err: 'err-text', dim: 'dim' } as const;

/** Ошибка из моста Electron приходит с префиксом «Error invoking remote method …: Error: » — показываем суть. */
const errText = (e: unknown): string => {
  const t = e instanceof Error ? e.message : String(e);
  const i = t.lastIndexOf('Error: ');
  return i >= 0 ? t.slice(i + 7) : t;
};

export function ServerInstall({ conn }: { conn: Conn }) {
  const ipcM = window.perimeterIPC;
  const [st, setSt] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState<'' | 'status' | 'install' | 'rollback' | 'packages'>('');
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [user, setUser] = useState(conn.serviceUser ?? '');
  /** вторая кнопка при идущих ходах: «Всё равно …» */
  const [confirm, setConfirm] = useState<'' | 'install' | 'rollback'>('');
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = async (): Promise<void> => {
    if (!ipcM?.serverStatus) return;
    setBusy('status');
    try {
      const s = await ipcM.serverStatus(conn.id);
      setSt(s);
      if (s.serviceUser) setUser((u) => u || s.serviceUser || '');
    } catch (e) {
      setSt({ ok: false, message: errText(e) });
    } finally {
      setBusy('');
    }
  };

  useEffect(() => { void refresh(); }, [conn.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => ipcM?.onServerLog?.((m) => {
    if (m.connId === conn.id) setLog((l) => [...l.slice(-300), m.line]);
  }), [conn.id, ipcM]);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [log]);

  if (!ipcM?.serverStatus) return null;
  const v = st ? describeServer(st) : null;

  const run = async (kind: 'install' | 'rollback' | 'packages'): Promise<void> => {
    if (kind !== 'packages' && (st?.busy ?? 0) > 0 && confirm !== kind) { setConfirm(kind); return; }
    setConfirm('');
    setBusy(kind);
    setLog([]);
    setResult(null);
    try {
      const r = kind === 'install'
        ? await ipcM.serverInstall!(conn.id, st?.mode === 'system' ? user.trim() : undefined)
        : kind === 'rollback'
          ? await ipcM.serverRollback!(conn.id)
          : await ipcM.serverPackages!(conn.id, st?.packagesMissing ?? []);
      setResult({ ok: r.ok, text: r.message });
    } catch (e) {
      setResult({ ok: false, text: errText(e) });
    } finally {
      setBusy('');
      void refresh();
    }
  };

  const label = (kind: 'install' | 'rollback', text: string): string => {
    if (busy === kind) return kind === 'install' ? 'Ставлю…' : 'Откатываю…';
    return confirm === kind ? `Всё равно: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
  };

  return (
    <section className="srv-box" aria-label="Supervisor на сервере">
      <div className="srv-head">
        <span className="srv-title">Supervisor на сервере</span>
        <span className="spacer" />
        <button className="btn sm" disabled={busy !== ''} onClick={() => void refresh()}>{busy === 'status' ? 'Проверяю…' : 'Проверить'}</button>
      </div>
      {!v || !st ? (
        <div className="dim acct-note">{busy === 'status' ? 'смотрю, что стоит на сервере…' : ''}</div>
      ) : (
        <>
          <div className={`${TONE_CLASS[v.tone]} srv-line`}>{v.text}</div>
          {st.ok && (
            <div className="dim acct-note">
              У приложения: <span className="mono">{st.appVersion}</span>
              {st.managed && st.previous ? <> · прошлая на сервере: <span className="mono">{st.previous}</span></> : null}
            </div>
          )}
          {v.notes.map((n) => <div key={n} className="warn-text acct-note">{n}</div>)}
          {st.ok && packagesLine(st) && (
            <div className="conn-form-actions">
              <span className="warn-text acct-note" style={{ flex: 1 }}>{packagesLine(st)}</span>
              {st.pkgManager !== 'none' && (st.packagesMissing?.length ?? 0) > 0 && (
                <button className="btn sm" disabled={busy !== ''} onClick={() => void run('packages')}>
                  {busy === 'packages' ? 'Ставлю пакеты…' : 'Установить недостающее'}
                </button>
              )}
            </div>
          )}
          {v.askUser && (v.primary !== undefined) && (
            <label className="field srv-user">
              <span>Пользователь службы (вход под root, а supervisor работает под обычным пользователем)</span>
              <input className="mono" value={user} onChange={(e) => setUser(e.target.value)} placeholder="например, perimeter" spellCheck={false} />
            </label>
          )}
          {(v.primary || v.rollback) && (
            <div className="conn-form-actions">
              {v.primary && (
                <button className="btn primary sm" disabled={busy !== '' || st.installing === true || (v.askUser && user.trim() === '')} onClick={() => void run('install')}>
                  {label('install', v.primary)}
                </button>
              )}
              {v.rollback && (
                <button className="btn sm" disabled={busy !== '' || st.installing === true} onClick={() => void run('rollback')}>
                  {label('rollback', v.rollback)}
                </button>
              )}
              {confirm !== '' && <button className="btn sm" onClick={() => setConfirm('')}>Не сейчас</button>}
            </div>
          )}
        </>
      )}
      {result && <div className={`${result.ok ? 'ok-text' : 'err-text'} acct-note`} role="status">{result.text}</div>}
      {log.length > 0 && <pre ref={logRef} className="srv-log mono">{log.join('\n')}</pre>}
    </section>
  );
}
