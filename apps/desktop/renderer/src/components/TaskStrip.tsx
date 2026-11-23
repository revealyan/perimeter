// Список задач над полем ввода — как в Claude Code Desktop: пока у агента есть незавершённые задачи, видна
// строка «Задачи 2/5 · что делается сейчас»; по клику — весь список. План — тот же, что в панели «Задачи».
import { useState } from 'react';
import type { Plan } from '../lib/feedModel';
import { Icon, type IconName } from './Icon';

const ICON: Record<string, IconName> = { completed: 'check', in_progress: 'loader', pending: 'circleDashed' };

/** Показывать ли полоску: есть план и в нём осталось несделанное. */
export const showTaskStrip = (plan: Plan | null): plan is Plan => plan !== null && plan.done < plan.total;

export function TaskStrip({ plan, onReveal }: { plan: Plan; onReveal: (itemId: string) => void }) {
  const [open, setOpen] = useState(false);
  const cur = plan.items.find((t) => t.status === 'in_progress');
  return (
    <div className={`task-strip ${open ? 'open' : ''}`}>
      <button type="button" className="task-strip-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="listChecks" size={14} />
        <b>Задачи</b>
        <span className="dim">{plan.done}/{plan.total}</span>
        {cur && <span className="task-strip-cur">· {cur.active || cur.text}</span>}
        <span className="spacer" />
        <Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} className="dim" />
      </button>
      {open && (
        <ul className="plan task-strip-list">
          {plan.items.map((t, i) => (
            <li key={i} className={`plan-${t.status}`}>
              <Icon name={ICON[t.status] ?? 'circleDashed'} size={14} className={t.status === 'in_progress' ? 'spin' : undefined} />
              <span>{t.status === 'in_progress' && t.active ? t.active : t.text}</span>
            </li>
          ))}
          <li className="task-strip-foot"><button type="button" className="link-btn" onClick={() => onReveal(plan.itemId)}>в ленте</button></li>
        </ul>
      )}
    </div>
  );
}
