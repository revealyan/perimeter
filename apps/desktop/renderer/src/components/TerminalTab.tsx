// Вкладка «Терминал» (BD2, P1): под-вкладки терминалов сессии («bash · /opt/perimeter», «＋»),
// xterm в палитре BD2, плашка «Терминал на VPS · папка сессии», пометка упрощённого режима (pipe, без PTY),
// внизу — «Команды агента» (идущие Bash из ленты) со «Стоп».
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionView, SupervisorClient } from '../supervisor';
import { envLabel, isRemote } from '../supervisor';
import { termManager } from '../terminals';
import { filesModel } from '../files';
import { termDir, termTitle } from '../lib/termModel';
import { runningCommands } from '../lib/feedModel';
import { Icon } from './Icon';
import { RunningCmdCard, useNow } from './PanelTabs';

export function TerminalTab({ session, client, onReveal }: {
  session: SessionView;
  client: SupervisorClient;
  onReveal: (itemId: string) => void;
}) {
  const mgr = termManager(client);
  const sid = session.id;
  const s = mgr.get(sid);
  const active = mgr.activeEntry(s);
  const live = client.status === 'live';
  const boxRef = useRef<HTMLDivElement | null>(null);
  // корень сессии — для полного пути в подписи (cwd в ack относительный): из модели «Файлов» или папки проекта
  const fm = filesModel(client, sid);
  const [, setTick] = useState(0);
  useEffect(() => fm.subscribe(() => setTick((t) => t + 1)), [fm]);
  useEffect(() => { if (live && !fm.root && !fm.dirs.has('')) void fm.loadDir(''); }, [fm, live]);
  const project = session.projectId ? client.projects.find((p) => p.id === session.projectId) : undefined;
  const root = fm.root ?? project?.path ?? null;

  // показ вкладки / смена сессии / реконнект: подключиться к открытым терминалам, открыть первый, если пусто
  useEffect(() => {
    if (live) void mgr.ensure(sid);
  }, [sid, live, s.status, s.epoch]);

  // xterm активного терминала — в контейнер (экземпляр живёт в менеджере, React его не пересоздаёт)
  useLayoutEffect(() => {
    mgr.mount(sid, boxRef.current);
  }, [sid, active?.key, s.terms.length]);

  // размер панели меняется (ресайз, плавающее окно, на весь экран) — подгоняем cols/rows
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => mgr.fit(sid));
    });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [sid]);

  const running = runningCommands(session.items);
  const now = useNow(running.length > 0);
  const env = client.environment;

  let overlay: ReactNode = null;
  if (s.status === 'error' && s.terms.length === 0) {
    overlay = (
      <div className="term-overlay">
        <Icon name="alert" size={20} />
        <div>Терминал недоступен</div>
        <div className="dim">{s.error}</div>
        <button className="btn sm" onClick={() => mgr.retry(sid)}><Icon name="refresh" size={14} /> Повторить</button>
      </div>
    );
  } else if (s.terms.length === 0 && (s.status === 'loading' || s.status === 'idle')) {
    overlay = <div className="term-overlay dim">{live ? 'Подключаемся к терминалам сессии…' : 'Нет связи с supervisor — терминалы подключатся после переподключения.'}</div>;
  } else if (s.terms.length === 0) {
    overlay = (
      <div className="term-overlay">
        <Icon name="terminal" size={20} />
        <div>Терминалов нет</div>
        <div className="dim">Терминал откроется в папке сессии · {envLabel(env)}.</div>
        <div className="term-overlay-actions">
          <button className="btn sm" onClick={() => void mgr.open(sid)} aria-disabled={!live}><Icon name="plus" size={14} /> Открыть терминал</button>
          <button className="btn ghost sm" onClick={() => void mgr.open(sid, 'claude')} aria-disabled={!live}><Icon name="bot" size={14} /> claude</button>
        </div>
        {s.openError && <div className="err-text">{s.openError}</div>}
      </div>
    );
  }

  return (
    <div className="term-tab">
      <div className="term-tabs" role="tablist" aria-label="Терминалы сессии">
        {s.terms.map((t) => {
          const on = t.key === active?.key;
          const title = t.termId ? termTitle(t, root) : 'запускается…';
          return (
            <div key={t.key} role="tab" aria-selected={on} tabIndex={0} className={`term-subtab ${on ? 'on' : ''} ${t.alive ? '' : 'dead'}`}
              onClick={() => { mgr.select(sid, t.key); requestAnimationFrame(() => mgr.focus(sid)); }}
              onKeyDown={(e) => { if (e.key === 'Enter') mgr.select(sid, t.key); }}
              onAuxClick={(e) => { if (e.button === 1) mgr.close(sid, t.key); }}
              title={t.note ?? (t.alive ? title : `${title} — завершён${t.exitCode !== null ? `, код ${t.exitCode}` : ''}`)}>
              <Icon name="terminal" size={14} />
              <span className="term-subtab-name">{title}</span>
              {!t.alive && <span className="dot" aria-label="завершён" />}
              <button className="term-x" aria-label="Закрыть терминал" data-tip={t.alive ? 'Закрыть терминал (процесс завершится)' : 'Убрать'} onClick={(e) => { e.stopPropagation(); mgr.close(sid, t.key); }}>
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
        <button className={`icon-btn sm ${live ? '' : 'is-disabled'}`} aria-disabled={!live} onClick={() => live && void mgr.open(sid)} aria-label="Новый терминал" data-tip="Новый терминал в папке сессии">
          <Icon name="plus" size={14} />
        </button>
        <button className={`icon-btn sm ${live ? '' : 'is-disabled'}`} aria-disabled={!live} onClick={() => live && void mgr.open(sid, 'claude')} aria-label="Запустить claude" data-tip="Новый терминал с запуском claude в папке сессии (интерактивному CLI нужен PTY)">
          <Icon name="bot" size={14} />
        </button>
      </div>
      <div className="term-box">
        <div className="term-head">
          <Icon name={isRemote(env) ? 'server' : 'laptop'} size={14} />
          <span className="term-where">Терминал · {envLabel(env)}</span>
          <span className="dim term-cwd mono">{(active?.termId ? termDir(active.cwd, root) : '') || 'папка сессии'}</span>
          {active?.mode === 'pipe' && active.termId && (
            <span className="term-pill warn" data-tip="На сервере нет PTY: цвета и интерактивные программы (vim, top) не работают; строку набираете здесь, Enter отправляет её целиком">
              упрощённый режим: без PTY
            </span>
          )}
          <span className="spacer" />
          {s.syncing && s.terms.length > 0 && <Icon name="loader" size={12} className="spin dim" />}
          <span className={`term-conn ${live ? 'ok' : 'off'}`}>
            <span className={`dot ${live ? 'dot-green' : 'dot-amber'}`} />{live ? (!isRemote(env) ? 'локально ✓' : window.perimeterIPC ? 'ssh ✓' : 'на связи') : 'нет связи'}
          </span>
        </div>
        {s.openError && s.terms.length > 0 && (
          <div className="term-err" role="alert">
            <span>Новый терминал не открылся: {s.openError}</span>
            <button className="toast-x" aria-label="Скрыть" onClick={() => { s.openError = null; client.notify(); }}>×</button>
          </div>
        )}
        <div className="term-view" ref={boxRef} onClick={() => mgr.focus(sid)} />
        {overlay}
      </div>
      <section className="term-agent">
        <div className="term-agent-head">
          <Icon name="bot" size={14} />
          <b>Команды агента</b><span className="dim">· {running.length}</span>
          <span className="spacer" />
          <span className="dim term-agent-sess" title={session.name}>сессия «{session.name}»</span>
        </div>
        {running.length === 0
          ? <div className="panel-note">Сейчас агент ничего не выполняет.</div>
          : running.map((r) => <RunningCmdCard key={r.itemId} r={r} now={now} onReveal={onReveal} onStop={() => client.interrupt(sid)} />)}
      </section>
    </div>
  );
}
