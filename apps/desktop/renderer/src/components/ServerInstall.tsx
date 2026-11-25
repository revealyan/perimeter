// Блок «Supervisor на сервере» в настройках подключения VPS (АДР 004): что стоит на сервере и у приложения,
// «Установить/Обновить», «Откатить», ход установки строками. Само ничего не ставит — только по кнопке.
import { useEffect, useRef, useState } from 'react';
import type { Conn } from '../connections';
import { FEATURES, defaultPick, describeServer, featuresNeedConfirm, packagesLine, type FeatureId, type ServerStatus } from '../lib/serverInstallModel';

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
  const [busy, setBusy] = useState<'' | 'status' | 'install' | 'rollback' | 'packages' | 'features'>('');
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [user, setUser] = useState(conn.serviceUser ?? '');
  /** вторая кнопка при идущих ходах: «Всё равно …» */
  const [confirm, setConfirm] = useState<'' | 'install' | 'rollback' | 'features'>('');
  /** выбранные возможности сервера (по умолчанию — всё недостающее, что ставится кнопкой) */
  const [pick, setPick] = useState<FeatureId[] | null>(null);
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

  // выбор по умолчанию — когда статус пришёл впервые (дальше выбор — за пользователем)
  const picked = pick ?? (st ? defaultPick(st) : []);
  const togglePick = (id: FeatureId, on: boolean) => setPick(on ? [...new Set([...picked, id])] : picked.filter((x) => x !== id));
  /** Поставить выбранные возможности по очереди; ход — строками в логе блока. */
  const runFeatures = async (): Promise<void> => {
    if (!st || picked.length === 0 || !ipcM?.serverFeature) return;
    if (featuresNeedConfirm(st, picked) && confirm !== 'features') { setConfirm('features'); return; }
    setConfirm('');
    setBusy('features');
    setLog([]);
    setResult(null);
    const done: string[] = [];
    try {
      for (const id of FEATURES.map((f) => f.id).filter((x) => picked.includes(x))) {
        const f = FEATURES.find((x) => x.id === id)!;
        setLog((l) => [...l, `── ${f.label}`]);
        const r = await ipcM.serverFeature(conn.id, id);
        if (!r.ok) { setResult({ ok: false, text: `${f.label}: ${r.message}` }); return; }
        done.push(f.label);
      }
      setResult({ ok: true, text: `Готово: ${done.join(', ')}` });
      setPick(null);
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
          {st.ok && st.features && st.managed && (
            <div className="srv-features" aria-label="Возможности сервера">
              <div className="srv-feat-title">Возможности сервера</div>
              {FEATURES.map((f) => {
                const s = st.features?.[f.id];
                if (!s) return null;
                return (
                  <label key={f.id} className={`srv-feat state-${s.state}`}>
                    {s.state === 'missing'
                      ? <input type="checkbox" checked={picked.includes(f.id)} disabled={busy !== ''} onChange={(e) => togglePick(f.id, e.target.checked)} />
                      : <span className={`dot ${s.state === 'ok' ? 'dot-green' : 'dot-off'}`} aria-hidden />}
                    <span className="srv-feat-body">
                      <b>{f.label}</b> <span className="dim">— {f.gives}</span>
                      {s.state === 'manual' && s.why && <span className="warn-text srv-feat-why">{s.why}</span>}
                      {s.state === 'missing' && f.note && <span className="dim srv-feat-why">{f.note}</span>}
                    </span>
                    <span className={`srv-feat-state ${s.state === 'ok' ? 'ok-text' : 'dim'}`}>{s.state === 'ok' ? 'есть' : s.state === 'missing' ? 'нет' : 'вручную'}</span>
                  </label>
                );
              })}
              {defaultPick(st).length > 0 && (
                <div className="conn-form-actions">
                  <button className="btn sm primary" disabled={busy !== '' || picked.length === 0} onClick={() => void runFeatures()}>
                    {busy === 'features' ? 'Ставлю…' : confirm === 'features' ? 'Всё равно: перезапустить и поставить' : `Поставить выбранное${picked.length ? ` (${picked.length})` : ''}`}
                  </button>
                  {confirm === 'features' && <span className="warn-text acct-note">Терминал перезапустит supervisor — идущие ходы прервутся.</span>}
                </div>
              )}
            </div>
          )}
          {st.ok && !st.features && packagesLine(st) && (
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
