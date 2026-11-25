// Лента в терминальной манере (BD2): блоки «› ты» и «◆ агент» с полосой статуса слева,
// шаги — однострочниками колонками (✓ глагол · цель · итог), правка — с дифом, запросы — промптом Y/N/A.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FeedItem, SessionView, SupervisorClient } from '../supervisor';
import { Markdown, CodeBlock } from './Markdown';
import { DiffView } from './DiffView';
import { AskPrompt } from './Ask';
import { Icon } from './Icon';
import { FullText } from './ui';
import { compactJson, fmtCost, fmtDuration, resultView, shortPath, toolHead, type ResultView } from '../lib/toolFormat';
import { bindDelegateWorkers, changedRange, feedBlocks, isRunning, lastAction, segments, stepResult, stepsSummary, type FeedBlock } from '../lib/feedModel';
import { lineSummary, moreLines } from '../lib/multiline';
import { clock, countOf } from '../lib/ru';
import { STATE_LABEL } from './labels';
import { explainApiError, isApiErrorText, retryLine } from '../lib/apiErrors';
import { requestComposerAction } from '../composeBus';

/** Уже этой ширины «Рядом» в дифе не влезает — построчно. */
const COMPACT_W = 760;

/** Последнее сообщение пользователя (для «Повторить» после упавшего хода); null — пусто. */
function retryPrompt(s: SessionView): string | null {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i]!;
    if (it.kind === 'user') {
      const t = String(it.data['text'] ?? '').trim();
      return t !== '' ? t : null;
    }
    // после сообщения пользователя была ошибка API — годится; иначе ход прошёл дальше
    if (it.kind === 'text' && !isApiErrorText(String(it.data['text'] ?? ''))) return null;
  }
  return null;
}

/** Связь карточек делегирования с воркерами + действия блока (открыть ленту, остановить). */
export interface DelegateTools {
  /** id tool-use-карточки delegate_to_agent → id сессии воркера */
  bind: Map<string, string>;
  byId: Map<string, SessionView>;
  open: (id: string) => void;
  stop: (id: string) => void;
  /** подтянуть историю ленты (воркер живёт отдельной сессией — грузим при раскрытии карточки) */
  load: (id: string) => void;
}

export const DELEGATE_TOOL_NAME = 'mcp__perimeter__delegate_to_agent';

