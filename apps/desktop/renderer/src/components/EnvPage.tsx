// Настройки → «Окружение» (docs/design/environment.md §1; владелец 2026-11-26: «не понял, где энвайроменты в UI»):
// колонка на среду — что стоит и какой версии, чего нет и на что влияет; на сервере — «Поставить» (установщик,
// возможности сервера), на своём компьютере — инструкция (не наши пакеты — молча не ставим).
import { useEffect, useState } from 'react';
import type { EnvProbe, EnvTool } from '@perimeter/protocol';
import type { ClientSet, SupervisorClient } from '../supervisor';
import type { Conn } from '../connections';
import { fmtBytes } from '../lib/migrationPlan';
import { Icon } from './Icon';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function openExternal(url: string): void {
  const ipc = window.perimeterIPC;
  if (ipc?.openExternal) void ipc.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

/** Подсказка с адресом — адрес кнопкой-ссылкой. */
function Hint({ text }: { text: string }) {
  const m = /(https?:\/\/\S+)/.exec(text);
  if (!m) return <span>{text}</span>;
  const [before, after] = [text.slice(0, m.index), text.slice(m.index + m[1]!.length)];
  return <span>{before}<button type="button" className="link-btn" onClick={() => openExternal(m[1]!)}>{m[1]!.replace(/^https?:\/\//, '').replace(/\/$/, '')}</button>{after}</span>;
}

const FEATURE_LABEL: Record<string, string> = { git: 'Git', terminal: 'Терминал', browser: 'Браузер', docker: 'Docker' };

function EnvColumn({ conn, client }: { conn: Conn; client: SupervisorClient }) {
  const live = client.status === 'live';
  const [p, setP] = useState<EnvProbe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => {
    setErr(null);
    client.envProbe().then(setP, (e: unknown) => setErr(/неизвестн|unknown|BAD_FRAME|схем/i.test(errText(e)) ? 'supervisor старой версии — обновите его (Настройки → подключение → «Подключение»)' : errText(e)));
  };
  useEffect(() => { if (live) load(); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const ipc = window.perimeterIPC;
  const canInstall = conn.kind === 'vps' && typeof ipc?.serverFeature === 'function';
  const install = (t: EnvTool) => {
    if (!t.feature || !ipc?.serverFeature) return;
    // терминал пересобирает node-pty и перезапускает службу — идущие ходы прервутся
    if (t.feature === 'terminal' && !window.confirm('Поставлю сборку и пересоберу терминал — supervisor перезапустится, идущие ходы на этом сервере прервутся. Продолжить?')) return;
    setBusy(t.feature);
    setResult(null);
    ipc.serverFeature(conn.id, t.feature).then(
      (r) => { setResult({ ok: r.ok, text: `${FEATURE_LABEL[t.feature!] ?? t.feature}: ${r.message}` }); if (r.ok) setTimeout(load, t.feature === 'terminal' ? 6000 : 500); },
      (e: unknown) => setResult({ ok: false, text: errText(e) }),
    ).finally(() => setBusy(null));
  };
  const bad = p?.tools.filter((t) => t.status !== 'ok').length ?? 0;

  return (
    <section className="env-col">
      <div className="env-head">
        <Icon name={conn.kind === 'vps' ? 'server' : 'laptop'} />
        <b>{conn.name}</b>
        {p && <span className={bad ? 'warn-text' : 'ok-text'}>{bad ? `не хватает: ${bad}` : 'всё на месте'}</span>}
        <span className="spacer" />
        <button type="button" className="icon-btn sm" disabled={!live} onClick={load} data-tip="Проверить заново" aria-label="Проверить заново"><Icon name="refresh" size={12} /></button>
      </div>
      {!live && <p className="dim">нет связи — проверю, когда подключение поднимется</p>}
      {err && <p className="err-text">{err}</p>}
      {live && !p && !err && <p className="dim">проверяю…</p>}
      {p && (
        <>
          <div className="dim env-sys">
            {p.user}@{p.host} · {p.os} · {p.cpus} яд. · память {fmtBytes(p.memFree)} своб. из {fmtBytes(p.memTotal)}
            {p.diskFree !== null && p.diskTotal !== null ? ` · диск ${fmtBytes(p.diskFree)} своб. из ${fmtBytes(p.diskTotal)}` : ''}
            {` · живых сессий ${p.live.count}${p.live.max !== null ? ` из ${p.live.max}` : ''}`}
          </div>
          <ul className="env-list">
            {p.tools.map((t) => (
              <li key={t.id} className={`env-row st-${t.status}`}>
                <span className={`env-dot ${t.status}`} aria-label={t.status === 'ok' ? 'есть' : t.status === 'warn' ? 'частично' : 'нет'} />
                <div className="env-body">
                  <div className="env-title"><b>{t.title}</b>{t.version && <span className="mono dim">{t.version}</span>}{t.status === 'missing' && <span className="err-text">нет</span>}</div>
                  {t.detail && <div className="dim env-detail">{t.detail}</div>}
                  {t.status !== 'ok' && t.affects && <div className="env-detail">без этого: {t.affects}</div>}
                  {t.status !== 'ok' && t.hint && (!t.feature || !canInstall) && <div className="dim env-detail">как поставить: <Hint text={t.hint} /></div>}
                </div>
                {t.status !== 'ok' && t.feature && canInstall && (
                  <button type="button" className="btn sm" disabled={busy !== null} onClick={() => install(t)}>{busy === t.feature ? 'ставлю…' : 'Поставить'}</button>
                )}
              </li>
            ))}
          </ul>
          {result && <p className={result.ok ? 'ok-text' : 'err-text'}>{result.text}</p>}
        </>
      )}
    </section>
  );
}

export function EnvPage({ clients, conns }: { clients: ClientSet; conns: Conn[] }) {
  const on = conns.filter((c) => c.enabled);
  return (
    <>
      <h3 className="st-h">Окружение</h3>
      <p className="dim st-sub">
        Что стоит в каждой среде и чего не хватает агентам. На сервере недостающее ставится кнопкой; на этом
        компьютере — по инструкции: это ваша система, молча её не трогаем.
      </p>
      {on.length === 0 && <p className="dim">Нет включённых подключений.</p>}
      <div className="env-grid">
        {on.map((c) => <EnvColumn key={c.id} conn={c} client={clients.get(c.id)} />)}
      </div>
    </>
  );
}
