import { describe, expect, it } from 'vitest';
import { inlineTokens, parseMarkdown, safeHref } from './markdown';

describe('parseMarkdown', () => {
  it('абзацы разделяются пустой строкой (раньше пустые строки схлопывались)', () => {
    expect(parseMarkdown('раз\nдва\n\nтри')).toEqual([{ t: 'p', text: 'раз\nдва' }, { t: 'p', text: 'три' }]);
  });
  it('нумерованный список — ol со стартом, а не маркированный', () => {
    expect(parseMarkdown('3. a\n4. b')).toEqual([{ t: 'ol', start: 3, items: ['a', 'b'] }]);
  });
  it('блок кода с языком; незакрытый (идёт печать) помечен open', () => {
    expect(parseMarkdown('```ts\nconst a = 1;\n```')).toEqual([{ t: 'code', lang: 'ts', text: 'const a = 1;', open: false }]);
    expect(parseMarkdown('```bash\nnpm i')).toEqual([{ t: 'code', lang: 'bash', text: 'npm i', open: true }]);
  });
  it('таблица GFM', () => {
    expect(parseMarkdown('| A | B |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |')).toEqual([{ t: 'table', head: ['A', 'B'], rows: [['1', '2'], ['3', '4']] }]);
  });
  it('заголовок, цитата, разделитель', () => {
    expect(parseMarkdown('## Итог\n> важно\n\n---')).toEqual([
      { t: 'h', level: 2, text: 'Итог' }, { t: 'quote', text: 'важно' }, { t: 'hr' },
    ]);
  });
  it('продолжение пункта списка с отступом приклеивается', () => {
    expect(parseMarkdown('- раз\n  продолжение\n- два')).toEqual([{ t: 'ul', items: ['раз\nпродолжение', 'два'] }]);
  });
});

describe('inlineTokens', () => {
  it('код, жирный, курсив, ссылка', () => {
    expect(inlineTokens('a `x` **b** *c* [d](https://e.f)')).toEqual([
      { t: 'text', v: 'a ' }, { t: 'code', v: 'x' }, { t: 'text', v: ' ' }, { t: 'b', v: 'b' },
      { t: 'text', v: ' ' }, { t: 'i', v: 'c' }, { t: 'text', v: ' ' }, { t: 'a', v: 'd', href: 'https://e.f' },
    ]);
  });
  it('звёздочка внутри слова/выражения — не курсив', () => {
    expect(inlineTokens('2*3*4')).toEqual([{ t: 'text', v: '2*3*4' }]);
  });
});

describe('safeHref', () => {
  it('пропускает только http/https/mailto', () => {
    expect(safeHref('https://x')).toBe('https://x');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
  });
});
