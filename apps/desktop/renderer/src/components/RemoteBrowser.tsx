// Браузер на сервере (ретрансляция): Chromium запущен на машине подключения, сюда приходят кадры,
// отсюда уходят мышь и клавиатура. Видно ровно то, что видит браузер на VPS: его сеть, его localhost,
// его IP. Браузер живёт на сервере, пока его не закрыли (или 30 минут без зрителей) — панель можно
// закрыть и открыть снова, он подхватится.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { CmdError, envLabel, type SupervisorClient } from '../supervisor';
import { cdpButton, cdpModifiers, fitFrame, keyInput, rbAddress, rbViewport, toFramePoint, wheelDelta } from '../lib/remoteBrowser';
import { Icon } from './Icon';

/** Открытый браузер подключения (env → rbId) — переживает переключение вкладок и сессий. */
const rbOf = new Map<string, string>();

interface RbState { url: string; title: string; loading: boolean; canGoBack?: boolean; canGoForward?: boolean }

function errText(e: unknown): string {
  if (e instanceof CmdError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * tab — показать конкретную вкладку (её открыл и закроет supervisor, например окно входа в аккаунт): без кнопки
 * «закрыть», без подхвата «своего» браузера подключения; onExit — вкладка закрылась.
 */
export function RemoteBrowser({ client, tab, onExit, onState }: { client: SupervisorClient; tab?: string; onExit?: (reason?: string) => void; onState?: (st: { url: string; title: string; loading: boolean }) => void }) {
  const env = client.environment;
  const live = client.status === 'live';
  const fixed = tab !== undefined;
  const [rbId, setRbId] = useState<string | null>(() => tab ?? rbOf.get(env) ?? null);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'on' | 'error'>(() => (tab !== undefined || rbOf.has(env) ? 'on' : 'idle'));
  const [err, setErr] = useState('');
  const [st, setSt] = useState<RbState>({ url: '', title: '', loading: false });
  const [addr, setAddr] = useState('');
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [hasFrame, setHasFrame] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const addrRef = useRef<HTMLInputElement | null>(null);
  const viewRef = useRef(rbViewport(1280, 800));

  // другая среда — свой браузер
  const [envSeen, setEnvSeen] = useState(env);
  if (!fixed && envSeen !== env) {
    setEnvSeen(env);
    const id = rbOf.get(env) ?? null;
    setRbId(id);
    setPhase(id ? 'on' : 'idle');
    setHasFrame(false);
    setFrame(null);
  }

  // размер области → размер окна браузера на сервере (с задержкой, пока тянут край панели)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setStage({ w: r.width, h: r.height });
      const v = rbViewport(r.width, r.height);
      if (v.width === viewRef.current.width && v.height === viewRef.current.height) return;
      viewRef.current = v;
      if (t) clearTimeout(t);
      t = setTimeout(() => { const id = tab ?? rbOf.get(env); if (id) client.rbResize(id, v.width, v.height); }, 250);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (t) clearTimeout(t); };
  }, [client, env, tab]);

  // кадры и состояние страницы
  useEffect(() => {
    if (!rbId) return;
    return client.onRb(rbId, (e) => {
      if (e.type === 'frame') {
        const img = imgRef.current;
        if (img) {
          img.src = `data:image/jpeg;base64,${e.data}`;
          // кадр показан — просим следующий (сервер держит в пути не больше одного: задержка не копится)
          void img.decode().catch(() => undefined).finally(() => client.rbAck(rbId));
        } else client.rbAck(rbId);
        setHasFrame(true);
        setFrame((f) => (f && f.w === e.width && f.h === e.height ? f : { w: e.width, h: e.height }));
      } else if (e.type === 'state') {
        setSt(e);
        onState?.({ url: e.url, title: e.title, loading: e.loading });
        if (document.activeElement !== addrRef.current) setAddr(e.url === 'about:blank' ? '' : e.url);
      } else {
        if (fixed) { onExit?.(e.reason); return; }
        rbOf.delete(env);
        setRbId(null);
        setPhase('idle');
        setHasFrame(false);
        setErr(e.reason ? `Браузер на сервере закрылся: ${e.reason}` : 'Браузер на сервере закрылся');
      }
    });
  }, [client, rbId, env, fixed, onExit, onState]);

  // подписка на сервере живёт в соединении: после (пере)подключения — подписаться заново
  useEffect(() => {
    if (!rbId || !live) return;
    let on = true;
    client.rbAttach(rbId).then(
      (r) => {
        if (!on) return;
        setSt((s) => ({ ...s, url: r.url, title: r.title }));
        setAddr(r.url === 'about:blank' ? '' : r.url);
        setPhase('on');
        client.rbResize(rbId, viewRef.current.width, viewRef.current.height);
      },
      () => {
        if (!on) return;
        if (fixed) { onExit?.('вкладка уже закрыта'); return; }
        rbOf.delete(env);
        setRbId(null);
        setPhase('idle');
        setHasFrame(false);
      },
    );
    return () => { on = false; };
  }, [client, rbId, live, env, fixed, onExit]);

  // панель открыли заново, а браузер на сервере уже есть (из другого окна) — подхватить
  useEffect(() => {
    if (fixed || rbId || !live || phase !== 'idle') return;
    let on = true;
    client.rbList().then((l) => {
      const first = l[0];
      if (on && first && !rbOf.has(env)) { rbOf.set(env, first.rbId); setRbId(first.rbId); setPhase('on'); }
    }, () => undefined);
    return () => { on = false; };
  }, [client, live, env]);

  const start = async (url?: string) => {
    setPhase('starting');
    setErr('');
    try {
      const r = await client.rbOpen({ ...(url ? { url } : {}), ...viewRef.current, quality: 60 });
      rbOf.set(env, r.rbId);
      setRbId(r.rbId);
      setSt({ url: r.url, title: r.title, loading: true });
      setAddr(r.url === 'about:blank' ? '' : r.url);
      setPhase('on');
      stageRef.current?.focus();
    } catch (e) {
      setPhase('error');
      setErr(errText(e));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const url = rbAddress(addr);
    if (rbId) { client.rbNavigate(rbId, { url }); stageRef.current?.focus(); }
    else void start(url);
  };

  const closeBrowser = () => {
    if (rbId) client.rbClose(rbId);
    rbOf.delete(env);
    setRbId(null);
    setPhase('idle');
    setHasFrame(false);
    setFrame(null);
    setSt({ url: '', title: '', loading: false });
  };

  // ─── ввод ───
  const point = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    if (!img || !frame) return null;
    return toFramePoint({ x: e.clientX, y: e.clientY }, img.getBoundingClientRect(), frame);
  };
  const moveRef = useRef<{ x: number; y: number; buttons: number; mods: number } | null>(null);
  const rafRef = useRef(0);
  const flushMove = () => {
    rafRef.current = 0;
    const m = moveRef.current;
    moveRef.current = null;
    if (!m || !rbId) return;
    client.rbInput(rbId, { kind: 'mouse', type: 'move', x: m.x, y: m.y, button: m.buttons & 1 ? 'left' : m.buttons & 2 ? 'right' : 'none', ...(m.mods ? { modifiers: m.mods } : {}) });
  };
  const onMove = (e: RPointerEvent) => {
    const p = point(e);
    if (!p) return;
    moveRef.current = { ...p, buttons: e.buttons, mods: cdpModifiers(e) };
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushMove);
  };
  const onButton = (e: RPointerEvent, type: 'down' | 'up') => {
    const p = point(e);
    if (!p || !rbId) return;
    if (type === 'down') { stageRef.current?.focus(); e.currentTarget.setPointerCapture(e.pointerId); }
    const mods = cdpModifiers(e);
    client.rbInput(rbId, { kind: 'mouse', type, x: p.x, y: p.y, button: cdpButton(e.button), clickCount: Math.min(Math.max(e.detail || 1, 1), 3), ...(mods ? { modifiers: mods } : {}) });
  };
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // колесо — нативным слушателем: React вешает wheel пассивно, а прокрутку панели надо гасить
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !rbId) return;
    const onWheel = (e: WheelEvent) => {
      const p = point(e);
      if (!p) return;
      e.preventDefault();
      const d = wheelDelta(e, frame?.h ?? 800);
      client.rbInput(rbId, { kind: 'mouse', type: 'wheel', x: p.x, y: p.y, ...d });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const onKey = (e: RKeyboardEvent, type: 'down' | 'up') => {
    if (!rbId) return;
    const k = keyInput(e, type);
    if (!k) return; // Ctrl+V — придёт событием paste
    e.preventDefault();
    e.stopPropagation();
    client.rbInput(rbId, { ...k });
  };

  const box = frame ? fitFrame(stage, frame) : null;
  const where = envLabel(env);

  return (
    <div className="rb">
      <div className="bv-bar">
        <button className={`icon-btn sm ${rbId && st.canGoBack !== false ? '' : 'is-disabled'}`} aria-disabled={!rbId} onClick={() => rbId && client.rbNavigate(rbId, { action: 'back' })} aria-label="Назад" data-tip="Назад"><Icon name="arrowLeft" size={14} /></button>
        <button className={`icon-btn sm ${rbId && st.canGoForward ? '' : 'is-disabled'}`} aria-disabled={!rbId} onClick={() => rbId && client.rbNavigate(rbId, { action: 'forward' })} aria-label="Вперёд" data-tip="Вперёд"><Icon name="arrowRight" size={14} /></button>
        <button className={`icon-btn sm ${rbId ? '' : 'is-disabled'}`} aria-disabled={!rbId} onClick={() => rbId && client.rbNavigate(rbId, { action: st.loading ? 'stop' : 'reload' })} aria-label={st.loading ? 'Остановить' : 'Обновить'} data-tip={st.loading ? 'Остановить загрузку' : 'Обновить страницу'}>
          <Icon name={st.loading ? 'x' : 'refresh'} size={14} />
        </button>
        <form className="bv-addr" onSubmit={submit}>
          <span className="rb-where" data-tip={`Браузер запущен на «${where}»: его сеть, его localhost`}><Icon name={st.loading ? 'loader' : 'server'} size={14} className={st.loading ? 'spin' : ''} /></span>
          <input
            ref={addrRef}
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => { if (e.key === 'Escape') { setAddr(st.url === 'about:blank' ? '' : st.url); e.currentTarget.blur(); } }}
            placeholder="адрес или поиск — откроется на сервере"
            aria-label="Адрес в браузере на сервере"
            spellCheck={false}
            disabled={!live}
          />
        </form>
        {!fixed && <button className={`icon-btn sm ${rbId ? '' : 'is-disabled'}`} aria-disabled={!rbId} onClick={closeBrowser} aria-label="Закрыть браузер на сервере" data-tip="Закрыть браузер на сервере (освободит память VPS)"><Icon name="stop" size={14} /></button>}
      </div>
      <div
        ref={stageRef}
        className={`rb-stage ${rbId ? 'on' : ''}`}
        tabIndex={0}
        onPointerMove={rbId ? onMove : undefined}
        onPointerDown={rbId ? (e) => onButton(e, 'down') : undefined}
        onPointerUp={rbId ? (e) => onButton(e, 'up') : undefined}
        onContextMenu={(e) => { if (rbId) e.preventDefault(); }}
        onKeyDown={(e) => onKey(e, 'down')}
        onKeyUp={(e) => onKey(e, 'up')}
        onPaste={(e) => {
          if (!rbId) return;
          const text = e.clipboardData.getData('text');
          if (text) { e.preventDefault(); client.rbInput(rbId, { kind: 'text', text: text.slice(0, 100_000) }); }
        }}
        aria-label={`Браузер на «${where}»`}
      >
        <img ref={imgRef} className="rb-frame" alt="" draggable={false} style={box && hasFrame ? { width: box.w, height: box.h } : { display: 'none' }} />
        {rbId && !hasFrame && <div className="panel-empty rb-wait"><Icon name="loader" size={20} className="spin" /><div className="dim">Ждём первый кадр с «{where}»…</div></div>}
        {!rbId && (
          <div className="panel-empty rb-idle">
            <Icon name="globe" size={20} />
            <div>Браузер на «{where}»</div>
            <div className="dim rb-lead">
              Chromium запускается на сервере, сюда идёт картинка, отсюда — мышь и клавиатура.
              Сайты видят IP сервера, а localhost — это localhost сервера.
            </div>
            {phase === 'starting'
              ? <div className="dim"><Icon name="loader" size={14} className="spin" /> Запускаем Chromium на сервере…</div>
              : <button className="btn primary" disabled={!live} onClick={() => void start(addr.trim() ? rbAddress(addr) : undefined)}><Icon name="server" size={14} /> Запустить браузер на сервере</button>}
            {!live && <div className="warn-text">Нет связи с «{where}»</div>}
            {err && <div className="err-text rb-err">{err}</div>}
          </div>
        )}
      </div>
      {rbId && st.title && <div className="rb-foot dim" title={st.url}>{st.title}</div>}
    </div>
  );
}