export function Feed({ session, client, onOpenChange, onOpenSession }: {
  session: SessionView;
  client: SupervisorClient;
  /** открыть файл в панели «Изменения» */
  onOpenChange: (path: string) => void;
  /** открыть ленту другой сессии (воркера делегирования) */
  onOpenSession?: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [compact, setCompact] = useState(false);

  // автоскролл только если пользователь и так был внизу; иначе — кнопка «к последнему»
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };
  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  useLayoutEffect(() => { stick.current = true; setAtBottom(true); toBottom(); }, [session.id]);
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  });
  // ширина ленты: при открытой панели диф «Рядом» не влезает
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < COMPACT_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loading = session.state === 'initializing' || session.state === 'creating' || session.resyncing === true;
  const empty = session.items.length === 0 && !session.printing && session.permissions.length === 0;
  const busy = session.state === 'working' || session.state === 'waiting_permission' || session.state === 'waiting_input';
  const blocks = feedBlocks(session.items);
  // воркеры делегирования этой сессии: связь карточек с ними (FIFO) и действия блока
  const delegateTools = useMemo<DelegateTools>(() => {
    const workers = [...client.sessions.values()].filter((v) => v.parentSessionId === session.id);
    return {
      bind: bindDelegateWorkers(session.items, workers),
      byId: new Map(workers.map((w) => [w.id, w])),
      open: (id) => onOpenSession?.(id),
      stop: (id) => client.stopSession(id),
      load: (id) => client.ensureHistory(id),
    };
  }, [client, session, onOpenSession]);
  // вызов, на котором стоит запрос разрешения: после ресинка он помечен законченным, но результата нет
  const waiting = new Set(session.permissions.filter((p) => !p.questions?.length).map((p) => `${p.toolName}|${JSON.stringify(p.input)}`));
  const last = blocks[blocks.length - 1];
  // ответ печатается в открытый блок агента; если его нет (только что спросили) — в новый
  const printInLast = last?.kind === 'agent' && !last.turn;

  return (
    <div className="feed-wrap">
      <div className="feed" ref={scroller} onScroll={onScroll}>
        <div className="feed-col">
          {/* T2: сессия приехала из другой среды — отметка с итогом переноса */}
          {session.movedFrom !== undefined && (
            <div className="feed-moved" role="note">
              <Icon name="arrowRight" size={12} />
              Сессия переехала из «{session.movedFrom}» — история и настройки с собой, работа продолжается здесь
            </div>
          )}
          {loading && empty && (
            <div className="feed-skeleton" aria-label="загрузка ленты">
              <div className="skeleton-line w40" />
              <div className="skeleton-line w70" />
              <div className="skeleton-line w85" />
            </div>
          )}
          {!loading && empty && (
            <div className="feed-empty">
              <div className="feed-empty-title">Сессия пуста</div>
              <div className="dim">Напишите задачу — сессия живёт на сервере и переживёт обрыв связи.</div>
            </div>
          )}
          {blocks.map((b, i) => {
            if (b.kind === 'user') return <UserBlock key={b.key} item={b.item} />;
            if (b.kind === 'event') return <EventLine key={b.key} item={b.item} />;
            const isLast = i === blocks.length - 1;
            return (
              <AgentBlock
                key={b.key}
                block={b}
                model={session.model}
                live={isLast && !b.turn && busy}
                printing={isLast && printInLast ? session.printing : null}
                compact={compact}
                waiting={waiting}
                onOpenChange={onOpenChange}
                delegateTools={delegateTools}
              />
            );
          })}
          {session.printing && !printInLast && (
            <AgentBlock
              block={{ kind: 'agent', key: 'printing', items: [], ...(lastUserTs(blocks) !== undefined ? { startTs: lastUserTs(blocks)! } : {}) }}
              model={session.model}
              live
              printing={session.printing}
              compact={compact}
              waiting={waiting}
              onOpenChange={onOpenChange}
              delegateTools={delegateTools}
            />
          )}
          {session.retry && <RetryLine retry={session.retry} gateway={client.profiles.find((p) => p.name === session.profile)?.keyEditable === true} />}
          {/* ход упал ошибкой API и не идёт повтор — «повторить» и «сменить модель» */}
          {retryPrompt(session) !== null && session.retry === undefined && session.state !== 'working' && (
            <div className="turn-error-actions" role="group" aria-label="Ход упал">
              <span className="dim">ход упал</span>
              <span className="spacer" />
              <button className="btn ghost sm" data-tip="Открою выбор аккаунта и модели в поле ввода" onClick={() => requestComposerAction('open-model')}>Сменить модель</button>
              <button className="btn tint sm" data-tip="Отправлю последнее сообщение заново" onClick={() => { const t = retryPrompt(session); if (t !== null) client.sendText(session.id, t); }}>Повторить</button>
            </div>
          )}
          {session.permissions.map((p) => <AskPrompt key={p.requestId} card={p} sid={session.id} client={client} compact={compact} />)}
        </div>
      </div>
      {!atBottom && (
        <button className="to-bottom" onClick={() => { stick.current = true; toBottom(true); }}><Icon name="arrowDown" size={14} /> к последнему</button>
      )}
    </div>
  );
}

function lastUserTs(blocks: FeedBlock[]): number | undefined {
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k]!;
    if (b.kind === 'user') return b.item.ts;
  }
  return undefined;
}

