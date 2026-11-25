// Компактный вид списка задач, как в Claude Code (CLI/Desktop): сразу видны текущая и ближайшие задачи, выполненные —
// одной строкой «✓ N выполнено», остальное — по «развернуть». Владелец 2026-11-25: «планировщик постоянно расширяется
// и жиреет — верхние задачи сразу видны и есть развернуть».
import type { Plan, PlanItem } from './feedModel';

export interface PlanView {
  /** в работе и ближайшие несделанные — по порядку */
  top: PlanItem[];
  /** несделанных сверх показанных */
  morePending: number;
  done: number;
}

export function compactPlan(plan: Plan, maxTop = 3): PlanView {
  const open = plan.items.filter((t) => t.status !== 'completed');
  // в работе — первыми, дальше несделанные в порядке плана
  const ordered = [...open.filter((t) => t.status === 'in_progress'), ...open.filter((t) => t.status !== 'in_progress')];
  const top = ordered.slice(0, maxTop);
  return { top, morePending: ordered.length - top.length, done: plan.done };
}
