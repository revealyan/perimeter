// Папки сессий и проектов: несуществующая папка даёт понятную ошибку, а не «native binary … libc»
// (случай 2026-11-10 на VPS: проект с путём /opt/project1, которого нет → ENGINE_CRASH).
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCwd } from './session/sdk.js';
import { ensureProjectDir } from './wss.js';

const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cc-dirs-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('папка сессии', () => {
  it('есть — ок; нет — понятная ошибка с путём', () => {
    const root = tmp();
    expect(() => assertCwd(root)).not.toThrow();
    expect(() => assertCwd(undefined)).not.toThrow();
    expect(() => assertCwd(join(root, 'нет-такой'))).toThrow(/папки .*нет-такой нет на этой машине/);
  });
  it('файл вместо папки — тоже ошибка', () => {
    const root = tmp();
    const f = join(root, 'file.txt');
    writeFileSync(f, 'x');
    expect(() => assertCwd(f)).toThrow(/нет на этой машине/);
  });
});

describe('папка проекта', () => {
  it('нет — создаётся (вложенно)', () => {
    const p = join(tmp(), 'a', 'b', 'project1');
    expect(ensureProjectDir(p)).toBeNull();
    expect(statSync(p).isDirectory()).toBe(true);
  });
  it('уже есть — ок, ничего не трогаем', () => {
    expect(ensureProjectDir(tmp())).toBeNull();
  });
  it('относительный путь и файл — ошибки текстом', () => {
    expect(ensureProjectDir('project1')).toMatch(/абсолютным/);
    const root = tmp();
    const f = join(root, 'f');
    writeFileSync(f, 'x');
    expect(ensureProjectDir(f)).toMatch(/это файл/);
  });
});