/** Текущее время, тикает раз в секунду (для «работает 0:12»), только пока нужно. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

// ─── блоки ──────────────────────────────────────────────────────────────────

function UserBlock({ item }: { item: FeedItem }) {
  const imgs = Array.isArray(item.data['images']) ? (item.data['images'] as string[]) : [];
  const text = String(item.data['text'] ?? '').trim();
  return (
    <div className="block user">
      <div className="block-head">
        <span className="glyph">›</span>
        <b>ты</b>
        {item.ts && <span className="block-meta mono">{timeOf(item.ts)}</span>}
        {item.data['queued'] === true && <span className="block-meta queued" data-tip="Отправлено во время хода — агент прочитает на следующем шаге, без отдельного хода">в очереди</span>}
      </div>
      {imgs.length > 0 && (
        <div className="msg-imgs">
          {imgs.map((b64, i) => <img key={i} src={imgSrc(b64)} alt={`вложение ${i + 1}`} />)}
        </div>
      )}
      {text !== '' && <div className="user-text">{text}</div>}
    </div>
  );
}

function AgentBlock({ block, model, live, printing, compact, waiting, onOpenChange, delegateTools }: {
  block: Extract<FeedBlock, { kind: 'agent' }>;
  model: string | undefined;
  live: boolean;
  printing: string | null;
  compact: boolean;
  waiting: Set<string>;
  onOpenChange: (path: string) => void;
  delegateTools: DelegateTools;
}) {
  const now = useNow(live && block.startTs !== undefined);
  const turn = block.turn;
  const ok = !turn || turn.data['subtype'] === undefined || turn.data['subtype'] === 'success';
  const tone = live ? 'run' : !ok ? 'bad' : turn ? 'ok' : 'idle';
  const meta: string[] = [];
  if (model) meta.push(model);
  if (live) meta.push(block.startTs !== undefined ? `работает ${clock(now - block.startTs)}` : 'работает');
  else if (typeof turn?.data['durationMs'] === 'number') meta.push(fmtDuration(turn.data['durationMs']));
  // total_cost_usd в потоковой сессии накопительный — это стоимость сессии на конец хода
  const cost = typeof turn?.data['costUsd'] === 'number' ? fmtCost(turn.data['costUsd']) : null;

  return (
    <div className={`block agent tone-${tone}`}>
      <div className="block-head">
        <span className="glyph diamond">◆</span>
        <b>агент</b>
        {meta.length > 0 && <span className="block-meta mono">{meta.join(' · ')}</span>}
        {cost && <span className="block-meta mono" data-tip="Стоимость сессии на конец этого хода"> · {cost}</span>}
      </div>
      {segments(block.items).map((seg) => (seg.kind === 'steps'
        ? <StepsGroup key={seg.key} items={seg.items} compact={compact} waiting={waiting} onOpenChange={onOpenChange} delegateTools={delegateTools} />
        : <AgentItem key={seg.key} item={seg.item} />))}
      {printing && <div className="agent-text printing"><Markdown text={printing} /><span className="caret">▍</span></div>}
      {!ok && <div className="event-line bad">ход прерван</div>}
    </div>
  );
}

/** Запрос к модели повторяется: что случилось и что делать, пока Claude Code ждёт следующей попытки. */
function RetryLine({ retry, gateway }: { retry: NonNullable<SessionView['retry']>; gateway: boolean }) {
  const why = explainApiError({ status: retry.status, error: retry.error, gateway });
  return (
    <div className={`retry-line tone-${why.tone}`} role="status">
      <span className="retry-spin" aria-hidden><Icon name="loader" size={14} /></span>
      <span className="retry-what">{retryLine(retry)} · <b>{why.title}</b></span>
      {why.hint && <span className="retry-hint">{why.hint}</span>}
    </div>
  );
}

/** «API Error: …» от Claude Code — блоком ошибки с объяснением; исходный текст — мелко, для точности. */
function ApiErrorBlock({ text }: { text: string }) {
  const why = explainApiError({ text });
  return (
    <div className={`api-error tone-${why.tone}`} role="alert">
      <div className="api-error-title"><Icon name="alert" size={14} /> {why.title}</div>
      {why.hint && <div className="api-error-hint">{why.hint}</div>}
      <div className="api-error-raw mono">{text}</div>
    </div>
  );
}

function AgentItem({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case 'text': {
      const text = String(item.data['text'] ?? '');
      if (isApiErrorText(text)) return <ApiErrorBlock text={text} />;
      return <div className="agent-text"><Markdown text={text} /></div>;
    }
    case 'thinking':
      return (
        <details className="thinking">
          <summary>размышления</summary>
          <div className="thinking-body"><Markdown text={String(item.data['text'] ?? '')} /></div>
        </details>
      );
    default:
      return <EventLine item={item} />;
  }
}

function EventLine({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case 'state':
      return <div className="event-line">{String(item.data['text'])}</div>;
    case 'error':
      return <div className="feed-error"><b>{String(item.data['code'] ?? 'Ошибка')}</b> {String(item.data['text'])}</div>;
    case 'permission-log': {
      const b = String(item.data['behavior']);
      return <div className={`event-line perm-${b}`}>{b === 'allow' ? 'разрешено' : b === 'deny' ? 'отклонено' : `без ответа${item.data['reason'] ? ` · ${String(item.data['reason'])}` : ''}`}</div>;
    }
    case 'subagent':
      return <div className="event-line">{item.data['phase'] === 'start' ? `субагент${item.data['agentType'] ? ` ${String(item.data['agentType'])}` : ''} запущен` : 'субагент закончил'}</div>;
    case 'turn':
      return null;
    default:
      return null;
  }
}

// ─── шаги ───────────────────────────────────────────────────────────────────

