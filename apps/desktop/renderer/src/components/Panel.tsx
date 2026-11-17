// Система панелей (BD2): вкладки-пилюли, прикрепление справа/снизу/слева или плавающее окно
// (перетаскивание за шапку, ресайз за края, зоны прилипания), «на весь экран», ресайз за кромку.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import type { SessionView, SupervisorClient } from '../supervisor';
import {
  PANEL_TABS, WIDTH_DEFAULT, WIDTH_MIN, HEIGHT_DEFAULT, clampHeight, clampRect, clampWidth, dockTo, fitTabs,
  resizeRect, snapZone, zoneRect, type DockSide, type Edge, type PanelState, type PanelTab, type Rect, type WorkArea,
} from '../lib/panelLayout';
import { ctxView } from '../lib/toolFormat';
import { extractPlan, fileChanges } from '../lib/feedModel';
import { PANEL_META } from './SessionHeader';
import { Icon } from './Icon';
import { usePopover } from './ui';
import { ChangesTab, ContextTab, TasksTab } from './PanelTabs';
import { FilesTab } from './FilesTab';
import { TerminalTab } from './TerminalTab';
import { BrowserTab, openInBrowserTab } from './BrowserTab';
import { PortsTab } from './PortsTab';
import { termManager } from '../terminals';

type SetPanel = (fn: (s: PanelState) => PanelState) => void;

/** Минимум ширины центра, который панель не отнимает при креплении сбоку. */
const CENTER_MIN = 400;
const SIDEBAR_W = 320;

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

