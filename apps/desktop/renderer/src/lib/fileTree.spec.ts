import { describe, expect, it } from 'vitest';
import {
  ancestors, crumbs, dirTone, fmtSize, gitIndex, gitMark, insertAt, joinRel, markFor, matchFiles, mentionOf,
  normGitPath, parentOf, samePath, sortEntries, toAbs, vscodeUrl,
} from './fileTree';

describe('пути', () => {
  it('joinRel / parentOf / ancestors / crumbs', () => {
    expect(joinRel('', 'a')).toBe('a');
    expect(joinRel('a/b', 'c.ts')).toBe('a/b/c.ts');
    expect(parentOf('a/b/c.ts')).toBe('a/b');
    expect(parentOf('c.ts')).toBe('');
    expect(ancestors('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestors('c.ts')).toEqual([]);
    expect(crumbs('apps/desktop/x.ts')).toEqual(['apps', 'desktop', 'x.ts']);
  });

  it('папки сначала, имена по-человечески', () => {
    const e = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0 });
    const out = sortEntries([e('file10.ts', 'file'), e('b', 'dir'), e('file2.ts', 'file'), e('A', 'dir'), e('.git', 'dir')]);
    expect(out.map((x) => x.name)).toEqual(['.git', 'A', 'b', 'file2.ts', 'file10.ts']);
  });

  it('абсолютный путь — разделителем корня', () => {
    expect(toAbs('/opt/perimeter', 'apps/x.ts')).toBe('/opt/perimeter/apps/x.ts');
    expect(toAbs('/opt/perimeter/', 'x.ts')).toBe('/opt/perimeter/x.ts');
    expect(toAbs('C:\\devs\\perimeter', 'apps/x.ts')).toBe('C:\\devs\\perimeter\\apps\\x.ts');
    expect(toAbs('/opt/perimeter', '')).toBe('/opt/perimeter');
  });

  it('samePath: слэши любые, диск Windows без регистра', () => {
    expect(samePath('C:\\Devs\\x.ts', 'c:/devs/x.ts')).toBe(true);
    expect(samePath('/opt/A.ts', '/opt/a.ts')).toBe(false);
    expect(samePath('/opt/a/', '/opt/a')).toBe(true);
  });

  it('размер файла', () => {
    expect(fmtSize(512)).toBe('512 Б');
    expect(fmtSize(1536)).toBe('1,5 КБ');
    expect(fmtSize(200 * 1024)).toBe('200 КБ');
    expect(fmtSize(3.2 * 1024 * 1024)).toBe('3,2 МБ');
  });
});

describe('git', () => {
  it('метки porcelain', () => {
    expect(gitMark(' M')?.code).toBe('M');
    expect(gitMark('M ')?.code).toBe('M');
    expect(gitMark('MM')?.tone).toBe('mod');
    expect(gitMark('A ')?.code).toBe('A');
    expect(gitMark('AM')?.code).toBe('A');
    expect(gitMark('??')).toEqual({ code: '??', tone: 'new', label: 'не в git' });
    expect(gitMark(' D')?.tone).toBe('del');
    expect(gitMark('R ')?.code).toBe('R');
    expect(gitMark('UU')?.tone).toBe('conflict');
    expect(gitMark('M')?.code).toBe('M');
    expect(gitMark('')).toBeNull();
  });

  it('путь из porcelain: кавычки, переименование, обратные слэши', () => {
    expect(normGitPath('"docs/my notes.md"')).toBe('docs/my notes.md');
    expect(normGitPath('old.ts -> src/new.ts')).toBe('src/new.ts');
    expect(normGitPath('.\\src\\a.ts')).toBe('src/a.ts');
  });

  it('точки на папках — сильнейшая метка вложенных; неотслеживаемая папка целиком', () => {
    const idx = gitIndex([
      { path: 'apps/desktop/src/A.tsx', status: ' M' },
      { path: 'apps/desktop/new.ts', status: 'A ' },
      { path: 'docs/', status: '??' },
    ]);
    expect(markFor('apps/desktop/src/A.tsx', idx)?.code).toBe('M');
    expect(markFor('apps/desktop/src/B.tsx', idx)).toBeNull();
    expect(markFor('docs/notes.md', idx)?.code).toBe('??');
    expect(dirTone('apps', idx)).toBe('mod');
    expect(dirTone('apps/desktop', idx)).toBe('mod');
    expect(dirTone('docs', idx)).toBe('new');
    expect(dirTone('docs/sub', idx)).toBe('new');
    expect(dirTone('packages', idx)).toBeNull();
    expect(idx.paths).toEqual(['apps/desktop/new.ts', 'apps/desktop/src/A.tsx', 'docs/']);
  });
});

describe('поиск файла', () => {
  const paths = ['apps/desktop/src/Feed.tsx', 'apps/desktop/src/lib/feedModel.ts', 'packages/protocol/src/frames.ts', 'README.md', 'docs/feed.md'];
  it('имя с начала важнее, чем вхождение в путь', () => {
    expect(matchFiles('feed', paths)).toEqual(['docs/feed.md', 'apps/desktop/src/Feed.tsx', 'apps/desktop/src/lib/feedModel.ts']);
  });
  it('буквы по порядку (fuzzy) и путь со слэшем', () => {
    expect(matchFiles('frms', paths)).toEqual(['packages/protocol/src/frames.ts']);
    expect(matchFiles('src/lib', paths)).toEqual(['apps/desktop/src/lib/feedModel.ts']);
  });
  it('пустой запрос — пусто; дубли схлопываются', () => {
    expect(matchFiles('  ', paths)).toEqual([]);
    expect(matchFiles('readme', ['README.md', 'README.md'])).toEqual(['README.md']);
  });
});

describe('упоминание и VS Code', () => {
  it('@путь, с пробелами — в кавычках', () => {
    expect(mentionOf('apps/x.ts')).toBe('@apps/x.ts');
    expect(mentionOf('docs/my notes.md')).toBe('@"docs/my notes.md"');
  });

  it('вставка в позицию курсора с пробелами по краям', () => {
    expect(insertAt('', 0, '@a.ts')).toEqual({ text: '@a.ts ', caret: 6 });
    expect(insertAt('глянь', 5, '@a.ts')).toEqual({ text: 'глянь @a.ts ', caret: 12 });
    expect(insertAt('глянь  и', 6, '@a.ts')).toEqual({ text: 'глянь @a.ts и', caret: 11 });
    expect(insertAt('x', 99, '@a')).toEqual({ text: 'x @a ', caret: 5 });
  });

  it('ссылки VS Code: локальный файл и Remote SSH', () => {
    expect(vscodeUrl('local', 'C:\\devs\\my app\\x.ts', null)).toBe('vscode://file/C:/devs/my%20app/x.ts');
    expect(vscodeUrl('local', '/home/u/x.ts', null)).toBe('vscode://file/home/u/x.ts');
    expect(vscodeUrl('vps', '/opt/perimeter/a.ts', { host: '10.0.0.5', user: 'yan' })).toBe('vscode://vscode-remote/ssh-remote+yan@10.0.0.5/opt/perimeter/a.ts');
    expect(vscodeUrl('vps', '/opt/a.ts', { host: 'h', user: 'u', port: 2222 })).toBe('vscode://vscode-remote/ssh-remote+u@h:2222/opt/a.ts');
    expect(vscodeUrl('vps', '/opt/a.ts', null)).toBeNull();
  });
});
