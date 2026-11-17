import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../supervisor';
import { sessionLineMarks } from './lineMarks';
import { escapeHtml, plainLines, splitHighlighted } from './hlLines';

let n = 0;
const edit = (name: string, input: Record<string, unknown>, result?: unknown, extra?: Partial<Record<string, unknown>>): FeedItem => ({
  id: `e${++n}`, kind: 'tool-use', data: { id: `t${n}`, name, input, result: result ?? { ok: true }, isError: false, done: true, ...extra },
});
const FILE = '/opt/p/a.ts';
const isA = (p: string) => p === FILE;

describe('отметки строк сессии', () => {
  const content = ['import x', 'const a = 1;', 'const b = 2;', 'const c = 3;', 'export {}', ''].join('\n');

  it('замена строки — «изменена», вставка — «добавлена»', () => {
    const items = [
      edit('Edit', { file_path: FILE, old_string: 'const a = 0;', new_string: 'const a = 1;' }),
      edit('Edit', { file_path: FILE, old_string: 'const b = 2;\nexport', new_string: 'const b = 2;\nconst c = 3;\nexport' }),
    ];
    const m = sessionLineMarks(items, isA, content);
    expect([...m.lines]).toEqual([[2, 'mod'], [4, 'add']]);
    expect(m.delAfter.size).toBe(0);
  });

  it('одна строка заменена двумя — первая «изменена», вторая «добавлена»', () => {
    const items = [edit('Edit', { file_path: FILE, old_string: 'const b = 0;', new_string: 'const b = 2;\nconst c = 3;' })];
    expect([...sessionLineMarks(items, isA, content).lines]).toEqual([[3, 'mod'], [4, 'add']]);
  });

  it('удалённые строки — маркер после предыдущей строки', () => {
    const items = [edit('Edit', { file_path: FILE, old_string: 'const a = 1;\nconst gone = 9;\nconst b = 2;', new_string: 'const a = 1;\nconst b = 2;' })];
    const m = sessionLineMarks(items, isA, content);
    expect(m.lines.size).toBe(0);
    expect([...m.delAfter]).toEqual([2]);
  });

  it('чужой файл, ошибка, идущая правка и переписанный позже текст — без отметок', () => {
    const items = [
      edit('Edit', { file_path: '/opt/p/b.ts', old_string: 'x', new_string: 'const a = 1;' }),
      edit('Edit', { file_path: FILE, old_string: 'q', new_string: 'const a = 1;' }, 'boom', { isError: true }),
      edit('Edit', { file_path: FILE, old_string: 'q', new_string: 'const a = 1;' }, undefined, { result: undefined, done: false }),
      edit('Edit', { file_path: FILE, old_string: 'q', new_string: 'const zzz = 1;' }),
    ];
    expect(sessionLineMarks(items, isA, content).lines.size).toBe(0);
  });

  it('файл создан в сессии — весь новый; несколько вхождений — ближайшее к строке патча', () => {
    const created = sessionLineMarks([edit('Write', { file_path: FILE, content }, { type: 'create' })], isA, content);
    expect(created.lines.size).toBe(5);
    const twice = 'return null;\nfoo();\nreturn null;\n';
    const items = [edit('Edit', { file_path: FILE, old_string: 'return 0;', new_string: 'return null;' }, { structuredPatch: [{ oldStart: 3, newStart: 3, lines: ['-return 0;', '+return null;'] }] })];
    expect([...sessionLineMarks(items, isA, twice).lines]).toEqual([[3, 'mod']]);
  });
});

describe('подсветка построчно', () => {
  it('многострочный span закрывается и открывается заново', () => {
    const html = 'a <span class="s">"x\ny"</span> b\nc';
    expect(splitHighlighted(html)).toEqual(['a <span class="s">"x</span>', '<span class="s">y"</span> b', 'c']);
  });
  it('вложенные теги и экранирование', () => {
    expect(splitHighlighted('<span class="a"><span class="b">1\n2</span>3</span>')).toEqual([
      '<span class="a"><span class="b">1</span></span>', '<span class="a"><span class="b">2</span>3</span>',
    ]);
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
    expect(plainLines('<x>\ny')).toEqual(['&lt;x&gt;', 'y']);
  });
});
