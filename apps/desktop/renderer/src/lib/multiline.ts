// Многострочные команды и вводы инструментов (heredoc, переносы «\», многострочные шаблоны):
// в ленте и карточках — первая строка + «+N строк», в запросе разрешения — целиком.
import { plural } from './ru';

/** С какого числа строк в полном виде показываем номера строк. */
export const NUMBER_FROM = 4;
/** Сколько строк видно в запросе разрешения без прокрутки. */
export const PROMPT_MAX_LINES = 12;

/** Строки текста: \r\n → \n; пустые строки по краям отброшены (у heredoc часто висит хвостовой \n). */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === '') lines.pop();
  while (lines.length > 1 && lines[0]!.trim() === '') lines.shift();
  return lines;
}

export interface LineSummary {
  /** первая строка — для однострочного показа */
  first: string;
  /** сколько строк скрыто за первой */
  extra: number;
  lines: string[];
  /** в полном виде нумеровать строки (их больше трёх) */
  numbered: boolean;
}

export function lineSummary(text: string): LineSummary {
  const lines = splitLines(text);
  return { first: lines[0] ?? '', extra: Math.max(0, lines.length - 1), lines, numbered: lines.length >= NUMBER_FROM };
}

/** Метка «+N строк». */
export function moreLines(n: number): string {
  return `+${n} ${plural(n, ['строка', 'строки', 'строк'])}`;
}

/** Укоротить одну строку до max символов с многоточием (для подсказок и уведомлений). */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}
