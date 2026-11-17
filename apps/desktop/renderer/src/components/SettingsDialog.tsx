// Настройки: слева «Общие» и подключения (как в Happy — «Этот компьютер» есть всегда, VPS добавляются),
// справа страница выбранного: связь, аккаунты и модели, проекты — у каждого подключения своё.
import { useEffect, useState } from 'react';
import type { ClientSet, EnvId } from '../supervisor';
import { envLabel } from '../supervisor';
import { LOCAL, connections, ipc, type Conn, type ConnInput } from '../connections';
import { playTurnDone } from '../lib/sound';
import { useEscape } from './ui';
import { Icon } from './Icon';
import { AccountsSettings } from './AccountsSettings';
import { McpSettings } from './McpSettings';
import { ProjectsSettings } from './ProjectsSettings';
import { ServerInstall } from './ServerInstall';
import { COMPOSER_STYLE_HINT, COMPOSER_STYLE_LABEL, type ComposerStyle } from '../lib/composerModel';

/** Ошибка из моста Electron приходит с префиксом «Error invoking remote method …: Error: » — показываем суть. */
export function ipcError(e: unknown): string {
  const t = e instanceof Error ? e.message : String(e);
  const i = t.lastIndexOf('Error: ');
  return i >= 0 ? t.slice(i + 7) : t;
}

type Page = { kind: 'general' } | { kind: 'conn'; id: EnvId } | { kind: 'add' };
type ConnTab = 'link' | 'accounts' | 'mcp' | 'projects';

function General({ composerStyle, onComposerStyle }: { composerStyle: ComposerStyle; onComposerStyle: (v: ComposerStyle) => void }) {
  const [theme, setTheme] = useState(localStorage.getItem('perimeter:theme') ?? 'dark');
  const [notifyOn, setNotifyOn] = useState(localStorage.getItem('perimeter:notify') !== 'off');
  const [turnSound, setTurnSound] = useState(localStorage.getItem('perimeter:turn-sound') ?? 'bg');
  const [keepAwake, setKeepAwake] = useState(localStorage.getItem('perimeter:keep-awake') === 'on');
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  useEffect(() => {
    void window.perimeterIPC?.autoLaunch?.().then(setAutoLaunch).catch(() => setAutoLaunch(null));
  }, []);
  const applyTheme = (t: string) => {
    setTheme(t);
    localStorage.setItem('perimeter:theme', t);
    document.documentElement.classList.toggle('theme-light', t === 'light');
  };
  return (
    <>
      <h3 className="st-h">Общие</h3>
      <div className="field">
        <span>Поле ввода</span>
        <div className="seg env-seg" role="radiogroup" aria-label="Поле ввода">
          {(['card', 'panel'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={composerStyle === v} className={composerStyle === v ? 'on' : ''} onClick={() => onComposerStyle(v)}>
              {COMPOSER_STYLE_LABEL[v]}
            </button>
          ))}
        </div>
        <span className="dim field-hint">{COMPOSER_STYLE_HINT[composerStyle]}</span>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Тема</span>
          <select value={theme} onChange={(e) => applyTheme(e.target.value)}>
            <option value="dark">тёмная</option>
            <option value="light">светлая</option>
          </select>
        </label>
        <label className="field">
          <span>Уведомления ОС</span>
          <select value={notifyOn ? 'on' : 'off'} onChange={(e) => { const on = e.target.value === 'on'; setNotifyOn(on); localStorage.setItem('perimeter:notify', on ? 'on' : 'off'); }}>
            <option value="on">включены</option>
            <option value="off">выключены</option>
          </select>
        </label>
        <label className="field">
          <span>Звук по завершении хода</span>
          <select value={turnSound} onChange={(e) => { setTurnSound(e.target.value); localStorage.setItem('perimeter:turn-sound', e.target.value); if (e.target.value !== 'off') playTurnDone(); }}>
            <option value="bg">когда окно не в фокусе</option>
            <option value="always">всегда</option>
            <option value="off">выключен</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Не давать компьютеру спать</span>
        <select value={keepAwake ? 'on' : 'off'} onChange={(e) => { const on = e.target.value === 'on'; setKeepAwake(on); localStorage.setItem('perimeter:keep-awake', on ? 'on' : 'off'); }}>
          <option value="off">как обычно</option>
          <option value="on">пока идёт работа сессий</option>
        </select>
        <span className="dim field-hint">Держит систему бодрой, пока хоть одна сессия работает или ждёт ответа</span>
      </label>
      <label className="field">
        <span>Запускать вместе с системой</span>
        <select
          value={autoLaunch === null ? 'unknown' : autoLaunch ? 'on' : 'off'}
          onChange={(e) => { const on = e.target.value === 'on'; setAutoLaunch(on); void window.perimeterIPC?.setAutoLaunch?.(on); }}
        >
          {autoLaunch === null && <option value="unknown">—</option>}
          <option value="on">да</option>
          <option value="off">нет</option>
        </select>
      </label>
    </>
  );
}

