import { describe, expect, it } from 'vitest';
import { ctxView, editPatch, editStats, fmtDuration, lineDiff, resultView, shortPath, toolHead } from './toolFormat';

describe('toolHead', () => {
  it('Bash: команда + описание, без дублей иконки в тексте', () => {
    const h = toolHead('Bash', { command: 'npm test', description: 'Прогнать тесты' });
    expect(h).toEqual({ kind: 'shell', verb: 'Команда', target: 'npm test', note: 'Прогнать тесты' });
  });
  it('mcp-инструмент: сервер · имя', () => {
    expect(toolHead('mcp__serena__find_symbol', {})).toMatchObject({ kind: 'mcp', verb: 'serena', target: 'find symbol' });
  });
  it('AskUserQuestion: заголовки всех вопросов', () => {
    expect(toolHead('AskUserQuestion', { questions: [{ header: 'Диф', question: 'где?' }, { header: 'Тосты', question: 'какие?' }] }).target).toBe('Диф · Тосты');
  });
});

describe('resultView', () => {
  it('Bash → консоль stdout/stderr, а не JSON', () => {
    const v = resultView('Bash', {}, { stdout: 'ok\n', stderr: 'warn', interrupted: false });
    expect(v).toEqual({ type: 'console', stdout: 'ok\n', stderr: 'warn', interrupted: false });
  });
  it('Read текста → код с языком по расширению', () => {
    const v = resultView('Read', {}, { type: 'text', file: { filePath: '/a/b.tsx', content: 'const x = 1;', numLines: 1, startLine: 1, totalLines: 1 } });
    expect(v).toEqual({ type: 'text', text: 'const x = 1;', lang: 'typescript' });
  });
  it('Read картинки → data-URL (раньше уезжал сырой base64 в текст)', () => {
    const v = resultView('Read', {}, { type: 'image', file: { base64: 'AAAA', type: 'image/jpeg', originalSize: 3 } });
    expect(v).toEqual({ type: 'image', src: 'data:image/jpeg;base64,AAAA' });
  });
  it('content-блоки транскрипта: картинка + подпись', () => {
    const v = resultView('Read', {}, [{ type: 'text', text: 'скрин' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }]);
    expect(v).toEqual({ type: 'image', src: 'data:image/png;base64,BBBB', caption: 'скрин' });
  });
  it('Glob → список файлов', () => {
    const v = resultView('Glob', {}, { filenames: ['a.ts', 'b.ts'], numFiles: 2, truncated: false, durationMs: 1 });
    expect(v).toEqual({ type: 'files', files: ['a.ts', 'b.ts'], total: 2, truncated: false });
  });
  it('AskUserQuestion → пары вопрос/ответ', () => {
    const v = resultView('AskUserQuestion', {}, { questions: [], answers: { 'Где диф?': 'В карточке' } });
    expect(v).toEqual({ type: 'answers', pairs: [{ q: 'Где диф?', a: 'В карточке' }] });
  });
  it('неизвестный объект → JSON', () => {
    expect(resultView('Foo', {}, { a: 1 })).toMatchObject({ type: 'text', lang: 'json' });
  });
  it('нет результата → none', () => {
    expect(resultView('Bash', {}, undefined)).toEqual({ type: 'none' });
  });
});

describe('диф', () => {
  it('structuredPatch → хунки с номерами строк', () => {
    const p = editPatch('Edit', { file_path: '/x.ts' }, {
      structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' a', '-b', '+B', ' c'] }],
    })!;
    expect(p.added).toBe(1);
    expect(p.removed).toBe(1);
    expect(p.hunks[0]!.lines).toEqual([
      { sign: ' ', text: 'a', oldNo: 10, newNo: 10 },
      { sign: '-', text: 'b', oldNo: 11 },
      { sign: '+', text: 'B', newNo: 11 },
      { sign: ' ', text: 'c', oldNo: 12, newNo: 12 },
    ]);
  });
  it('без результата — диф из входа (LCS): общие строки не считаются правкой', () => {
    const p = editPatch('Edit', { file_path: '/x.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' }, undefined)!;
    expect({ added: p.added, removed: p.removed }).toEqual({ added: 1, removed: 1 });
  });
  it('Write нового файла — все строки добавлены', () => {
    expect(editStats('Write', { file_path: '/n.md', content: '1\n2\n3' }, { type: 'create' })).toEqual({ added: 3, removed: 0, path: '/n.md' });
  });
  it('Bash/Read — не правки (раньше считались в «N правок»)', () => {
    expect(editStats('Bash', { command: 'ls' }, undefined)).toBeNull();
    expect(editStats('Read', { file_path: '/a' }, undefined)).toBeNull();
  });
  it('lineDiff пустого в пустое', () => {
    expect(lineDiff('', '')).toEqual([]);
  });
});

describe('ctxView', () => {
  it('поля SDK getContextUsage: percentage/totalTokens/maxTokens', () => {
    const v = ctxView({ percentage: 12.6, totalTokens: 25_200, maxTokens: 200_000, categories: [
      { name: 'Messages', tokens: 5000, kind: 'used' }, { name: 'Free', tokens: 0, kind: 'free' },
    ] });
    expect(v).toEqual({ pct: 13, used: 25_200, max: 200_000, parts: [{ name: 'Messages', tokens: 5000, kind: 'used' }] });
  });
  it('без процента — считаем из токенов', () => {
    expect(ctxView({ totalTokens: 50, maxTokens: 200 })?.pct).toBe(25);
  });
  it('мусор → null', () => {
    expect(ctxView({ foo: 1 })).toBeNull();
    expect(ctxView(undefined)).toBeNull();
  });
});

describe('форматирование', () => {
  it('fmtDuration', () => {
    expect(fmtDuration(731)).toBe('731 мс');
    expect(fmtDuration(12_576)).toBe('13 с');
    expect(fmtDuration(9_203)).toBe('9.2 с');
    expect(fmtDuration(125_000)).toBe('2 мин 5 с');
  });
  it('shortPath', () => {
    expect(shortPath('/opt/perimeter/apps/desktop/renderer/src/App.tsx')).toBe('…/renderer/src/App.tsx');
    expect(shortPath('a/b')).toBe('a/b');
  });

describe('toolHead: делегирование сабагенту', () => {
  it('цель — аккаунт, пояснение — имя задачи (или начало промпта)', () => {
    const h = toolHead('mcp__perimeter__delegate_to_agent', { account: 'zai', prompt: 'сделай обзор', name: 'разведка' });
    expect(h).toMatchObject({ kind: 'agent', verb: 'Воркер', target: 'zai', note: 'разведка' });
    const h2 = toolHead('mcp__perimeter__delegate_to_agent', { account: 'claude', prompt: 'очень длинный промпт задачи воркера, который надо обрезать' });
    expect(h2.kind).toBe('agent');
    expect(h2.note).not.toContain('undefined');
  });
});
});
