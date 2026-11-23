// Содержимое вкладок панели: Изменения (файлы сессии и полный диф по всем правкам файла),
// Задачи (план из TodoWrite и идущие команды), Контекст (кольцо и разбивка).
// Файлы, Терминал и Браузер — в FilesTab / TerminalTab / BrowserTab.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { SessionView, SupervisorClient } from '../supervisor';
import { profileLabel } from '../supervisor';
import { fmtCost, fmtDuration, fmtTokens, shortPath, type CtxView } from '../lib/toolFormat';
import { changesTotal, mergePatches, runningCommands, sessionCost, type FileChange, type Plan, type RunningCmd } from '../lib/feedModel';
import { clock, countOf } from '../lib/ru';
import { DiffView } from './DiffView';
import { Icon, type IconName } from './Icon';
import { MultiLine } from './ui';
import { modeLabel } from './SessionHeader';
import { compactOptions } from '../lib/compactWindow';
import { tokensLabel } from '../lib/outputLimit';

function splitDir(p: string): { dir: string; base: string } {
  const parts = p.split(/[\\/]/).filter(Boolean);
  const base = parts.pop() ?? p;
  return { dir: parts.length ? shortPath(parts.join('/'), 3) : '', base };
}

// ─── Изменения ──────────────────────────────────────────────────────────────

export function ChangesTab({ changes, selected, onSelect, onReveal }: {
  changes: FileChange[];
  selected: string | null;
  onSelect: (path: string | null) => void;
  onReveal: (itemId: string) => void;
}) {
  const cur = changes.find((c) => c.path === selected) ?? changes[0];
  // в агрегат попадают только применённые правки — набор id однозначно задаёт диф (без пересчёта на каждый кадр)
  const ids = cur ? `${cur.path}|${cur.itemIds.join(',')}` : '';
  const merged = useMemo(() => (cur ? mergePatches(cur.path, cur.patches) : null), [ids]);
  if (!cur || !merged) {
    return (
      <div className="panel-empty">
        <Icon name="diff" size={20} />
        <div>Файлы ещё не менялись.</div>
        <div className="dim">Правки агента появятся здесь — по файлам, все правки файла одним дифом.</div>
      </div>
    );
  }
  const total = changesTotal(changes);
  return (
    <div className="changes-tab">
      <div className="ch-summary">
        <b>{countOf(total.files, ['файл', 'файла', 'файлов'])}</b>
        <span className="mono"><span className="add">+{total.added}</span> <span className="del">−{total.removed}</span></span>
      </div>
      <div className="ch-files" role="listbox" aria-label="Изменённые файлы">
        {changes.map((c) => {
          const { dir, base } = splitDir(c.path);
          const on = c.path === cur.path;
          return (
            <button key={c.path} role="option" aria-selected={on} className={`ch-file ${on ? 'on' : ''}`} onClick={() => onSelect(c.path)} title={c.path}>
              <Icon name={c.created ? 'filePlus' : 'file'} size={14} />
              <span className="ch-path mono">{dir && <span className="dim">{dir}/</span>}{base}</span>
              {c.patches.length > 1 && <span className="ch-n dim">{countOf(c.patches.length, ['правка', 'правки', 'правок'])}</span>}
              <span className="mono ch-stat"><span className="add">+{c.added}</span> <span className="del">−{c.removed}</span></span>
            </button>
          );
        })}
      </div>
      <div className="ch-diff">
        <DiffView
          className="tall"
          patch={merged}
          head={<><span className="mono">{splitDir(cur.path).base}</span><span className="dim">· {cur.patches.length > 1 ? `${countOf(cur.patches.length, ['правка', 'правки', 'правок'])} подряд` : '1 правка'}</span></>}
        />
        <div className="ch-end">
          <Icon name="check" size={14} />
          <span>Это все правки файла{cur.patches.length > 1 ? ` (${cur.patches.length})` : ''}.</span>
          <button className="link-btn" onClick={() => onReveal(cur.itemIds[cur.itemIds.length - 1]!)}>показать в ленте</button>
        </div>
      </div>
    </div>
  );
}

// ─── Задачи ─────────────────────────────────────────────────────────────────

export function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Идущая команда агента (Bash без результата): текст, время, «Показать в ленте» и «Стоп» (interrupt хода). */
export function RunningCmdCard({ r, now, onReveal, onStop }: { r: RunningCmd; now: number; onReveal: (itemId: string) => void; onStop: () => void }) {
  return (
    <div className="run-cmd">
      <div className="run-cmd-head">
        <Icon name="bot" size={14} />
        <span className="run-cmd-text mono"><MultiLine text={r.command} /></span>
        <span className="info-text mono">{r.startedAt !== undefined ? `идёт ${clock(now - r.startedAt)}` : 'идёт'}</span>
      </div>
      {r.description && <div className="dim run-cmd-desc">{r.description}</div>}
      <div className="thin-progress" aria-hidden><span /></div>
      <div className="run-actions">
        <button className="btn ghost sm" onClick={() => onReveal(r.itemId)}><Icon name="eye" size={14} /> Показать в ленте</button>
        <button className="btn stop sm" onClick={onStop} data-tip="Прервёт весь ход агента — остановить одну команду пока нельзя"><Icon name="stop" size={14} /> Стоп</button>
      </div>
    </div>
  );
}

const PLAN_ICON: Record<string, IconName> = { completed: 'check', in_progress: 'loader', pending: 'circleDashed' };

