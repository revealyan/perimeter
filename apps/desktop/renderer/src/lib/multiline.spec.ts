import { describe, expect, it } from 'vitest';
import { clip, lineSummary, moreLines, splitLines } from './multiline';
import { clock, countOf, plural } from './ru';

describe('многострочные вводы', () => {
  it('heredoc: хвостовой перевод строки и \\r\\n не считаются строками', () => {
    expect(splitLines("cat > a.txt <<'EOF'\r\nпривет\r\nEOF\r\n")).toEqual(["cat > a.txt <<'EOF'", 'привет', 'EOF']);
  });
  it('первая строка + сколько скрыто; номера — с четырёх строк', () => {
    const s = lineSummary('npm run build \\\n  -w @perimeter/desktop');
    expect(s.first).toBe('npm run build \\');
    expect(s.extra).toBe(1);
    expect(s.numbered).toBe(false);
    expect(lineSummary('a\nb\nc').numbered).toBe(false);
    expect(lineSummary('a\nb\nc\nd').numbered).toBe(true);
  });
  it('однострочная команда — без «+N строк»', () => {
    expect(lineSummary('npm test')).toEqual({ first: 'npm test', extra: 0, lines: ['npm test'], numbered: false });
    expect(lineSummary('').extra).toBe(0);
  });
  it('пустые строки в начале не становятся «первой строкой»', () => {
    expect(lineSummary('\n\n  ls -la\npwd').first).toBe('  ls -la');
  });
  it('метка «+N строк» склоняется', () => {
    expect(moreLines(1)).toBe('+1 строка');
    expect(moreLines(3)).toBe('+3 строки');
    expect(moreLines(5)).toBe('+5 строк');
    expect(moreLines(21)).toBe('+21 строка');
  });
  it('укорачивание с многоточием', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
  });
});

describe('русские числа и время', () => {
  it('формы слова', () => {
    const f = ['файл', 'файла', 'файлов'] as const;
    expect([0, 1, 2, 5, 11, 12, 21, 22, 25, 111].map((n) => plural(n, f))).toEqual(['файлов', 'файл', 'файла', 'файлов', 'файлов', 'файлов', 'файл', 'файла', 'файлов', 'файлов']);
    expect(countOf(8, f)).toBe('8 файлов');
  });
  it('таймер идущей команды', () => {
    expect(clock(72_000)).toBe('1:12');
    expect(clock(5_400)).toBe('0:05');
    expect(clock(3_725_000)).toBe('1:02:05');
  });
});
