// Вкладка «Браузер» (BD2, P3): адресная строка с историей внутри панели, порт с подсказками из net.ports,
// чип «VPS → туннель :PORT» / «локально», превью в <iframe>, «Десктоп / Телефон» (ширина 390 по центру).
// На VPS порт пробрасывается через ssh-туннель Electron (IPC perimeter:forward-port); без Electron и на этом
// компьютере — напрямую. «Выбрать элемент» и консоль — следующий шаг: странице в iframe с другого адреса
// скрипты панели недоступны, нужен <webview> с preload.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { SessionView, SupervisorClient } from '../supervisor';
import { envLabel, isRemote } from '../supervisor';
import {
  BROWSER_DEFAULT, back, canBack, canForward, currentUrl, displayUrl, forward, navigate, normalizeBrowserState,
  normalizeUrl, portOf, portSuggestions, previewPlan, procName, rebase, type BrowserState, type Device,
} from '../lib/browserNav';
import { panelErrorText, type PortInfo } from '../lib/panelData';
import { Icon } from './Icon';
import { RemoteBrowser } from './RemoteBrowser';

const stateKey = (sid: string) => `perimeter:browser:${sid}`;

function loadState(sid: string): BrowserState {
  try { return normalizeBrowserState(JSON.parse(localStorage.getItem(stateKey(sid)) ?? 'null')); } catch { return BROWSER_DEFAULT; }
}

/** Проброшенные порты VPS этого окна: remotePort → локальный адрес (main тоже отдаёт тот же). */
const forwarded = new Map<string, string>();
const fwdKey = (env: string, port: number) => `${env}:${port}`;

