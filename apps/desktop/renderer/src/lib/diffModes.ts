// Режимы дифа: «мутации» (подсветка изменённых слов внутри строки) и «рядом» (было | стало).
// Чистые функции над хунками из toolFormat — без React.

import type { DiffLine, Hunk } from './toolFormat';

export interface Seg { text: string; changed: boolean }
export type MutLine = DiffLine & { segs?: Seg[] };
export interface MutHunk { oldStart: number; newStart: number; lines: MutLine[] }

/** Токены для сравнения: слова (с юникодом), пробелы, отдельные знаки. */
export function tokenize(s: string): string[] {
  return s.match(/[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu) ?? [];
}

function merge(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.changed === s.changed) last.text += s.text;
    else if (s.text !== '') out.push({ ...s });
  }
  return out;
}

/**
 * Пословный диф пары строк (LCS по токенам). Возвращает сегменты «было» и «стало» и долю общего
 * (по символам) — если строки почти не похожи, подсветка слов только шумит.
 */
export function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[]; common: number } {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length * tb.length > 160_000) {
    return { a: [{ text: a, changed: true }], b: [{ text: b, changed: true }], common: 0 };
  }
  const dp: number[][] = Array.from({ length: ta.length + 1 }, () => new Array<number>(tb.length + 1).fill(0));
  for (let i = ta.length - 1; i >= 0; i--) {
    for (let j = tb.length - 1; j >= 0; j--) {
      dp[i]![j] = ta[i] === tb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const sa: Seg[] = [];
  const sb: Seg[] = [];
  let i = 0;
  let j = 0;
  let same = 0;
  while (i < ta.length && j < tb.length) {
    if (ta[i] === tb[j]) { sa.push({ text: ta[i]!, changed: false }); sb.push({ text: tb[j]!, changed: false }); same += ta[i]!.length; i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { sa.push({ text: ta[i]!, changed: true }); i++; }
    else { sb.push({ text: tb[j]!, changed: true }); j++; }
  }
  while (i < ta.length) sa.push({ text: ta[i++]!, changed: true });
  while (j < tb.length) sb.push({ text: tb[j++]!, changed: true });
  // доля общего — от средней длины пары: длинная удалённая строка против короткой новой не должна «обнулять» сходство
  const avg = (a.length + b.length) / 2 || 1;
  return { a: merge(sa), b: merge(sb), common: same / avg };
}

/** Ниже этой доли общего строки считаем переписанными целиком — без пословной подсветки. */
const MIN_COMMON = 0.3;

/** Пары «удалено/добавлено» внутри хунка (по порядку в подряд идущих блоках) получают пословные сегменты. */
export function withMutations(hunks: Hunk[]): MutHunk[] {
  return hunks.map((h) => {
    const lines: MutLine[] = h.lines.map((l) => ({ ...l }));
    let k = 0;
    while (k < lines.length) {
      if (lines[k]!.sign !== '-') { k++; continue; }
      const delStart = k;
      while (k < lines.length && lines[k]!.sign === '-') k++;
      const addStart = k;
      while (k < lines.length && lines[k]!.sign === '+') k++;
      const nDel = addStart - delStart;
      const nAdd = k - addStart;
      for (let p = 0; p < Math.min(nDel, nAdd); p++) {
        const del = lines[delStart + p]!;
        const add = lines[addStart + p]!;
        const wd = wordDiff(del.text, add.text);
        if (wd.common >= MIN_COMMON) { del.segs = wd.a; add.segs = wd.b; }
      }
    }
    return { oldStart: h.oldStart, newStart: h.newStart, lines };
  });
}

export interface SplitRow { left?: MutLine; right?: MutLine }

/** «Рядом»: контекст — в обеих колонках; блоки удалений/добавлений выравниваются построчно. */
export function splitRows(h: MutHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let k = 0;
  const L = h.lines;
  while (k < L.length) {
    const l = L[k]!;
    if (l.sign === ' ') { rows.push({ left: l, right: l }); k++; continue; }
    const dels: MutLine[] = [];
    const adds: MutLine[] = [];
    while (k < L.length && L[k]!.sign === '-') dels.push(L[k++]!);
    while (k < L.length && L[k]!.sign === '+') adds.push(L[k++]!);
    // одиночные «+» без предшествующих «-»
    if (dels.length === 0 && adds.length === 0) { k++; continue; }
    for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
      rows.push({ ...(dels[p] ? { left: dels[p] } : {}), ...(adds[p] ? { right: adds[p] } : {}) });
    }
  }
  return rows;
}
