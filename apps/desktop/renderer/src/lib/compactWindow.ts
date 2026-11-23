// Окно автокомпакта (autoCompactWindow Claude Code): когда контекст подходит к нему, история сжимается в выжимку.
// Для длинных окон (glm с 1M) владелец ставит 400–600K — чтобы сессия не «сгорала» на огромном контексте.
// Claude Code читает окно только при старте процесса: смена у идущей сессии — между ходами (процесс перезапускается
// с той же историей).
import { tokensLabel } from './outputLimit';

export const COMPACT_STEPS = [200_000, 300_000, 400_000, 500_000, 600_000, 800_000] as const;

export interface CompactOption { value: number | null; label: string }

/** Варианты: «как у модели» + шаги; нестандартное текущее — тоже в списке. */
export function compactOptions(current: number | undefined, defaultLabel = 'как у модели'): CompactOption[] {
  const steps: number[] = [...COMPACT_STEPS];
  if (current !== undefined && !steps.includes(current)) steps.push(current);
  steps.sort((a, b) => a - b);
  return [{ value: null, label: defaultLabel }, ...steps.map((n) => ({ value: n, label: tokensLabel(n) }))];
}