function StepsGroup({ items, compact, waiting, onOpenChange, delegateTools }: { items: FeedItem[]; compact: boolean; waiting: Set<string>; onOpenChange: (path: string) => void; delegateTools: DelegateTools }) {
  const sum = stepsSummary(items);
  const [open, setOpen] = useState(true);
  return (
    <div className="steps">
      <button className="steps-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        <b>{countOf(sum.count, ['шаг', 'шага', 'шагов'])}</b>
        {sum.files > 0 && <span> · {countOf(sum.files, ['файл изменён', 'файла изменено', 'файлов изменено'])}</span>}
        {sum.durationMs !== undefined && <span> · {fmtDuration(sum.durationMs)}</span>}
        {(sum.added > 0 || sum.removed > 0) && <span className="mono"> <span className="add">+{sum.added}</span> <span className="del">−{sum.removed}</span></span>}
        {sum.running > 0 && <span className="run-text"> · выполняется {sum.running}</span>}
        {sum.errors > 0 && <span className="err-text"> · {countOf(sum.errors, ['ошибка', 'ошибки', 'ошибок'])}</span>}
      </button>
      {open && (
        <div className="steps-rows">
          {items.map((it) => <StepItem key={it.id} item={it} compact={compact} waiting={waiting} onOpenChange={onOpenChange} delegateTools={delegateTools} />)}
        </div>
      )}
    </div>
  );
}

function StepItem({ item, compact, waiting, onOpenChange, delegateTools }: { item: FeedItem; compact: boolean; waiting: Set<string>; onOpenChange: (path: string) => void; delegateTools: DelegateTools }) {
  switch (item.kind) {
    case 'tool-use':
      return <StepRow item={item} compact={compact} asking={item.data['result'] === undefined && waiting.has(`${String(item.data['name'])}|${JSON.stringify(item.data['input'])}`)} onOpenChange={onOpenChange} delegateTools={delegateTools} />;
    case 'tool-result':
      return <OrphanResult item={item} />;
    case 'permission-log': {
      const b = String(item.data['behavior']);
      return (
        <div className={`step-mini perm-${b}`}>
          <Icon name={b === 'allow' ? 'check' : 'x'} size={14} />
          {b === 'allow' ? 'разрешено' : b === 'deny' ? 'отклонено' : `без ответа${item.data['reason'] ? ` · ${String(item.data['reason'])}` : ''}`}
        </div>
      );
    }
    case 'subagent':
      return (
        <div className="step-mini">
          <Icon name="bot" size={14} />
          {item.data['phase'] === 'start' ? `субагент${item.data['agentType'] ? ` ${String(item.data['agentType'])}` : ''} запущен` : 'субагент закончил'}
        </div>
      );
    default:
      return null;
  }
}

/**
 * Лента воркера внутри раскрытой карточки делегирования (как сабсессии Claude Code Desktop):
 * задача, шаги и реплики воркера видны прямо в родительской ленте — подгружаются из его сессии
 * при первом раскрытии (ensureHistory), дальше едут живьём. Воркер сам не делегирует (глубина 1),
 * поэтому шагам отдаётся пустой stub-DelegateTools — рекурсии нет.
 */
function WorkerFeed({ item, delegateTools, onOpenChange }: { item: FeedItem; delegateTools: DelegateTools; onOpenChange: (path: string) => void }) {
  const wid = delegateTools.bind.get(String(item.data['id']));
  const w = wid !== undefined ? delegateTools.byId.get(wid) : undefined;
  useEffect(() => { if (wid !== undefined) delegateTools.load(wid); }, [wid]); // гварды внутри стора
  if (!w) return null;
  const stub: DelegateTools = { bind: new Map(), byId: new Map(), open: delegateTools.open, stop: delegateTools.stop, load: delegateTools.load };
  let promptShown = false;
  return (
    <div className="dw-feed">
      <div className="dw-feed-head dim">
        {w.items.length === 0 && w.state !== 'working' && w.state !== 'creating' && w.state !== 'initializing'
          ? 'лента воркера загружается…'
          : 'что делал воркер'}
      </div>
      {w.items.map((it) => {
        if (it.kind === 'tool-use' || it.kind === 'tool-result' || it.kind === 'permission-log') {
          return <StepItem key={it.id} item={it} compact waiting={new Set()} onOpenChange={onOpenChange} delegateTools={stub} />;
        }
        if (it.kind === 'text') {
          const t = String((it.data as { text?: string }).text ?? '');
          if (t.trim() === '') return null;
          return <div className="dw-text" key={it.id}>{t}</div>;
        }
        if (it.kind === 'user' && !promptShown) {
          promptShown = true;
          const t = String((it.data as { text?: string }).text ?? '');
          return t.trim() === '' ? null : <div className="dw-prompt" key={it.id}>задача: {t}</div>;
        }
        return null; // thinking/state/turn — шум для врезки
      })}
      {w.items.length === 0 && (w.state === 'working' || w.state === 'creating' || w.state === 'initializing') && (
        <div className="dw-text dim">воркер ещё не начал отвечать…</div>
      )}
    </div>
  );
}