/** Форма VPS-подключения: добавить новое или поправить существующее. На стенде без Electron — просто адрес ws://. */
function ConnForm({ conn, onSaved, onRemoved }: { conn?: Conn; onSaved: (id: EnvId) => void; onRemoved?: () => void }) {
  const managed = connections.managed;
  const [f, setF] = useState<ConnInput & { wsUrl?: string }>(() => ({
    name: conn?.name ?? '', host: conn?.host ?? '', user: conn?.user ?? 'root',
    ...(conn?.port !== undefined ? { port: conn.port } : {}),
    ...(conn?.privateKey !== undefined ? { privateKey: conn.privateKey } : {}),
    ...(conn?.remotePort !== undefined ? { remotePort: conn.remotePort } : {}),
    ...(!managed ? { wsUrl: conn?.wsUrl ?? '' } : {}),
  }));
  const [busy, setBusy] = useState<'' | 'test' | 'save' | 'remove'>('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setMsg(null); };
  const valid = f.name.trim() !== '' && (managed ? f.host.trim() !== '' && f.user.trim() !== '' : /^wss?:\/\//.test(f.wsUrl ?? ''));
  const input = (): ConnInput => ({
    name: f.name.trim(), host: f.host.trim(), user: f.user.trim(),
    ...(f.port ? { port: f.port } : {}),
    ...(f.privateKey ? { privateKey: f.privateKey } : {}),
    ...(f.remotePort ? { remotePort: f.remotePort } : {}),
  });
  const test = async () => {
    setBusy('test');
    try { const r = await connections.test(input()); setMsg({ ok: r.ok, text: r.message }); } catch (e) { setMsg({ ok: false, text: ipcError(e) }); } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('save');
    try {
      if (conn) {
        await connections.update(conn.id, { ...input(), ...(!managed ? { wsUrl: f.wsUrl ?? '' } : {}) });
        setMsg({ ok: true, text: 'сохранено' });
        onSaved(conn.id);
      } else {
        const c = await connections.add({ ...input(), ...(!managed && f.wsUrl ? { wsUrl: f.wsUrl } : {}) });
        onSaved(c.id);
      }
    } catch (e) { setMsg({ ok: false, text: ipcError(e) }); } finally { setBusy(''); }
  };
  const pickKey = async () => {
    const k = await ipc()?.pickKeyFile?.();
    if (k) set({ privateKey: k });
  };

  return (
    <div className="conn-form">
      <label className="field"><span>Название</span><input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="например: VPS RackNerd" autoFocus={!conn} /></label>
      {managed ? (
        <>
          <div className="field-row">
            <label className="field grow2"><span>Хост</span><input className="mono" value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="198.12.84.32 или имя" spellCheck={false} /></label>
            <label className="field"><span>Порт ssh</span><input className="mono" value={f.port ?? ''} onChange={(e) => set({ port: Number(e.target.value) || undefined })} placeholder="22" /></label>
          </div>
          <div className="field-row">
            <label className="field"><span>Пользователь</span><input className="mono" value={f.user} onChange={(e) => set({ user: e.target.value })} spellCheck={false} /></label>
            <label className="field"><span>Порт supervisor на сервере</span><input className="mono" value={f.remotePort ?? ''} onChange={(e) => set({ remotePort: Number(e.target.value) || undefined })} placeholder="8790" /></label>
          </div>
          <label className="field">
            <span>Ключ ssh (пусто — ssh-agent и ~/.ssh/id_*)</span>
            <span className="field-inline">
              <input className="mono" value={f.privateKey ?? ''} onChange={(e) => set({ privateKey: e.target.value || undefined })} placeholder="C:\Users\…\.ssh\id_ed25519" spellCheck={false} />
              <button type="button" className="btn sm" onClick={() => void pickKey()}><Icon name="folder" size={12} /> Выбрать</button>
            </span>
          </label>
        </>
      ) : (
        <label className="field">
          <span>Адрес supervisor (стенд без Electron — напрямую, без ssh)</span>
          <input className="mono" value={f.wsUrl ?? ''} onChange={(e) => set({ wsUrl: e.target.value })} placeholder="ws://127.0.0.1:8797" spellCheck={false} />
        </label>
      )}
      {msg && <div className={msg.ok ? 'ok-text acct-note' : 'err-text acct-note'} role="status">{msg.text}</div>}
      <div className="conn-form-actions">
        {conn && onRemoved && (confirmRemove
          ? <>
              <span className="dim">Удалить подключение «{conn.name}»? Сессии на сервере останутся.</span>
              <button className="btn sm stop" disabled={busy !== ''} onClick={() => void (async () => { setBusy('remove'); try { await connections.remove(conn.id); onRemoved(); } catch (e) { setMsg({ ok: false, text: ipcError(e) }); } finally { setBusy(''); } })()}>Удалить</button>
              <button className="btn sm" onClick={() => setConfirmRemove(false)}>Нет</button>
            </>
          : <button className="link-btn danger" onClick={() => setConfirmRemove(true)}>удалить подключение</button>)}
        <span className="spacer" />
        {managed && <button className="btn" disabled={!valid || busy !== ''} onClick={() => void test()}>{busy === 'test' ? 'Проверяю…' : 'Проверить'}</button>}
        <button className="btn primary" disabled={!valid || busy !== ''} onClick={() => void save()}>{conn ? 'Сохранить' : 'Подключить'}</button>
      </div>
    </div>
  );
}

function LocalLink({ conn }: { conn: Conn }) {
  const ipcM = window.perimeterIPC;
  return (
    <div className="conn-form">
      <label className="acct-row acct-check">
        <input type="checkbox" checked={conn.enabled} onChange={(e) => connections.setLocalEnabled(e.target.checked)} />
        <span>Запускать supervisor на этом компьютере вместе с приложением</span>
      </label>
      <div className="dim acct-note">Адрес: <span className="mono">{conn.wsUrl}</span>{conn.status ? ` · ${conn.status}` : ''}</div>
      {ipcM && conn.enabled && (
        <div className="conn-form-actions">
          <button className="btn sm" onClick={() => void (async () => { await ipcM.stopLocalSupervisor(); await ipcM.startLocalSupervisor(); })()}>Перезапустить</button>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog({ clients, initial, composerStyle, onComposerStyle, onClose }: {
  clients: ClientSet;
  /** открыть сразу на подключении / «Добавить подключение» */
  initial?: EnvId | 'add';
  composerStyle: ComposerStyle;
  onComposerStyle: (v: ComposerStyle) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const [page, setPage] = useState<Page>(initial === 'add' ? { kind: 'add' } : initial ? { kind: 'conn', id: initial } : { kind: 'general' });
  const [tab, setTab] = useState<ConnTab>('link');
  const [, tick] = useState(0);
  useEffect(() => connections.subscribe(() => tick((t) => t + 1)), []);
  const list = [...connections.list.filter((c) => c.kind === 'vps'), ...connections.list.filter((c) => c.kind === 'local')];
  const conn = page.kind === 'conn' ? connections.get(page.id) : undefined;
  const live = conn ? clients.get(conn.id).status === 'live' : false;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings two-pane" role="dialog" aria-label="Настройки" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="st-nav">
          <div className="modal-title">Настройки</div>
          <button className={`st-nav-item ${page.kind === 'general' ? 'on' : ''}`} onClick={() => setPage({ kind: 'general' })}><Icon name="settings" /> Общие</button>
          <div className="st-nav-title">Подключения</div>
          {list.map((c) => {
            const cl = clients.get(c.id);
            const dot = !c.enabled ? 'off' : cl.status === 'live' ? 'green' : cl.status === 'connecting' ? 'yellow' : 'red';
            return (
              <button key={c.id} className={`st-nav-item ${page.kind === 'conn' && page.id === c.id ? 'on' : ''}`} onClick={() => { setPage({ kind: 'conn', id: c.id }); setTab('link'); }}>
                <Icon name={c.kind === 'vps' ? 'server' : 'laptop'} /> <span className="st-nav-name">{c.name}</span>
                <span className={`dot dot-${dot}`} />
              </button>
            );
          })}
          <button className={`st-nav-item add ${page.kind === 'add' ? 'on' : ''}`} onClick={() => setPage({ kind: 'add' })}><Icon name="plus" /> Добавить подключение</button>
        </nav>
        <div className="st-body">
          {page.kind === 'general' && <General composerStyle={composerStyle} onComposerStyle={onComposerStyle} />}
          {page.kind === 'add' && (
            <>
              <h3 className="st-h">Новое подключение</h3>
              <p className="dim st-sub">VPS с запущенным supervisor'ом perimeter. Приложение поднимет к нему ssh-туннель и покажет его сессии отдельной секцией.</p>
              <ConnForm onSaved={(id) => { setPage({ kind: 'conn', id }); setTab('link'); }} />
            </>
          )}
          {page.kind === 'conn' && conn && (
            <>
              <h3 className="st-h">
                <Icon name={conn.kind === 'vps' ? 'server' : 'laptop'} /> {conn.name}
                <span className={`st-status ${live ? 'ok-text' : 'dim'}`}>{!conn.enabled ? 'выключено' : live ? 'на связи' : conn.status || 'подключаюсь…'}</span>
                {conn.kind === 'vps' && (
                  <label className="st-toggle">
                    <input type="checkbox" checked={conn.enabled} onChange={(e) => void connections.update(conn.id, { enabled: e.target.checked })} /> включено
                  </label>
                )}
              </h3>
              <div className="seg env-seg st-tabs" role="tablist">
                {([['link', 'Подключение'], ['accounts', 'Аккаунты и модели'], ['mcp', 'MCP'], ['projects', 'Проекты']] as const).map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
                ))}
              </div>
              {tab === 'link' && (conn.kind === 'local'
                ? <LocalLink conn={conn} />
                : (
                  <>
                    <ConnForm key={conn.id} conn={conn} onSaved={() => undefined} onRemoved={() => setPage({ kind: 'general' })} />
                    {connections.managed && <ServerInstall key={`srv-${conn.id}`} conn={conn} />}
                  </>
                ))}
              {tab === 'accounts' && <AccountsSettings clients={clients} envs={[conn.id]} initialEnv={conn.id} />}
              {tab === 'mcp' && <McpSettings client={clients.get(conn.id)} />}
              {tab === 'projects' && <ProjectsSettings clients={clients} envs={[conn.id]} initialEnv={conn.id} />}
            </>
          )}
          {page.kind === 'conn' && !conn && <p className="dim">Подключение «{envLabel(page.id)}» удалено.</p>}
          <div className="modal-actions st-actions">
            <button className="btn primary" onClick={onClose}>Готово</button>
          </div>
        </div>
      </div>
    </div>
  );
}
