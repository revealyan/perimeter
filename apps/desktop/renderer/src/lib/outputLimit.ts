// Лимит ответа аккаунта (CLAUDE_CODE_MAX_OUTPUT_TOKENS): варианты выбора в настройках.
// Claude Code для незнакомых ему моделей (glm…) по умолчанию даёт 32K, потолок — 128K: на xhigh размышления
// длиннее и упираются в 32K (обрезаются) — поэтому отдельный лимит «на xhigh и max».

export const OUTPUT_STEPS = [32_000, 64_000, 96_000, 128_000] as const;

export const tokensLabel = (n: number): string => (n % 1000 === 0 ? `${n / 1000}K` : String(n));

export interface LimitOption { value: number | null; label: string }

/** Варианты «обычно»: по умолчанию Claude Code + шаги; нестандартное текущее значение — тоже в списке. */
export function normalOptions(current: number | undefined): LimitOption[] {
  const out: LimitOption[] = [{ value: null, label: 'по умолчанию Claude Code (32K)' }];
  for (const n of withCurrent(OUTPUT_STEPS.filter((x) => x > 32_000), current)) out.push({ value: n, label: tokensLabel(n) });
  return out;
}

/** Варианты «на xhigh и max»: как обычно + шаги. */
export function highOptions(current: number | undefined): LimitOption[] {
  const out: LimitOption[] = [{ value: null, label: 'как обычно' }];
  for (const n of withCurrent(OUTPUT_STEPS.filter((x) => x > 32_000), current)) out.push({ value: n, label: tokensLabel(n) });
  return out;
}

function withCurrent(steps: readonly number[], current: number | undefined): number[] {
  const list = [...steps];
  if (current !== undefined && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}