function StepRow({ item, compact, asking, onOpenChange, delegateTools }: { item: FeedItem; compact: boolean; asking: boolean; onOpenChange: (path: string) => void; delegateTools: DelegateTools }) {
  const name = String(item.data['name']);
  const input = item.data['input'];
  const running = isRunning(item);
  const done = !running;
  const isError = item.data['isError'] === true;
  const head = toolHead(name, input);
  const res = asking ? { text: 'ждёт разрешения', tone: 'warn' as const } : stepResult(name, input, item.data['result'], isError, done);
  const view = resultView(name, input, item.data['result'], isError);
  const isPath = head.kind === 'read' || head.kind === 'edit' || head.kind === 'write';
  const target = lineSummary(isPath ? shortPath(head.target) : head.target);
  // правка и ошибка раскрыты сразу; остальное — по клику
  const [open, setOpen] = useState<boolean>(isError || name === 'Edit' || name === 'MultiEdit');
  const [full, setFull] = useState(false);
  useEffect(() => { if (isError) setOpen(true); }, [isError]);
  const patch = view.type === 'patch' ? view.patch : null;

  return (
    <div className={`step ${isError ? 'is-error' : asking ? 'is-asking' : running ? 'is-running' : ''} ${open ? 'open' : ''}`} id={`feed-${item.id}`}>
      <div
        className="step-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return; // Enter на «+N строк» — это его клик
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); }
          if (e.code === 'KeyO' && patch) { e.preventDefault(); onOpenChange(patch.path); }
        }}
      >
        <span className="step-ico">{isError ? <Icon name="x" size={14} /> : asking ? <Icon name="lock" size={14} /> : running ? <Icon name="loader" size={14} className="spin" /> : <Icon name="check" size={14} />}</span>
        <span className="step-verb">{head.verb}</span>
        <span className="step-target mono" title={head.note ? `${head.note}\n${head.target}` : head.target}>
          <span className="step-first">{target.first || '—'}</span>
          {target.extra > 0 && (
            <button
              className={`ml-more ${full ? 'on' : ''}`}
              aria-expanded={full}
              onClick={(e) => { e.stopPropagation(); setFull(!full); }}
              data-tip={full ? 'Свернуть' : 'Показать целиком'}
            >{moreLines(target.extra)}</button>
          )}
        </span>
        <span className={`step-res tone-${res.tone}`}>
          {'added' in res && res.added !== undefined
            ? <span className="mono"><span className="add">+{res.added}</span>{res.removed ? <> <span className="del">−{res.removed}</span></> : null}</span>
            : res.text}
        </span>
      </div>
      {full && <FullText text={head.target} className="step-full" />}
      {name === DELEGATE_TOOL_NAME && (() => {
        // живой блок воркера: статус его сессии, чем занят, переход в ленту и стоп — видно и в свёрнутой карточке
        const wid = delegateTools.bind.get(String(item.data['id']));
        const w = wid !== undefined ? delegateTools.byId.get(wid) : undefined;
        if (!w) return null;
        const working = w.state === 'working' || w.state === 'waiting_permission' || w.state === 'waiting_input';
        return (
          <div className="dw" onClick={(e) => e.stopPropagation()}>
            <span className={`dw-dot ${working ? 'run' : w.state === 'error' ? 'bad' : 'idle'}`} />
            <span className="dw-status">{STATE_LABEL[w.state] ?? w.state} · {w.needs ?? lastAction(w.items, w.printing)}</span>
            <span className="dw-actions">
              <button className="btn ghost sm" onClick={() => delegateTools.open(w.id)}>Открыть ленту</button>
              {w.state !== 'dead' && <button className="btn ghost sm" onClick={() => delegateTools.stop(w.id)}>Стоп</button>}
            </span>
          </div>
        );
      })()}
      {open && (
        <div className="step-body">
          {head.note && <div className="step-note">{head.note}</div>}
          {name === DELEGATE_TOOL_NAME && <WorkerFeed item={item} delegateTools={delegateTools} onOpenChange={onOpenChange} />}
          {patch
            ? <DiffView
                patch={patch}
                allowSplit={!compact}
                head={(
                  <>
                    <Icon name={name === 'Write' ? 'filePlus' : 'file'} size={14} />
                    <span className="mono">{shortPath(patch.path, 3)}</span>
                    <span className="mono"><span className="add">+{patch.added}</span> <span className="del">−{patch.removed}</span></span>
                    {changedRange(patch) && <span className="dim">· {changedRange(patch)}</span>}
                    <button className="link-btn" onClick={() => onOpenChange(patch.path)} data-tip="Все правки этого файла" data-key="O">в Изменениях →</button>
                  </>
                )}
              />
            : view.type === 'none'
              ? (done ? <div className="tool-empty">вывода нет</div> : <pre className="tool-raw">{compactJson(input, 2000)}</pre>)
              : <ResultBody view={view} />}
        </div>
      )}
    </div>
  );
}

