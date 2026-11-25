import { describe, expect, it } from 'vitest';
import { decodeText } from './textEncoding.js';

const cp1251 = (s: string) => Buffer.from([...s].map((ch) => {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return c;
  if (ch === 'Ё') return 0xa8;
  if (ch === 'ё') return 0xb8;
  return c - 0x410 + 0xc0; // А–я подряд
}));

describe('кодировка файла', () => {
  it('UTF-8 — как есть; с BOM — без BOM и с пометкой', () => {
    expect(decodeText(Buffer.from('Привет, мир'), false)).toEqual({ binary: false, content: 'Привет, мир', encoding: 'utf-8' });
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ёж')]), false)).toEqual({ binary: false, content: 'ёж', encoding: 'utf-8-bom' });
  });

  it('Windows-1251 (кириллица с Windows, 1С) — читается, а не кракозябрами', () => {
    const r = decodeText(cp1251('Процедура ПриОткрытии(Отказ)\r\n\t// Ёлка и ёж\r\nКонецПроцедуры'), false);
    expect(r).toEqual({ binary: false, content: 'Процедура ПриОткрытии(Отказ)\r\n\t// Ёлка и ёж\r\nКонецПроцедуры', encoding: 'windows-1251' });
  });

  it('западная однобайтная (é, ü) — Windows-1252, не кириллица', () => {
    const r = decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]), false);
    expect(r).toMatchObject({ content: 'Café Müller', encoding: 'windows-1252' });
  });

  it('UTF-16 с BOM — текст (раньше нули в нём давали «бинарный»); без BOM с нулями — бинарный', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Да', 'utf16le')]), false)).toEqual({ binary: false, content: 'Да', encoding: 'utf-16le' });
    expect(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), false)).toEqual({ binary: true });
  });

  it('обрезанный на лимите UTF-8 посреди символа — всё ещё UTF-8 (не путаем с cp1251)', () => {
    const full = Buffer.from('Длинный текст по-русски');
    const cut = full.subarray(0, 5); // «Дл» + первый байт «и»
    const r = decodeText(cut, true);
    expect(r).toMatchObject({ encoding: 'utf-8', content: 'Дл' });
  });
});

describe('чтение файла в «Файлах»: кодировка с диска', () => {
  it('файл в cp1251 читается кириллицей и с пометкой кодировки', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readFileIn } = await import('./fs.js');
    const dir = mkdtempSync(join(tmpdir(), 'pm-enc-'));
    try {
      writeFileSync(join(dir, 'модуль.bsl'), cp1251('Процедура Тест()\r\nКонецПроцедуры\r\n'));
      writeFileSync(join(dir, 'utf.txt'), 'обычный UTF-8');
      const a = await readFileIn(dir, 'модуль.bsl');
      expect(a).toMatchObject({ binary: false, encoding: 'windows-1251', content: 'Процедура Тест()\r\nКонецПроцедуры\r\n' });
      expect(await readFileIn(dir, 'utf.txt')).toMatchObject({ encoding: 'utf-8', content: 'обычный UTF-8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
