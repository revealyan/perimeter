import { describe, expect, it } from 'vitest';
import { splitRows, tokenize, withMutations, wordDiff } from './diffModes';
import { hunksFromStructured } from './toolFormat';

const SCENE = hunksFromStructured([{ oldStart: 6, oldLines: 3, newStart: 6, newLines: 3, lines: [
  '   if (!d) return null;',
  "-  const pctRaw = d['usedPercentage'] ?? d['used_percentage'];",
  "-  if (typeof pctRaw === 'number') return { pct: Math.round(pctRaw) };",
  "+  const pct = d['percentage'];",
  "+  if (typeof pct === 'number') return { pct: Math.round(pct) };",
] }])!;

describe('мутации: пословный диф', () => {
  it('токены: слова (и кириллица), пробелы, знаки', () => {
    expect(tokenize("d['used_percentage'] ?? x")).toEqual(['d', '[', "'", 'used_percentage', "'", ']', ' ', '?', '?', ' ', 'x']);
    expect(tokenize('привет мир')).toEqual(['привет', ' ', 'мир']);
  });
  it('подсвечено ровно изменённое: pctRaw → pct', () => {
    const wd = wordDiff("if (typeof pctRaw === 'number')", "if (typeof pct === 'number')");
    expect(wd.a.filter((s) => s.changed).map((s) => s.text)).toEqual(['pctRaw']);
    expect(wd.b.filter((s) => s.changed).map((s) => s.text)).toEqual(['pct']);
    expect(wd.common).toBeGreaterThan(0.7);
  });
  it('сцена: удалённое «?? d[used_percentage]» и замена usedPercentage → percentage', () => {
    const [h] = withMutations(SCENE);
    const del1 = h!.lines[1]!;
    const add1 = h!.lines[3]!;
    expect(del1.segs!.filter((s) => s.changed).map((s) => s.text.trim()).join('|')).toContain('used_percentage');
    expect(add1.segs!.filter((s) => s.changed).map((s) => s.text)).toContain('percentage');
    // строка контекста без сегментов
    expect(h!.lines[0]!.segs).toBeUndefined();
  });
  it('совсем разные строки — без пословной подсветки (иначе пёстрый шум)', () => {
    const [h] = withMutations(hunksFromStructured([{ oldStart: 1, newStart: 1, lines: ['-import a from "x";', '+export default function Foo() {}'] }])!);
    expect(h!.lines[0]!.segs).toBeUndefined();
    expect(h!.lines[1]!.segs).toBeUndefined();
  });
});

describe('рядом: было | стало', () => {
  it('контекст в обеих колонках, пары -/+ на одной строке', () => {
    const rows = splitRows(withMutations(SCENE)[0]!);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.left!.sign).toBe(' ');
    expect(rows[0]!.right).toBe(rows[0]!.left);
    expect([rows[1]!.left!.oldNo, rows[1]!.right!.newNo]).toEqual([7, 7]);
    expect([rows[2]!.left!.oldNo, rows[2]!.right!.newNo]).toEqual([8, 8]);
  });
  it('новый файл: слева пусто, справа добавления', () => {
    const rows = splitRows(withMutations(hunksFromStructured([{ oldStart: 0, newStart: 1, lines: ['+a', '+b'] }])!)[0]!);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([[null, 'a'], [null, 'b']]);
  });
});
