// Панель файлов на временной папке: сортировка, скрытые, лимит, бинарные, обрезка UTF-8, ошибки.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelError } from './errors.js';
import { listDir, readFileIn } from './fs.js';

const codeOfAsync = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; } catch (err) { return err instanceof PanelError ? err.code : `не PanelError: ${String(err)}`; }
  return undefined;
};

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-fs-'));
  tmps.push(d);
  return d;
}

function fixture(): string {
  const root = tmp();
  mkdirSync(join(root, 'b-dir'));
  mkdirSync(join(root, 'A-dir'));
  writeFileSync(join(root, 'z.txt'), 'zzz');
  writeFileSync(join(root, '.hidden'), 'h');
  writeFileSync(join(root, 'file10.txt'), '10');
  writeFileSync(join(root, 'file2.txt'), '2');
  return root;
}

describe('fs.list', () => {
  it('папки сначала, имена без регистра и с числами по значению, скрытые видны, без рекурсии', async () => {
    const root = fixture();
    writeFileSync(join(root, 'b-dir', 'inner.txt'), 'не должно попасть в список корня');
    const r = await listDir(root, '');
    expect(r.root).toBe(root);
    expect(r.path).toBe('');
    expect(r.truncated).toBe(false);
    expect(r.entries.map((e) => e.name)).toEqual(['A-dir', 'b-dir', '.hidden', 'file2.txt', 'file10.txt', 'z.txt']);
    expect(r.entries.slice(0, 2).every((e) => e.kind === 'dir')).toBe(true);
    const z = r.entries.find((e) => e.name === 'z.txt')!;
    expect(z).toMatchObject({ kind: 'file', size: 3 });
    expect(z.mtimeMs).toBeGreaterThan(0);
  });

  it('большая папка: лимит записей + truncated + total', async () => {
    const root = fixture();
    const r = await listDir(root, '', 3);
    expect(r.entries).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(6);
    expect(r.entries.map((e) => e.name)).toEqual(['A-dir', 'b-dir', '.hidden']);
  });

  it('подпапка, путь с обратным слэшем на Windows; ссылка — kind link', async () => {
    const root = fixture();
    mkdirSync(join(root, 'b-dir', 'deep'));
    writeFileSync(join(root, 'b-dir', 'deep', 'x.md'), '# x');
    const r = await listDir(root, process.platform === 'win32' ? 'b-dir\\deep' : 'b-dir/deep');
    expect(r.path).toBe('b-dir/deep');
    expect(r.entries.map((e) => e.name)).toEqual(['x.md']);

    symlinkSync(join(root, 'A-dir'), join(root, 'link-to-a'), process.platform === 'win32' ? 'junction' : 'dir');
    const top = await listDir(root, '');
    expect(top.entries.find((e) => e.name === 'link-to-a')?.kind).toBe('link');
  });

  it('ошибки: файл вместо папки — NOT_A_DIR, нет пути — NOT_FOUND, выход за корень — OUTSIDE_ROOT', async () => {
    const root = fixture();
    expect(await codeOfAsync(listDir(root, 'z.txt'))).toBe('NOT_A_DIR');
    expect(await codeOfAsync(listDir(root, 'нет'))).toBe('NOT_FOUND');
    expect(await codeOfAsync(listDir(root, '..'))).toBe('OUTSIDE_ROOT');
    expect(await codeOfAsync(listDir(root, root))).toBe('OUTSIDE_ROOT');
  });
});

describe('fs.read', () => {
  it('текстовый файл целиком', async () => {
    const root = tmp();
    writeFileSync(join(root, 'a.md'), 'Привет, мир\n');
    const r = await readFileIn(root, 'a.md');
    expect(r).toMatchObject({ path: 'a.md', truncated: false, binary: false, content: 'Привет, мир\n' });
    expect(r.size).toBe(Buffer.byteLength('Привет, мир\n'));
  });

  it('бинарный (нулевой байт в первых 8 КБ) → binary: true, content пустой', async () => {
    const root = tmp();
    writeFileSync(join(root, 'img.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const r = await readFileIn(root, 'img.bin');
    expect(r.binary).toBe(true);
    expect(r.content).toBe('');
    expect(r.size).toBe(7);
  });

  it('нулевой байт дальше 8 КБ — не бинарный', async () => {
    const root = tmp();
    writeFileSync(join(root, 'log.txt'), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
    const r = await readFileIn(root, 'log.txt');
    expect(r.binary).toBe(false);
    expect(r.content.length).toBe(9001);
  });

  it('обрезка по maxBytes: truncated, полный размер, UTF-8 не рвётся посреди символа', async () => {
    const root = tmp();
    writeFileSync(join(root, 'ru.txt'), 'я'.repeat(10)); // по 2 байта на символ
    const r = await readFileIn(root, 'ru.txt', 5);
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(20);
    expect(r.content).toBe('яя'); // 5-й байт — половинка «я», в content не попадает
  });

  it('файл ровно в maxBytes — не truncated', async () => {
    const root = tmp();
    writeFileSync(join(root, 'f.txt'), 'abcde');
    const r = await readFileIn(root, 'f.txt', 5);
    expect(r).toMatchObject({ truncated: false, content: 'abcde', size: 5 });
  });

  it('по умолчанию лимит 512 КБ', async () => {
    const root = tmp();
    writeFileSync(join(root, 'big.txt'), Buffer.alloc(600 * 1024, 0x62));
    const r = await readFileIn(root, 'big.txt');
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(512 * 1024);
    expect(r.size).toBe(600 * 1024);
  });

  it('ошибки: папка — NOT_A_FILE, нет файла — NOT_FOUND, `..` — OUTSIDE_ROOT, папка-ссылка наружу — OUTSIDE_ROOT', async () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'секрет');
    mkdirSync(join(root, 'dir'));
    symlinkSync(outside, join(root, 'out'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await codeOfAsync(readFileIn(root, 'dir'))).toBe('NOT_A_FILE');
    expect(await codeOfAsync(readFileIn(root, 'nope.txt'))).toBe('NOT_FOUND');
    expect(await codeOfAsync(readFileIn(root, '../secret.txt'))).toBe('OUTSIDE_ROOT');
    expect(await codeOfAsync(readFileIn(root, 'out/secret.txt'))).toBe('OUTSIDE_ROOT');
  });
});
