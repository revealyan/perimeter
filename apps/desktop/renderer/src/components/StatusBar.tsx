// Строка статуса (BD2) внизу центра: среда · канал · ctx % с мини-шкалой · +N −M · $ · модель · режим ·
// справа — supervisor и тёплые процессы. Данные среды живут здесь, а не в сайдбаре.
import { useEffect, useState, type CSSProperties } from 'react';
import { ports } from '../ports';
import type { SessionView, SupervisorClient } from '../supervisor';
import { envLabel } from '../supervisor';
import { ctxView, fmtBytes, fmtCost, fmtDuration, fmtTokens } from '../lib/toolFormat';
import { changesTotal, fileChanges, sessionCost } from '../lib/feedModel';
import type { PanelTab } from '../lib/panelLayout';
import { modeLabel } from './SessionHeader';
import { Icon } from './Icon';

export function StatusBar({ client, session, tunnel, onTab, onSettings }: {
  client: SupervisorClient;
  session?: SessionView | undefined;
  tunnel: string;
  onTab: (t: PanelTab) => void;
  onSettings: () => void;
}) {
  const live = client.status === 'live';
  const env = client.environment;
  // проброшенные порты подключения — как «Ports» в строке статуса VS Code
  const [, setPt] = useState(0);
  useEffect(() => { ports.start(); return ports.subscribe(() => setPt((t) => t + 1)); }, []);
  // нагрузка машины supervisor'а — раз в 20 с (строка статуса не должна шуметь)
  const [stats, setStats] = useState<{ load1: number | null; cores: number; memTotal: number; memFree: number; uptimeSec: number; diskFree?: number } | null>(null);
  useEffect(() => {
    let live = true;
    const pull = () => { if (client.status === 'live') void client.sysStats().then((s) => { if (live && s) setStats(s); }); };
    pull();
    const t = setInterval(pull, 20_000);
    return () => { live = false; clearInterval(t); };
  }, [client, client.status]);
  const fwd = ports.of(env).length;
  const ctx = session ? ctxView(client.contextBySession.get(session.id)) : null;
  const ch = session ? changesTotal(fileChanges(session.items)) : null;
  const cost = session ? sessionCost(session) : undefined;
  const ipc = typeof window !== 'undefined' && window.perimeterIPC !== undefined;
  // канал до supervisor: на VPS — ssh-туннель приложения; без Electron (браузер) — прямой адрес
  const channel = env === 'local'
    ? <span className="dim" data-tip={client.url}>локально</span>
    : !ipc
      ? <span className="dim" data-tip={`Прямое подключение без туннеля: ${client.url}`}>напрямую</span>
      : tunnel === 'up'
        ? <span className="ok-text" data-tip={`SSH-туннель поднят · ${client.url}`}>ssh ✓</span>
        : <span className="warn-text" data-tip={client.url}>ssh {tunnel || '…'}</span>;

  return (
    <footer className="statusbar mono" role="status">
      <span className={`sb-env ${live ? '' : 'off'}`} data-tip={live ? `Подключено к «${envLabel(env)}»` : client.status === 'connecting' ? 'Подключаемся…' : 'Нет связи — переподключаемся'}>
        <span className={`dot dot-${live ? 'green' : client.status === 'connecting' ? 'yellow' : 'red'}`} />
        <b>{envLabel(env)}</b>
      </span>
      {channel}
      {fwd > 0 && (
        <>
          <span className="sb-sep">·</span>
          <button className="sb-item" onClick={() => onTab('ports')} data-tip={`Проброшено портов с «${envLabel(env)}»: ${fwd}`}>
            <Icon name="plug2" size={12} /> {fwd}
          </button>
        </>
      )}
      {session && (
        <>
          <span className="sb-sep">·</span>
          <button className="sb-item" onClick={() => onTab('context')} data-tip={ctx ? `Контекст: ${ctx.used !== undefined ? fmtTokens(ctx.used) : '?'} из ${ctx.max !== undefined ? fmtTokens(ctx.max) : '?'} токенов` : 'Контекст появится, когда процесс сессии запущен'}>
            <span className="dim">ctx</span> {ctx ? `${ctx.pct}%` : '—'}
            <span className={`sb-meter ${ctx && ctx.pct >= 80 ? 'hot' : ctx && ctx.pct >= 60 ? 'warm' : ''}`} style={{ '--p': ctx?.pct ?? 0 } as CSSProperties}><span /></span>
            {ctx?.used !== undefined && ctx.max !== undefined && <span className="dim">{fmtTokens(ctx.used)}/{fmtTokens(ctx.max)}</span>}
          </button>
          <button className="sb-item" disabled={!live || session.state === 'creating'} data-tip="/compact — агент сожмёт историю в выжимку и освободит контекст (идёт обычным ходом)" onClick={() => client.sendText(session.id, '/compact')}>
            <Icon name="minimize" size={12} /> <span className="dim">сжать</span>
          </button>
          {ch && ch.files > 0 && (
            <>
              <span className="sb-sep">·</span>
              <button className="sb-item" onClick={() => onTab('changes')} data-tip="Изменения сессии" data-key="Ctrl Shift D">
                <span className="add">+{ch.added}</span> <span className="del">−{ch.removed}</span>
              </button>
            </>
          )}
          {cost !== undefined && <><span className="sb-sep">·</span><span data-tip="Стоимость сессии">{fmtCost(cost)}</span></>}
          {session.model && <><span className="sb-sep">·</span><span>{session.model}</span></>}
          {session.permissionMode && <><span className="sb-sep">·</span><span>{modeLabel(session.permissionMode).toLowerCase()}</span></>}
        </>
      )}
      <span className="spacer" />
      {stats !== null && (
        <span
          className="dim sb-server"
          data-tip={`Машина «${envLabel(env)}»: загрузка ${(stats.load1 ?? 0).toFixed(2)} из ${stats.cores} ядер · память ${fmtBytes(stats.memTotal - stats.memFree)} из ${fmtBytes(stats.memTotal)} свободно ${fmtBytes(stats.memFree)}${stats.diskFree !== undefined ? ` · диск свободно ${fmtBytes(stats.diskFree)}` : ''} · аптайм ${fmtDuration(stats.uptimeSec * 1000)}`}
        >
          <Icon name="gauge" size={12} /> {(stats.load1 ?? 0).toFixed(1)} · {fmtBytes(stats.memTotal - stats.memFree)}/{fmtBytes(stats.memTotal)}
        </span>
      )}
      {client.pool && client.pool.target > 0 && <><span className="sb-sep sb-server">·</span><span className="dim sb-server" data-tip="Пул тёплых процессов: новая сессия стартует мгновенно">тёплых {client.pool.warm}/{client.pool.target}</span></>}
      <button className="icon-btn sm" onClick={onSettings} data-tip="Настройки" data-key="Ctrl ," aria-label="Настройки"><Icon name="settings" size={14} /></button>
    </footer>
  );
}