/** Текст ошибки IPC без обёртки Electron «Error invoking remote method …: Error: ». */
function ipcError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function openExternal(url: string): void {
  const ipc = window.perimeterIPC;
  if (ipc?.openExternal) void ipc.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

type Fwd = { port: number; status: 'pending' | 'ok' | 'error'; base?: string; error?: string };

type BrowserMode = 'preview' | 'remote';
const modeKey = (env: string) => `perimeter:browser-mode:${env}`;

/** Открыть адрес во вкладке «Браузер» сессии (превью): из «Портов» и ссылок. */
export function openInBrowserTab(sid: string, env: string, url: string): void {
  const st = loadState(sid);
  localStorage.setItem(stateKey(sid), JSON.stringify({ ...st, history: navigate(st.history, url) }));
  localStorage.setItem(modeKey(env), 'preview');
}

/**
 * Вкладка «Браузер»: у VPS два режима — превью (порт VPS пробрасывается сюда, страница открывается здесь)
 * и браузер на сервере (Chromium на VPS, сюда — картинка). У этого компьютера — только превью.
 */
export function BrowserTab({ session, client }: { session: SessionView; client: SupervisorClient }) {
  const env = client.environment;
  const remote = isRemote(env);
  const [mode, setModeState] = useState<BrowserMode>(() => (localStorage.getItem(modeKey(env)) === 'remote' ? 'remote' : 'preview'));
  const [modeEnv, setModeEnv] = useState(env);
  if (modeEnv !== env) {
    setModeEnv(env);
    setModeState(localStorage.getItem(modeKey(env)) === 'remote' ? 'remote' : 'preview');
  }
  const setMode = (m: BrowserMode) => { setModeState(m); localStorage.setItem(modeKey(env), m); };
  const shown: BrowserMode = remote ? mode : 'preview';
  return (
    <div className="browser-wrap">
      {remote && (
        <div className="bv-mode">
          <div className="seg" role="tablist" aria-label="Режим браузера">
            <button role="tab" aria-selected={shown === 'preview'} className={shown === 'preview' ? 'on' : ''} onClick={() => setMode('preview')} data-tip="Порт с VPS пробрасывается сюда по ssh, страница открывается здесь">
              <Icon name="laptop" size={14} />Превью здесь
            </button>
            <button role="tab" aria-selected={shown === 'remote'} className={shown === 'remote' ? 'on' : ''} onClick={() => setMode('remote')} data-tip={`Chromium запускается на «${envLabel(env)}», сюда идёт картинка`}>
              <Icon name="server" size={14} />Браузер на сервере
            </button>
          </div>
        </div>
      )}
      {shown === 'remote' ? <RemoteBrowser client={client} /> : <PreviewBrowser session={session} client={client} />}
    </div>
  );
}

function PreviewBrowser({ session, client }: { session: SessionView; client: SupervisorClient }) {
  const sid = session.id;
  const env = client.environment;
  const live = client.status === 'live';
  const [st, setSt] = useState<BrowserState>(() => loadState(sid));
  const [stSid, setStSid] = useState(sid);
  if (stSid !== sid) {
    setStSid(sid);
    setSt(loadState(sid));
  }
  useEffect(() => { localStorage.setItem(stateKey(stSid), JSON.stringify(st)); }, [st, stSid]);

  const url = currentUrl(st.history);
  const [addr, setAddr] = useState(url ? displayUrl(url) : '');
  const [addrBad, setAddrBad] = useState(false);
  useEffect(() => { setAddr(url ? displayUrl(url) : ''); setAddrBad(false); }, [url]);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [portInput, setPortInput] = useState('');

  const go = (target: string) => setSt((s) => ({ ...s, history: navigate(s.history, target) }));
  const submitAddr = (e: FormEvent) => {
    e.preventDefault();
    const u = normalizeUrl(addr);
    if (!u) { setAddrBad(true); return; }
    setAddrBad(false);
    if (u === url) setReload((r) => r + 1);
    else go(u);
  };
  const submitPort = (e: FormEvent) => {
    e.preventDefault();
    const u = normalizeUrl(portInput.replace(/^:/, ''));
    if (!u || !/^\d{1,5}$/.test(portInput.replace(/^:/, '').trim())) return;
    setPortInput('');
    go(u);
  };

  // ─── порты машины сессии ───
  const [ports, setPorts] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; list: PortInfo[]; error?: string }>({ status: 'idle', list: [] });
  const loadPorts = () => {
    setPorts((p) => ({ ...p, status: 'loading' }));
    client.netPorts(sid).then(
      (list) => setPorts({ status: 'ok', list }),
      (e: unknown) => setPorts({ status: 'error', list: [], error: panelErrorText(e) }),
    );
  };
  useEffect(() => { if (live) loadPorts(); }, [sid, live]);
  const ownPort = (() => { try { return Number(new URL(client.url).port) || 0; } catch { return 0; } })();
  const chips = portSuggestions(ports.list, [ownPort]);

  // ─── куда грузить превью ───
  const canTunnel = typeof window.perimeterIPC?.forwardPort === 'function';
  const plan = url ? previewPlan(url, env, canTunnel) : null;
  const [fwd, setFwd] = useState<Fwd | null>(null);
  const [fwdTry, setFwdTry] = useState(0);
  const fwdPort = plan?.kind === 'forward' ? plan.port : null;
  useEffect(() => {
    if (fwdPort === null) { setFwd(null); return; }
    const known = forwarded.get(fwdKey(env, fwdPort));
    if (known) { setFwd({ port: fwdPort, status: 'ok', base: known }); return; }
    let on = true;
    setFwd({ port: fwdPort, status: 'pending' });
    window.perimeterIPC!.forwardPort!(fwdPort, env).then(
      (base) => { forwarded.set(fwdKey(env, fwdPort), base); if (on) setFwd({ port: fwdPort, status: 'ok', base }); },
      (e: unknown) => { if (on) setFwd({ port: fwdPort, status: 'error', error: ipcError(e) }); },
    );
    return () => { on = false; };
  }, [fwdPort, fwdTry, env]);

  let src: string | null = null;
  if (url && plan) {
    if (plan.kind === 'direct') src = url;
    else if (fwd?.status === 'ok' && fwd.port === plan.port && fwd.base) src = rebase(url, fwd.base);
  }
  useEffect(() => { setLoaded(false); }, [src, reload]);

  // ─── чип «как открыто» ───
  let chip: ReactNode = null;
  if (plan) {
    const p = portOf(url!) ?? 0;
    if (plan.kind === 'forward') {
      if (fwd?.status === 'error') {
        chip = <button className="bv-chip err" onClick={() => setFwdTry((n) => n + 1)} data-tip={`Проброс не удался: ${fwd.error ?? ''} — нажмите, чтобы повторить`}><span className="dot dot-red" />туннель: ошибка</button>;
      } else if (fwd?.status === 'ok') {
        chip = <span className="bv-chip ok" data-tip={`Порт ${p} на VPS проброшен через ssh → ${fwd.base}`}><span className="dot dot-green" />VPS → туннель :{p}</span>;
      } else {
        chip = <span className="bv-chip" data-tip="Поднимаем проброс порта через ssh…"><Icon name="loader" size={12} className="spin" />VPS → туннель…</span>;
      }
    } else if (plan.reason === 'local') {
      chip = <span className="bv-chip" data-tip={`Порт ${p} этой машины — напрямую`}><Icon name="laptop" size={12} />локально</span>;
    } else if (plan.reason === 'no-tunnel') {
      chip = <span className="bv-chip warn" data-tip="Без приложения (браузер-стенд) порт VPS не пробрасывается — открыт тот же порт на этой машине"><span className="dot dot-amber" />VPS · без туннеля</span>;
    } else {
      chip = <span className="bv-chip" data-tip="Внешний адрес — открывается как есть"><Icon name="globe" size={12} />внешний</span>;
    }
  }

  const setDevice = (device: Device) => setSt((s) => ({ ...s, device }));

  let view: ReactNode;
  if (!url) {
    view = (
      <div className="panel-empty bv-empty">
        <Icon name="globe" size={20} />
        <div>Превью веб-приложения сессии</div>
        <div className="dim">
          Введите адрес или порт dev-сервера{!isRemote(env) ? ' на этом компьютере' : canTunnel ? ` на «${envLabel(env)}» — порт пробросим через ssh-туннель` : ' — в браузере-стенде порт VPS не пробрасывается, откроется порт этой машины'}.
        </div>
        {chips.length > 0 && (
          <div className="bv-ports center">
            {chips.map((c) => <PortChip key={c.port} p={c} onClick={() => go(`http://localhost:${c.port}/`)} />)}
          </div>
        )}
        {ports.status === 'ok' && chips.length === 0 && <div className="dim">Слушающих портов не нашлось — запустите dev-сервер (например, в Терминале).</div>}
      </div>
    );
  } else if (window.top !== window.self) {
    // клиент открыт в превью самого себя — вложенное превью бесконечно повторило бы себя
    view = <div className="panel-empty"><Icon name="globe" size={20} /><div className="dim">Превью внутри превью отключено.</div></div>;
  } else if (!src) {
    view = (
      <div className="panel-empty">
        {fwd?.status === 'error'
          ? <>
              <Icon name="alert" size={20} />
              <div>Порт {fwdPort} не пробросился</div>
              <div className="dim">{fwd.error}</div>
              <button className="btn sm" onClick={() => setFwdTry((n) => n + 1)}><Icon name="refresh" size={14} /> Повторить</button>
            </>
          : <><Icon name="loader" size={20} className="spin" /><div className="dim">Пробрасываем порт {fwdPort} через ssh…</div></>}
      </div>
    );
  } else {
    view = (
      <div className={`bv-stage ${st.device}`}>
        {!loaded && <div className="thin-progress bv-progress" aria-hidden><span /></div>}
        <iframe
          key={`${src}|${reload}`}
          className="bv-frame"
          src={src}
          title="Превью веб-приложения"
          onLoad={() => setLoaded(true)}
          // без allow-top-navigation: страница не уведёт окно приложения
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
      </div>
    );
  }

  return (
    <div className="browser-tab">
      <div className="bv-bar">
        <button className={`icon-btn sm ${canBack(st.history) ? '' : 'is-disabled'}`} aria-disabled={!canBack(st.history)} onClick={() => setSt((s) => ({ ...s, history: back(s.history) }))} aria-label="Назад" data-tip="Назад"><Icon name="arrowLeft" size={14} /></button>
        <button className={`icon-btn sm ${canForward(st.history) ? '' : 'is-disabled'}`} aria-disabled={!canForward(st.history)} onClick={() => setSt((s) => ({ ...s, history: forward(s.history) }))} aria-label="Вперёд" data-tip="Вперёд"><Icon name="arrowRight" size={14} /></button>
        <button className={`icon-btn sm ${url ? '' : 'is-disabled'}`} aria-disabled={!url} onClick={() => url && setReload((r) => r + 1)} aria-label="Обновить" data-tip="Обновить страницу"><Icon name="refresh" size={14} /></button>
        <form className={`bv-addr ${addrBad ? 'bad' : ''}`} onSubmit={submitAddr}>
          <Icon name="globe" size={14} />
          <input
            value={addr}
            onChange={(e) => { setAddr(e.target.value); setAddrBad(false); }}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => { if (e.key === 'Escape') { setAddr(url ? displayUrl(url) : ''); e.currentTarget.blur(); } }}
            placeholder="localhost:5173 или порт"
            aria-label="Адрес"
            spellCheck={false}
            {...(addrBad ? { 'aria-invalid': true } : {})}
          />
          {chip}
        </form>
      </div>
      <div className="bv-tools">
        <button className="btn sm is-disabled" aria-disabled="true" data-tip="Следующий шаг: выбрать элемент страницы и спросить агента про него. Странице в iframe с другого адреса скрипты панели недоступны — нужен <webview> с preload.">
          <Icon name="pointer" size={14} /> Выбрать элемент
        </button>
        <div className="seg" role="group" aria-label="Ширина превью">
          <button className={st.device === 'desktop' ? 'on' : ''} aria-pressed={st.device === 'desktop'} onClick={() => setDevice('desktop')}><Icon name="monitor" size={14} />Десктоп</button>
          <button className={st.device === 'phone' ? 'on' : ''} aria-pressed={st.device === 'phone'} onClick={() => setDevice('phone')} data-tip="Ширина 390 px"><Icon name="smartphone" size={14} />Телефон</button>
        </div>
        <span className="spacer" />
        <button className={`icon-btn sm ${src ? '' : 'is-disabled'}`} aria-disabled={!src} onClick={() => src && openExternal(src)} aria-label="Открыть во внешнем браузере" data-tip="Открыть во внешнем браузере"><Icon name="externalLink" size={14} /></button>
      </div>
      <div className="bv-portbar">
        <form onSubmit={submitPort} className="bv-port">
          <span className="dim">Порт</span>
          <input value={portInput} onChange={(e) => setPortInput(e.target.value.replace(/[^\d:]/g, ''))} placeholder="5173" inputMode="numeric" aria-label="Порт" maxLength={6} />
        </form>
        <div className="bv-ports">
          {url && chips.map((c) => <PortChip key={c.port} p={c} on={portOf(url) === c.port} onClick={() => go(`http://localhost:${c.port}/`)} />)}
          {url && ports.status === 'ok' && chips.length === 0 && <span className="dim bv-ports-note">портов dev-серверов нет</span>}
          {ports.status === 'error' && <span className="err-text bv-ports-note" data-tip={ports.error}>порты: {ports.error}</span>}
        </div>
        <button className={`icon-btn sm ${live ? '' : 'is-disabled'}`} aria-disabled={!live} onClick={() => live && loadPorts()} aria-label="Обновить порты" data-tip={`Слушающие порты · ${envLabel(env)}`}>
          <Icon name={ports.status === 'loading' ? 'loader' : 'refresh'} size={14} className={ports.status === 'loading' ? 'spin' : ''} />
        </button>
      </div>
      <div className="bv-view">{view}</div>
      <div className="bv-console is-disabled" aria-disabled="true" data-tip="Следующий шаг: консоль страницы (ошибки и предупреждения) — тот же <webview> с preload">
        <Icon name="chevronRight" size={14} /><span>Консоль</span><span className="dim">— следующий шаг</span>
      </div>
    </div>
  );
}

function PortChip({ p, on, onClick }: { p: PortInfo; on?: boolean; onClick: () => void }) {
  return (
    <button className={`bv-port-chip ${on ? 'on' : ''}`} onClick={onClick} data-tip={`Открыть localhost:${p.port}${p.host ? ` (слушает ${p.host})` : ''}`}>
      <span className="mono">:{p.port}</span>{p.process && <span className="dim">· {procName(p.process)}</span>}
    </button>
  );
}
