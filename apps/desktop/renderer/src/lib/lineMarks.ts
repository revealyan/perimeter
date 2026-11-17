// Отметки строк в гуттере просмотра файла: что агент поменял в этом файле за сессию.
// Номера строк в правках относятся к состоянию файла на момент правки, а потом файл ещё менялся —
// поэтому новый текст каждой правки ищем в ТЕКУЩЕМ содержимом (подсказка — номер строки из патча).
// Не нашли (текст уже переписан) — правку пропускаем: лучше без отметки, чем с неверной.
import type { FeedItem } from '../supervisor';
import { isRunning } from './feedModel';
import { hunksFromStructured, lineDiff, type DiffLine } from './toolFormat';

export type LineMark = 'add' | 'mod';
export interface LineMarks {
  /** номер строки (с 1) → добавлена / изменена */
  lines: Map<number, LineMark>;
  /** «здесь удалены строки» — после строки N (0 — перед первой) */
  delAfter: Set<number>;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Номер строки (с 1) символа с индексом idx. */
function lineAt(starts: number[], idx: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Все вхождения needle; ближайшее к подсказке (номер строки) — первым. */
function findNear(content: string, needle: string, starts: number[], hint: number | undefined): number {
  const hits: number[] = [];
  let at = content.indexOf(needle);
  while (at >= 0 && hits.length < 200) {
    hits.push(at);
    at = content.indexOf(needle, at + 1);
  }
  if (hits.length === 0) return -1;
  if (hint === undefined || hits.length === 1) return hits[0]!;
  return hits.reduce((best, h) => (Math.abs(lineAt(starts, h) - hint) < Math.abs(lineAt(starts, best) - hint) ? h : best), hits[0]!);
}

/**
 * Строки дифа → отметки: блоки подряд идущих −/+ (+ на месте − — строки изменены, лишние + — добавлены;
 * только − — удалены, маркер после предыдущей строки).
 * Номер строки в файле = offset + newNo; before — строка файла перед первой строкой дифа.
 */
function markBlocks(marks: LineMarks, diff: DiffLine[], offset: number, before: number): void {
  let k = 0;
  let lastNew = before;
  while (k < diff.length) {
    const l = diff[k]!;
    if (l.sign === ' ') {
      lastNew = offset + l.newNo!;
      k++;
      continue;
    }
    const plus: number[] = [];
    let minus = 0;
    while (k < diff.length && diff[k]!.sign !== ' ') {
      const d = diff[k]!;
      if (d.sign === '+') plus.push(offset + d.newNo!);
      else minus++;
      k++;
    }
    if (plus.length === 0) marks.delAfter.add(lastNew);
    // первые min(−, +) строк блока заменили старые — «изменены», остальные — «добавлены»
    plus.forEach((n, i) => { if (marks.lines.get(n) !== 'mod') marks.lines.set(n, i < minus ? 'mod' : 'add'); });
    if (plus.length > 0) lastNew = plus[plus.length - 1]!;
  }
}

/** Пара old → new: новый текст ищем в текущем содержимом и отмечаем по построчному дифу пары. */
function markPair(marks: LineMarks, content: string, starts: number[], oldS: string, newS: string, hint: number | undefined): void {
  if (newS.trim().length < 3) return; // слишком короткое — найдётся где угодно
  const at = findNear(content, newS, starts, hint);
  if (at < 0) return;
  const first = lineAt(starts, at);
  markBlocks(marks, lineDiff(oldS, newS), first - 1, first - 1);
}

/**
 * Отметки для файла по ленте сессии. isTarget — «это тот файл?» (пути в ленте абсолютные).
 * Write с созданием файла — весь файл новый; Write поверх — по патчу, если это последняя правка файла.
 */
export function sessionLineMarks(items: FeedItem[], isTarget: (absPath: string) => boolean, content: string): LineMarks {
  const marks: LineMarks = { lines: new Map(), delAfter: new Set() };
  const edits = items.filter((it) => {
    if (it.kind !== 'tool-use' || it.data['isError'] === true || isRunning(it)) return false;
    const name = str(it.data['name']);
    if (name !== 'Edit' && name !== 'MultiEdit' && name !== 'Write') return false;
    return isTarget(str(asObj(it.data['input'])?.['file_path']));
  });
  if (edits.length === 0 || content === '') return marks;
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) starts.push(i + 1);
  const total = content.endsWith('\n') ? starts.length - 1 : starts.length;

  edits.forEach((it, k) => {
    const name = str(it.data['name']);
    const input = asObj(it.data['input']) ?? {};
    const result = asObj(it.data['result']);
    const hunks = hunksFromStructured(result?.['structuredPatch']);
    const hint = hunks?.[0]?.newStart;
    if (name === 'Write') {
      if (result?.['type'] === 'create') {
        marks.lines.clear();
        marks.delAfter.clear();
        for (let n = 1; n <= total; n++) marks.lines.set(n, 'add');
      } else if (k === edits.length - 1 && hunks) {
        // последняя правка — номера из её патча совпадают с текущим файлом
        for (const h of hunks) markBlocks(marks, h.lines, 0, h.newStart - 1);
      }
      return;
    }
    if (name === 'Edit') markPair(marks, content, starts, str(input['old_string']), str(input['new_string']), hint);
    else if (Array.isArray(input['edits'])) {
      for (const e of input['edits'] as unknown[]) {
        const o = asObj(e);
        if (o) markPair(marks, content, starts, str(o['old_string']), str(o['new_string']), undefined);
      }
    }
  });
  return marks;
}