function OrphanResult({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const isError = item.data['isError'] === true;
  const name = String(item.data['toolName'] ?? '');
  return (
    <div className={`step ${isError ? 'is-error' : ''}`}>
      <div className="step-row" role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(!open); }}>
        <span className="step-ico"><Icon name={isError ? 'x' : 'check'} size={14} /></span>
        <span className="step-verb">Результат</span>
        <span className="step-target mono">{name}</span>
        <span className="step-res" />
      </div>
      {open && <div className="step-body"><ResultBody view={resultView(name, undefined, item.data['result'], isError)} /></div>}
    </div>
  );
}

const MAX_LINES = 14;

function Collapsible({ text, className }: { text: string; className: string }) {
  const lines = text.split('\n');
  const [all, setAll] = useState(false);
  const long = lines.length > MAX_LINES;
  return (
    <>
      <pre className={className}>{all || !long ? text : lines.slice(0, MAX_LINES).join('\n')}</pre>
      {long && <button className="link-btn" onClick={() => setAll(!all)}>{all ? 'свернуть' : `показать всё (${lines.length} строк)`}</button>}
    </>
  );
}

function ResultBody({ view }: { view: ResultView }) {
  switch (view.type) {
    case 'none':
      return null;
    case 'console':
      return (
        <div className="tool-body">
          {view.stdout !== '' && <Collapsible text={view.stdout.replace(/\n$/, '')} className="console" />}
          {view.stderr !== '' && <Collapsible text={view.stderr.replace(/\n$/, '')} className="console err" />}
          {view.stdout === '' && view.stderr === '' && <div className="tool-empty">вывода нет</div>}
          {view.interrupted && <div className="tool-empty">прервано</div>}
        </div>
      );
    case 'text':
      if (view.markdown) return <div className="tool-body md-result"><Markdown text={view.text} /></div>;
      if (view.lang && !view.error) return <div className="tool-body"><CodeBlock code={view.text} lang={view.lang} collapsible /></div>;
      return <div className="tool-body"><Collapsible text={view.text} className={`console ${view.error ? 'err' : ''}`} /></div>;
    case 'patch':
      return <div className="tool-body"><DiffView patch={view.patch} /></div>;
    case 'files':
      return (
        <div className="tool-body">
          <ul className="file-list">
            {view.files.slice(0, 30).map((f) => <li key={f} title={f}>{shortPath(f, 4)}</li>)}
          </ul>
          {(view.files.length > 30 || view.truncated) && <div className="tool-empty">всего {view.total}{view.truncated ? '+' : ''}</div>}
          {view.files.length === 0 && <div className="tool-empty">ничего не найдено</div>}
        </div>
      );
    case 'image':
      return (
        <div className="tool-body">
          <img className="result-img" src={view.src} alt="результат" />
          {view.caption && <div className="tool-empty">{view.caption}</div>}
        </div>
      );
    case 'answers':
      return (
        <div className="tool-body">
          {view.pairs.map((p) => <div key={p.q} className="answer"><span className="dim">{p.q}</span> <b>{p.a}</b></div>)}
        </div>
      );
    case 'todos':
      return (
        <ul className="tool-body todo-list">
          {view.items.map((t, i) => (
            <li key={i} className={`todo-${t.status}`}>
              <span aria-hidden>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span> {t.text}
            </li>
          ))}
        </ul>
      );
  }
}

// ─── утилиты ────────────────────────────────────────────────────────────────

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** src для <img>: принимает и полный dataURL, и сырой base64. */
function imgSrc(b64: string): string {
  return b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
}
