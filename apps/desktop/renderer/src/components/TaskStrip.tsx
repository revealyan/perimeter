// Список задач над полем ввода — как в Claude Code Desktop: пока у агента есть незавершённые задачи, видна
// строка «Задачи 2/5 · что делается сейчас»; по клику — весь список. План — тот же, что в панели «Задачи».
import { useState } from 'react';
import type { Plan } from '../lib/feedModel';
import { compactPlan } from '../lib/planView';
import { Icon, type IconName } from './Icon';

const ICON: Record<string, IconName> = { completed: 'check', in_progress: 'loader', pending: 'circleDashed' };

/** Показывать ли полоску: есть план и в нём осталось несделанное. */
export const showTaskStrip = (plan: Plan | null): plan is Plan => plan !== null && plan.done < plan.total;

export function TaskStrip({ plan, onReveal }: { plan: Plan; onReveal: (itemId: string) => void }) {
  const [open, setOpen] = useState(false);
  const v = compactPlan(plan);
  const shown = open ? plan.items : v.top;
  return (
    <div className={`task-strip ${open ? 'open' : ''}`}>
      <button type="button" className="task-strip-head" onClick={() => setOpen(!open)} aria-expanded={open} data-tip={open ? 'Свернуть' : 'Весь список'}>
        <Icon name="listChecks" size={14} />
        <b>Задачи</b>
        <span className="dim">{plan.done}/{plan.total}</span>
        <span className="spacer" />
        <span className="dim task-strip-toggle">{open ? 'свернуть' : 'развернуть'}</span>
        <Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} className="dim" />
      </button>
      <ul className="plan task-strip-list">
        {!open && v.done > 0 && <li className="plan-completed task-strip-done"><Icon name="check" size={14} /><span>выполнено: {v.done}</span></li>}
        {shown.map((t, i) => (
          <li key={i} className={`plan-${t.status}`}>
            <Icon name={ICON[t.status] ?? 'circleDashed'} size={14} className={t.status === 'in_progress' ? 'spin' : undefined} />
            <span>{t.status === 'in_progress' && t.active ? t.active : t.text}</span>
          </li>
        ))}
        {!open && v.morePending > 0 && (
          <li className="task-strip-more"><button type="button" className="link-btn" onClick={() => setOpen(true)}>ещё {v.morePending}…</button></li>
        )}
        {open && <li className="task-strip-foot"><button type="button" className="link-btn" onClick={() => onReveal(plan.itemId)}>в ленте</button></li>}
      </ul>
    </div>
  );
}