/** Перетаскивание указателем: move/up на window, курсор и запрет выделения на время жеста. */
function drag(e: RPointerEvent, cursor: string, onMove: (ev: PointerEvent) => void, onUp?: (ev: PointerEvent) => void) {
  e.preventDefault();
  document.body.classList.add('dragging');
  document.body.style.cursor = cursor;
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('dragging');
    document.body.style.cursor = '';
    onUp?.(ev);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const EDGE_CURSOR: Record<Edge, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
const DOCK_LABEL: Record<DockSide | 'floating', string> = { right: 'Справа', bottom: 'Снизу', left: 'Слева', floating: 'Плавающая' };

export function Panel({ state, setState, session, client, workRef, selectedFile, onSelectFile, onReveal, onMention }: {
  state: PanelState;
  setState: SetPanel;
  session?: SessionView | undefined;
  client: SupervisorClient;
  /** рабочая область (центр + панель) — для зон прилипания */
  workRef: React.RefObject<HTMLDivElement | null>;
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
  /** показать элемент ленты (прокрутить к нему) */
  onReveal: (itemId: string) => void;
  /** вставить текст (@путь) в строку ввода */
  onMention: (text: string) => void;
}) {
  const vp = useViewport();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<{ rect: Rect; zone: DockSide | null } | null>(null);
  const floating = dragging !== null || state.dock === 'floating';
  const full = state.fullscreen && dragging === null;

  const workArea = (): WorkArea => {
    const r = workRef.current?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : { left: SIDEBAR_W, top: 0, right: vp.w, bottom: vp.h };
  };

  // ─── геометрия ───
  // сбоку: 360…900, но центру остаётся хотя бы CENTER_MIN — и в отрисовке, и в сохранённой ширине
  const sideMax = Math.max(WIDTH_MIN, vp.w - SIDEBAR_W - CENTER_MIN);
  const sideW = Math.min(state.width, sideMax);
  const floatRect = dragging?.rect ?? clampRect(state.float, vp);
  let style: CSSProperties = {};
  if (full) style = {};
  else if (floating) style = { left: floatRect.x, top: floatRect.y, width: floatRect.w, height: floatRect.h };
  else if (state.dock === 'bottom') style = { height: clampHeight(state.height, vp.h) };
  else style = { width: sideW };
  const mode = full ? 'full' : floating ? 'floating' : `dock-${state.dock}`;

  // ─── ресайз прикреплённой панели за кромку ───
  const startDockResize = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const sw = sideW;
    const sh = clampHeight(state.height, vp.h);
    const dock = state.dock;
    drag(e, dock === 'bottom' ? 'ns-resize' : 'ew-resize', (ev) => {
      if (dock === 'bottom') setState((s) => ({ ...s, height: clampHeight(sh - (ev.clientY - sy), window.innerHeight) }));
      else setState((s) => ({ ...s, width: Math.min(clampWidth(dock === 'right' ? sw - (ev.clientX - sx) : sw + (ev.clientX - sx)), Math.max(WIDTH_MIN, window.innerWidth - SIDEBAR_W - CENTER_MIN)) }));
    });
  };

  // ─── ресайз плавающей за края и углы ───
  const startFloatResize = (e: RPointerEvent, edge: Edge) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const start = clampRect(state.float, vp);
    drag(e, EDGE_CURSOR[edge], (ev) => {
      const r = clampRect(resizeRect(start, edge, ev.clientX - sx, ev.clientY - sy), { w: window.innerWidth, h: window.innerHeight });
      setState((s) => ({ ...s, float: r }));
    });
  };

  // ─── перетаскивание за шапку: плавающую — двигаем, прикреплённую — открепляем после сдвига ───
  const startMove = (e: RPointerEvent) => {
    if (e.button !== 0 || full) return;
    if ((e.target as HTMLElement).closest('button, input, select, a, [data-nodrag]')) return;
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const wasFloating = state.dock === 'floating';
    const size = { w: wasFloating ? floatRect.w : state.float.w, h: wasFloating ? floatRect.h : state.float.h };
    // точка захвата внутри окна (у прикреплённой — пропорционально по ширине)
    const ox = wasFloating ? sx - box.left : Math.min((sx - box.left) * (size.w / box.width), size.w - 48);
    const oy = Math.min(sy - box.top, 36);
    let started = false;
    let last: { rect: Rect; zone: DockSide | null } | null = null;
    drag(e, 'grabbing', (ev) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      started = true;
      const rect = clampRect({ x: ev.clientX - ox, y: ev.clientY - oy, w: size.w, h: size.h }, { w: window.innerWidth, h: window.innerHeight });
      last = { rect, zone: snapZone({ x: ev.clientX, y: ev.clientY }, workArea()) };
      setDragging(last);
    }, () => {
      setDragging(null);
      if (!started || !last) return;
      const { rect, zone } = last;
      if (zone) setState((s) => dockTo(s, zone));
      else setState((s) => ({ ...s, dock: 'floating', float: rect, fullscreen: false }));
    });
  };

  // ─── вкладки ───
  const changes = session ? fileChanges(session.items) : [];
  const plan = session ? extractPlan(session.items) : null;
  const ctx = session ? ctxView(client.contextBySession.get(session.id)) : null;
  const terms = session ? termManager(client).count(session.id) : 0;
  const badge = (t: PanelTab): ReactNode => {
    if (t === 'changes' && changes.length > 0) return <span className="tab-badge">{changes.length}</span>;
    if (t === 'terminal' && terms > 0) return <span className="tab-badge">{terms}</span>;
    if (t === 'tasks' && plan) return <span className="tab-badge">{plan.done}/{plan.total}</span>;
    if (t === 'context' && ctx) return <span className="tab-badge">{ctx.pct}%</span>;
    return null;
  };
  const tabIcon = (t: PanelTab): ReactNode => (t === 'context' && ctx
    ? <span className={`mini-ring ${ctx.pct >= 80 ? 'hot' : ctx.pct >= 60 ? 'warm' : ''}`} style={{ '--p': ctx.pct } as CSSProperties} />
    : <Icon name={PANEL_META[t].icon} />);
  const tabNode = (t: PanelTab, extra?: { onClick?: () => void; inMenu?: boolean }) => (
    <button
      key={t}
      role={extra?.inMenu ? 'menuitem' : 'tab'}
      aria-selected={extra?.inMenu ? undefined : state.tab === t}
      className={`ptab ${state.tab === t ? 'on' : ''}`}
      onClick={extra?.onClick ?? (() => setState((s) => ({ ...s, tab: t })))}
      {...(!extra?.inMenu && PANEL_META[t].key ? { 'data-tip': PANEL_META[t].label, 'data-key': PANEL_META[t].key } : {})}
    >
      {tabIcon(t)}<span>{PANEL_META[t].label}</span>{badge(t)}
    </button>
  );

  // не влезающие вкладки — в «⋯»; ширины меряем на скрытой копии ряда
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState<number[]>(PANEL_TABS.map((_, i) => i));
  const activeIdx = PANEL_TABS.indexOf(state.tab);
  const badgeKey = `${changes.length}|${terms}|${plan?.done}/${plan?.total}|${ctx?.pct}`;
  useLayoutEffect(() => {
    const box = tabsRef.current;
    const m = measureRef.current;
    if (!box || !m) return;
    const measure = () => {
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth);
      const next = fitTabs(widths, box.clientWidth, 32, activeIdx, 2);
      setShown((cur) => (cur.join(',') === next.join(',') ? cur : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [activeIdx, badgeKey]);
  const hidden = PANEL_TABS.filter((_, i) => !shown.includes(i));
  const morePop = usePopover();
  const setPop = usePopover();

  const setDock = (d: DockSide | 'floating') => {
    setPop.setOpen(false);
    if (d === 'floating') {
      // открепляем «на месте»: окно у того края, где панель стояла
      const box = rootRef.current?.getBoundingClientRect();
      setState((s) => {
        if (s.dock === 'floating') return s;
        const at = box ? { x: box.right - s.float.w - 24, y: box.top + 56, w: s.float.w, h: s.float.h } : s.float;
        return { ...s, dock: 'floating', fullscreen: false, float: clampRect(at, vp) };
      });
    }
    else setState((s) => ({ ...dockTo(s, d), fullscreen: false }));
  };

  let body: ReactNode;
  switch (state.tab) {
    case 'changes':
      body = <ChangesTab changes={changes} selected={selectedFile} onSelect={onSelectFile} onReveal={onReveal} />;
      break;
    case 'tasks':
      body = session ? <TasksTab session={session} client={client} plan={plan} onReveal={onReveal} /> : null;
      break;
    case 'context':
      body = <ContextTab session={session} client={client} ctx={ctx} />;
      break;
    case 'files':
      body = session ? <FilesTab session={session} client={client} changes={changes} onMention={onMention} /> : null;
      break;
    case 'terminal':
      body = session ? <TerminalTab session={session} client={client} onReveal={onReveal} /> : null;
      break;
    case 'browser':
      body = session ? <BrowserTab session={session} client={client} /> : null;
      break;
    case 'ports':
      body = session
        ? <PortsTab session={session} client={client} onOpenInBrowser={(url) => { openInBrowserTab(session.id, client.environment, url); setState((s) => ({ ...s, tab: 'browser' })); }} />
        : null;
      break;
  }

  return (
    <>
      <div ref={rootRef} className={`panel ${mode}`} style={style} role="complementary" aria-label="Панель">
        {!full && !floating && (
          <div
            className="panel-resize"
            onPointerDown={startDockResize}
            onDoubleClick={() => setState((s) => (s.dock === 'bottom' ? { ...s, height: HEIGHT_DEFAULT } : { ...s, width: WIDTH_DEFAULT }))}
            data-tip="Потяните, чтобы изменить размер; двойной клик — по умолчанию"
          ><span className="grip" /></div>
        )}
        <div
          className="panel-head"
          onPointerDown={startMove}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            if (state.dock === 'floating') setState((s) => dockTo(s, s.lastDock));
          }}
        >
          <div className="ptabs" ref={tabsRef} role="tablist">
            {PANEL_TABS.map((t, i) => (shown.includes(i) ? tabNode(t) : null))}
            {hidden.length > 0 && (
              <div className="pmore" ref={morePop.ref}>
                <button className={`icon-btn ${morePop.open ? 'on' : ''}`} onClick={() => morePop.setOpen(!morePop.open)} aria-label="Ещё вкладки" data-tip="Ещё вкладки"><Icon name="more" /></button>
                {morePop.open && (
                  <div className="menu pmore-menu" role="menu">
                    {hidden.map((t) => tabNode(t, { inMenu: true, onClick: () => { morePop.setOpen(false); setState((s) => ({ ...s, tab: t })); } }))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="ptabs-measure" ref={measureRef} aria-hidden>
            {PANEL_TABS.map((t) => <span key={t} className="ptab">{tabIcon(t)}<span>{PANEL_META[t].label}</span>{badge(t)}</span>)}
          </div>
          <div className="panel-actions">
            {floating
              ? <button className="icon-btn" onClick={() => setState((s) => dockTo(s, s.lastDock))} aria-label="Прикрепить" data-tip={`Прикрепить: ${DOCK_LABEL[state.lastDock].toLowerCase()} (или двойной клик по шапке)`}><Icon name="pin" /></button>
              : <button className="icon-btn" onClick={() => setDock('floating')} aria-label="Открепить" data-tip="Открепить — плавающее окно (или потяните за шапку)"><Icon name="pinOff" /></button>}
            <button
              className={`icon-btn ${full ? 'on' : ''}`}
              onClick={() => setState((s) => ({ ...s, open: true, fullscreen: !s.fullscreen }))}
              aria-label={full ? 'Свернуть' : 'На весь экран'}
              data-tip={full ? 'Свернуть' : 'На весь экран'}
              data-key={full ? 'Esc' : 'Ctrl Shift F'}
            ><Icon name={full ? 'minimize' : 'maximize'} /></button>
            <button className="icon-btn is-disabled" aria-disabled="true" aria-label="Отдельным окном" data-tip="Отдельным окном ОС — следующий шаг"><Icon name="appWindow" /></button>
            <div className="picker" ref={setPop.ref}>
              <button className={`icon-btn ${setPop.open ? 'on' : ''}`} onClick={() => setPop.setOpen(!setPop.open)} aria-label="Настройки панели" data-tip="Настройки панели"><Icon name="settings" /></button>
              {setPop.open && (
                <div className="menu panel-settings" role="menu">
                  <div className="menu-title">Положение панели</div>
                  <div className="seg wide" role="group" aria-label="Положение панели">
                    {(['right', 'bottom', 'left', 'floating'] as const).map((d) => (
                      <button key={d} className={!full && state.dock === d ? 'on' : ''} aria-pressed={state.dock === d} onClick={() => setDock(d)}>
                        <Icon name={d === 'right' ? 'panelRight' : d === 'bottom' ? 'panelBottom' : d === 'left' ? 'panelLeft' : 'appWindow'} size={14} />
                        {DOCK_LABEL[d]}
                      </button>
                    ))}
                  </div>
                  <button role="menuitem" onClick={() => { setPop.setOpen(false); setState((s) => ({ ...s, width: WIDTH_DEFAULT, height: HEIGHT_DEFAULT, float: clampRect({ ...s.float, w: WIDTH_DEFAULT, h: 600 }, vp) })); }}>
                    Сбросить размер <span className="menu-hint">{WIDTH_DEFAULT} px</span>
                  </button>
                  <div className="menu-note">Плавающую панель тяните за шапку; у края окна появятся зоны прилипания.</div>
                </div>
              )}
            </div>
            <button className="icon-btn" onClick={() => setState((s) => ({ ...s, open: false, fullscreen: false }))} aria-label="Закрыть панель" data-tip="Закрыть" data-key="Ctrl \"><Icon name="x" /></button>
          </div>
        </div>
        <div className={`panel-body tab-${state.tab}`}>
          {session || state.tab === 'context'
            ? body
            : <div className="panel-empty">Выберите сессию слева.</div>}
        </div>
        {floating && !full && EDGES.map((edge) => (
          <div key={edge} className={`float-edge e-${edge}`} onPointerDown={(e) => startFloatResize(e, edge)} />
        ))}
      </div>
      {dragging && <SnapZones area={workArea()} active={dragging.zone} state={state} />}
    </>
  );
}

/** Зоны прилипания во время перетаскивания: все три — бледно, под курсором — подсвечена. */
function SnapZones({ area, active, state }: { area: WorkArea; active: DockSide | null; state: PanelState }) {
  return (
    <div className="snap-layer" aria-hidden>
      {(['right', 'bottom', 'left'] as const).map((side) => {
        const r = zoneRect(side, area, state);
        return (
          <div key={side} className={`snap-zone ${active === side ? 'on' : ''}`} style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
            <span>{DOCK_LABEL[side]}</span>
          </div>
        );
      })}
    </div>
  );
}

