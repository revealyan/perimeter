// Журнал текста размышлений: Claude Code пишет thinking в транскрипт без текста — supervisor хранит его сам.
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ThinkingStore } from './thinkingStore.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = mkdtempSync(join(tmpdir(), 'pm-think-')); dirs.push(d); return join(d, 'sub', 'thinking.log'); };

describe('ThinkingStore', () => {
  it('текст по подписи — и после перезапуска (новый экземпляр читает файл)', () => {
    const f = file();
    const a = new ThinkingStore(f);
    a.put('sig-1', 'думаю о «главном»\nвторая строка 🙂');
    a.put('sig-2', 'второй блок');
    expect(a.get('sig-1')).toBe('думаю о «главном»\nвторая строка 🙂');
    const b = new ThinkingStore(f);
    expect(b.get('sig-1')).toBe('думаю о «главном»\nвторая строка 🙂');
    expect(b.get('sig-2')).toBe('второй блок');
    expect(b.get('нет такой')).toBeUndefined();
  });

  it('повтор подписи не дописывает файл; пустые значения не пишутся', () => {
    const f = file();
    const s = new ThinkingStore(f);
    s.put('sig', 'раз');
    s.put('sig', 'два');
    s.put('', 'без подписи');
    s.put('sig-3', '');
    expect(readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(s.get('sig')).toBe('раз');
  });

  it('оборванная последняя строка (запись прервалась) — пропускается, дальнейшие записи читаются', () => {
    const f = file();
    new ThinkingStore(f).put('sig-ok', 'целая');
    appendFileSync(f, '0123456789abcdef0123456789abcdef "оборв');
    const s = new ThinkingStore(f);
    expect(s.get('sig-ok')).toBe('целая');
    s.put('sig-new', 'после обрыва');
    expect(new ThinkingStore(f).get('sig-new')).toBe('после обрыва');
    expect(new ThinkingStore(f).get('sig-ok')).toBe('целая');
  });
});
