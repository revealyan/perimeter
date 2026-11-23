// Лимит ответа модели — переменная Claude Code; без зависимости от SDK (нужна и движку, и адаптеру SDK).

/** Переменная лимита ответа Claude Code: для незнакомых ему моделей (glm…) по умолчанию 32000, потолок 128000. */
export const OUTPUT_TOKENS_VAR = 'CLAUDE_CODE_MAX_OUTPUT_TOKENS';

/**
 * env-оверлей лимита ответа. Через settings.env Claude Code меняет его и на ходу (applyFlagSettings, проверено
 * подставным шлюзом 23.11: 32000 → 128000 → 64000 между ходами). Снять ключом undefined нельзя — значение
 * остаётся прежним; пустая строка = «по умолчанию модели» (так её читает сам Claude Code).
 */
export function outputTokensEnv(n: number | null): Record<string, string> {
  return { [OUTPUT_TOKENS_VAR]: n === null ? '' : String(n) };
}
