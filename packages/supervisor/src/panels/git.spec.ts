// Панель git: разбор porcelain v1 -z (переименования, пробелы, юникод, ветки) и живой git на временном репо.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitStatus, parsePorcelainZ } from './git.js';

const Z = '\0';

describe('parsePorcelainZ', () => {
  it('ветка с апстримом и расхождением; M/A/D/MM; переименование с пробелами (to, затем from); неотслеживаемая папка', () => {
    const out = [
      '## main...origin/main [ahead 2, behind 1]',
      ' M src/a.ts',
      'R  new name.txt', 'old name.txt',
      '?? dir with space/',
      'A  added.ts',
      'MM both.ts',
      ' D gone.ts',
      'C  copy.ts', 'orig.ts',
      '',
    ].join(Z);
    const r = parsePorcelainZ(out);
    expect(r).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(r.files).toEqual([
      { path: 'src/a.ts', status: 'M', xy: ' M' },
      { path: 'new name.txt', status: 'R', xy: 'R ', from: 'old name.txt' },
      { path: 'dir with space/', status: '??', xy: '??' },
      { path: 'added.ts', status: 'A', xy: 'A ' },
      { path: 'both.ts', status: 'MM', xy: 'MM' },
      { path: 'gone.ts', status: 'D', xy: ' D' },
      { path: 'copy.ts', status: 'C', xy: 'C ', from: 'orig.ts' },
    ]);
  });

  it('пути — относительно папки сессии (префикс снимается; from снаружи — через ../)', () => {
    const out = ['## dev', ' M packages/x/src/a.ts', 'R  packages/x/b.ts', 'other/b.ts', '?? packages/x/new/', ''].join(Z);
    const r = parsePorcelainZ(out, 'packages/x/');
    expect(r.branch).toBe('dev');
    expect(r.upstream).toBeUndefined();
    expect(r.files).toEqual([
      { path: 'src/a.ts', status: 'M', xy: ' M' },
      { path: 'b.ts', status: 'R', xy: 'R ', from: '../../other/b.ts' },
      { path: 'new/', status: '??', xy: '??' },
    ]);
  });

  it('юникод и спецсимволы в путях не экранируются (-z)', () => {
    const r = parsePorcelainZ(['## main', '?? папка/файл "с кавычками".txt', ' M tab\there.txt', ''].join(Z));
    expect(r.files.map((f) => f.path)).toEqual(['папка/файл "с кавычками".txt', 'tab\there.txt']);
  });

  it('варианты строки ветки: без коммитов, detached, gone, без апстрима', () => {
    expect(parsePorcelainZ(`## No commits yet on main${Z}`).branch).toBe('main');
    expect(parsePorcelainZ(`## Initial commit on master${Z}`).branch).toBe('master');
    expect(parsePorcelainZ(`## HEAD (no branch)${Z}`)).toMatchObject({ branch: 'HEAD', detached: true });
    expect(parsePorcelainZ(`## feat/x...origin/feat/x [gone]${Z}`)).toMatchObject({ branch: 'feat/x', upstream: 'origin/feat/x' });
    expect(parsePorcelainZ(`## release/1.2${Z}`)).toMatchObject({ branch: 'release/1.2', files: [] });
  });

  it('лимит файлов → truncated', () => {
    const out = ['## main', ...Array.from({ length: 10 }, (_, i) => `?? f${i}`), ''].join(Z);
    const r = parsePorcelainZ(out, '', 4);
    expect(r.files).toHaveLength(4);
    expect(r.truncated).toBe(true);
  });
});

let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }

describe.skipIf(!hasGit)('gitStatus на живом репозитории', () => {
  const tmps: string[] = [];
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'cc-git-'));
    tmps.push(d);
    // git не должен найти репозиторий выше временной папки (например, ~ под git)
    process.env.GIT_CEILING_DIRECTORIES = dirname(d);
    return d;
  }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

  it('не репозиторий → branch null, files [] (не ошибка)', async () => {
    const d = tmp();
    const r = await gitStatus(d);
    expect(r).toEqual({ root: d, branch: null, files: [] });
  });

  it('из подпапки репозитория: пути от папки сессии, переименование и пробелы', async () => {
    const d = tmp();
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'config', 'user.email', 't@t');
    git(d, 'config', 'user.name', 't');
    git(d, 'config', 'core.autocrlf', 'false');
    mkdirSync(join(d, 'sub', 'inner'), { recursive: true });
    writeFileSync(join(d, 'sub', 'old.txt'), 'a\n');
    writeFileSync(join(d, 'sub', 'with space.txt'), 'b\n');
    writeFileSync(join(d, 'top.txt'), 'c\n');
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'init');
    git(d, 'mv', 'sub/old.txt', 'sub/new name.txt');
    writeFileSync(join(d, 'sub', 'with space.txt'), 'b\nx\n');
    writeFileSync(join(d, 'sub', 'inner', 'u.txt'), 'u\n');
    writeFileSync(join(d, 'top.txt'), 'c\ny\n'); // вне папки сессии — не попадает

    const r = await gitStatus(join(d, 'sub'));
    expect(r.branch).toBe('main');
    expect(r.files).toEqual([
      { path: 'new name.txt', status: 'R', xy: 'R ', from: 'old.txt' },
      { path: 'with space.txt', status: 'M', xy: ' M' },
      { path: 'inner/', status: '??', xy: '??' },
    ]);

    const top = await gitStatus(d);
    expect(top.files.map((f) => f.path).sort()).toEqual(['sub/inner/', 'sub/new name.txt', 'sub/with space.txt', 'top.txt']);
  });
});