export function TasksTab({ session, client, plan, onReveal }: { session: SessionView; client: SupervisorClient; plan: Plan | null; onReveal: (itemId: string) => void }) {
  const running = runningCommands(session.items);
  const now = useNow(running.length > 0);
  return (
    <div className="tasks-tab">
      <section className="psec">
        <div className="psec-title">
          <Icon name="listChecks" size={14} />
          <span>План агента</span>
          {plan && <span className="dim">{plan.done}/{plan.total}</span>}
          <span className="spacer" />
          {plan && <button className="link-btn" onClick={() => onReveal(plan.itemId)}>в ленте</button>}
        </div>
        {plan ? (
          <>
            <div className="plan-bar" aria-hidden>{plan.items.map((t, i) => <span key={i} className={`pb-${t.status}`} />)}</div>
            <ul className="plan">
              {plan.items.map((t, i) => (
                <li key={i} className={`plan-${t.status}`}>
                  <Icon name={PLAN_ICON[t.status] ?? 'circleDashed'} size={14} />
                  <span>{t.status === 'in_progress' && t.active ? t.active : t.text}</span>
                </li>
              ))}
            </ul>
          </>
        ) : <div className="panel-note">Агент ещё не составлял список задач в этой сессии. Включается в настройках аккаунта («список задач»).</div>}
      </section>
      <section className="psec">
        <div className="psec-title"><Icon name="terminal" size={14} /><span>Идущие команды · {running.length}</span></div>
        {running.length === 0 && <div className="panel-note">Сейчас ничего не выполняется.</div>}
        {running.map((r) => (
          <RunningCmdCard key={r.itemId} r={r} now={now} onReveal={onReveal} onStop={() => client.interrupt(session.id)} />
        ))}
      </section>
    </div>
  );
}

// ─── Контекст ───────────────────────────────────────────────────────────────

export function ContextTab({ session, client, ctx }: { session?: SessionView | undefined; client: SupervisorClient; ctx: CtxView | null }) {
  const profile = session?.profile ? client.profiles.find((p) => p.name === session.profile) : undefined;
  const cost = session ? sessionCost(session) : undefined;
  const project = session?.projectId ? client.projects.find((p) => p.id === session.projectId) : undefined;
  return (
    <div className="context-tab">
      <section className="psec">
        <div className="psec-title"><Icon name="gauge" size={14} /><span>Окно контекста</span></div>
        {ctx ? (
          <>
            <div className="ctx-row">
              <div className={`ctx-ring ${ctx.pct >= 80 ? 'hot' : ctx.pct >= 60 ? 'warm' : ''}`} style={{ '--p': ctx.pct } as CSSProperties}>
                <span>{ctx.pct}%</span>
              </div>
              <div className="ctx-labels">
                {ctx.used !== undefined && ctx.max !== undefined
                  ? <div><b>{fmtTokens(ctx.used)}</b> <span className="dim">из {fmtTokens(ctx.max)} токенов</span></div>
                  : <div className="dim">окно контекста</div>}
                {ctx.pct >= 80 && <div className="warn-text">скоро автосжатие</div>}
              </div>
            </div>
            {ctx.parts.length > 0 && (
              <ul className="ctx-parts">
                {ctx.parts.filter((p) => p.kind === 'used').map((p) => (
                  <li key={p.name}>
                    <span>{p.name}</span>
                    <span className="ctx-part-bar" aria-hidden><span style={{ width: `${ctx.used ? Math.max(2, (p.tokens / ctx.used) * 100) : 0}%` }} /></span>
                    <span className="dim mono">{fmtTokens(p.tokens)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : <div className="panel-note">{session ? 'Появится, когда процесс сессии запущен.' : 'Сессия не выбрана.'}</div>}
        {session && (
          <div className="ctx-compact">
            <label>
              <span>Автокомпакт</span>
              <select
                aria-label="Окно автокомпакта"
                value={session.compactWindow ?? ''}
                disabled={client.status !== 'live' || session.state === 'working' || session.state === 'waiting_permission' || session.state === 'waiting_input'}
                onChange={(e) => void client.setSessionSettings(session.id, { compactWindow: e.target.value === '' ? null : Number(e.target.value) })}
              >
                {compactOptions(session.compactWindow, `как у аккаунта${profile?.compactWindow ? ` (${tokensLabel(profile.compactWindow)})` : ''}`).map((o) => <option key={o.label} value={o.value ?? ''}>{o.label}</option>)}
              </select>
            </label>
            <div className="dim panel-note">Когда контекст подходит к этому окну, Claude Code сжимает историю. Меняется между ходами — процесс перезапустится с той же историей.</div>
          </div>
        )}
      </section>
      {session && (
        <section className="psec">
          <div className="psec-title"><span>Сессия</span></div>
          <dl className="kv">
            <dt>Аккаунт</dt><dd>{profile ? profileLabel(profile) : session.profile ?? 'по умолчанию'}</dd>
            <dt>Модель</dt><dd className="mono">{session.model ?? '—'}</dd>
            <dt>Режим</dt><dd>{modeLabel(session.permissionMode)}</dd>
            {project && <><dt>Папка</dt><dd className="mono" title={project.path}>{project.path}</dd></>}
            <dt>Стоимость</dt><dd className="mono">{cost !== undefined ? fmtCost(cost) : '—'}</dd>
          </dl>
        </section>
      )}
      {session?.lastResult && (
        <section className="psec">
          <div className="psec-title"><span>Последний ход</span></div>
          <dl className="kv">
            <dt>Итог</dt><dd>{session.lastResult.subtype === 'success' || !session.lastResult.subtype ? 'завершён' : 'прерван'}</dd>
            <dt>Время</dt><dd>{session.lastResult.durationMs !== undefined ? fmtDuration(session.lastResult.durationMs) : '—'}</dd>
            <dt>Шагов</dt><dd>{session.lastResult.numTurns ?? '—'}</dd>
          </dl>
        </section>
      )}
    </div>
  );
}
