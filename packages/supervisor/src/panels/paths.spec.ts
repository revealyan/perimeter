// Конфайнмент путей панелей: синтаксический слой (обе ОС) и realpath-слой на временной папке.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelError } from './errors.js';
import { isInside, resolveInRoot, splitRelPath } from './paths.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (err) { return err instanceof PanelError ? err.code : `не PanelError: ${String(err)}`; }
  return undefined;
};
const codeOfAsync = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; } catch (err) { return err instanceof PanelError ? err.code : `не PanelError: ${String(err)}`; }
  return undefined;
};

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-paths-'));
  tmps.push(d);
  return d;
}

/** Ссылка на папку: на Windows — junction (не требует прав администратора). */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('splitRelPath: синтаксический конфайнмент', () => {
  it('нормальные пути: пустой — корень, точки и двойные слэши схлопываются', () => {
    expect(splitRelPath('', 'linux')).toEqual([]);
    expect(splitRelPath('.', 'linux')).toEqual([]);
    expect(splitRelPath('src//a/./b.ts', 'linux')).toEqual(['src', 'a', 'b.ts']);
    expect(splitRelPath('src\\a/b.ts', 'win32')).toEqual(['src', 'a', 'b.ts']);
    // на Linux обратный слэш — обычный символ имени
    expect(splitRelPath('a\\b', 'linux')).toEqual(['a\\b']);
    expect(splitRelPath('..foo/.bar', 'linux')).toEqual(['..foo', '.bar']);
  });

  it('`..` в любом месте — OUTSIDE_ROOT (даже если «остаётся внутри»)', () => {
    for (const p of ['..', '../x', 'a/../b', 'a/..', 'a/b/../../..']) {
      expect(codeOf(() => splitRelPath(p, 'linux'))).toBe('OUTSIDE_ROOT');
    }
    expect(codeOf(() => splitRelPath('a\\..\\..\\x', 'win32'))).toBe('OUTSIDE_ROOT');
  });

  it('абсолютные пути — OUTSIDE_ROOT (обе ОС)', () => {
    expect(codeOf(() => splitRelPath('/etc/passwd', 'linux'))).toBe('OUTSIDE_ROOT');
    for (const p of ['C:\\Windows', 'c:/x', 'C:x', '\\x', '\\\\srv\\share\\x', '/x']) {
      expect(codeOf(() => splitRelPath(p, 'win32'))).toBe('OUTSIDE_ROOT');
    }
  });

  it('Windows: двоеточие (NTFS-потоки, диск-относительные) и сегменты из точек/пробелов — OUTSIDE_ROOT', () => {
    expect(codeOf(() => splitRelPath('file.txt:stream', 'win32'))).toBe('OUTSIDE_ROOT');
    expect(codeOf(() => splitRelPath('a/.. /b', 'win32'))).toBe('OUTSIDE_ROOT');
    expect(codeOf(() => splitRelPath('a/.../b', 'win32'))).toBe('OUTSIDE_ROOT');
  });

  it('нулевой байт — BAD_PATH', () => {
    expect(codeOf(() => splitRelPath('a\0b', 'linux'))).toBe('BAD_PATH');
  });

  it('isInside: соседняя папка с общим префиксом — не внутри', () => {
    const root = join(tmpdir(), 'root');
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, 'a', 'b'))).toBe(true);
    expect(isInside(root, `${root}-evil`)).toBe(false);
    expect(isInside(root, join(root, '..', 'x'))).toBe(false);
  });
});

describe('resolveInRoot: realpath-конфайнмент', () => {
  it('существующий путь внутри — ок; нет такого — NOT_FOUND; нет корня — ROOT_NOT_FOUND', async () => {
    const root = tmp();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    const r = await resolveInRoot(root, 'src/a.ts');
    expect(r.rel).toBe('src/a.ts');
    expect(await codeOfAsync(resolveInRoot(root, 'src/нет.ts'))).toBe('NOT_FOUND');
    expect(await codeOfAsync(resolveInRoot(join(root, 'нет-такой-папки'), ''))).toBe('ROOT_NOT_FOUND');
  });

  it('ссылка на папку наружу — OUTSIDE_ROOT (и сама ссылка, и путь сквозь неё)', async () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'секрет');
    linkDir(outside, join(root, 'escape'));
    expect(await codeOfAsync(resolveInRoot(root, 'escape'))).toBe('OUTSIDE_ROOT');
    expect(await codeOfAsync(resolveInRoot(root, 'escape/secret.txt'))).toBe('OUTSIDE_ROOT');
  });

  it('ссылка внутри корня — разрешена', async () => {
    const root = tmp();
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'f.txt'), 'ok');
    linkDir(join(root, 'real'), join(root, 'alias'));
    const r = await resolveInRoot(root, 'alias/f.txt');
    expect(r.rel).toBe('alias/f.txt');
  });

  it('файловый симлинк наружу — OUTSIDE_ROOT (на Windows без прав на симлинки — пропуск)', async (ctx) => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'секрет');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'), 'file');
    } catch {
      ctx.skip(); // Windows без режима разработчика/прав администратора: EPERM на файловый симлинк
      return;
    }
    expect(await codeOfAsync(resolveInRoot(root, 'leak.txt'))).toBe('OUTSIDE_ROOT');
  });
});
