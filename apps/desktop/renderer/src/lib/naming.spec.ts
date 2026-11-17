import { describe, expect, it } from 'vitest';
import { SLUG_RE, looksLikeGitUrl, projectSlug, repoNameFromUrl, sessionNameFrom } from './naming';

describe('имя сессии из первого сообщения', () => {
  it('первая непустая строка без markdown', () => {
    expect(sessionNameFrom('\n\n## Почини кольцо контекста\nподробности ниже')).toBe('Почини кольцо контекста');
    expect(sessionNameFrom('- проверь `README` на **чистой** машине.')).toBe('проверь README на чистой машине');
  });
  it('длинное — обрезается по слову с многоточием', () => {
    const n = sessionNameFrom('Проверь инструкцию из README на сервере с нуля в чистой папке и составь отчёт');
    expect(n.length).toBeLessThanOrEqual(49);
    expect(n.endsWith('…')).toBe(true);
    expect(n).toBe('Проверь инструкцию из README на сервере с нуля…');
  });
  it('пусто — «новая сессия»', () => {
    expect(sessionNameFrom('   \n ')).toBe('новая сессия');
  });
});

describe('папка проекта из названия', () => {
  it('транслит и дефисы', () => {
    expect(projectSlug('лендинг студии')).toBe('lending-studii');
    expect(projectSlug('Конвейер роликов')).toBe('konveyer-rolikov');
    expect(projectSlug('perimeter')).toBe('perimeter');
    expect(projectSlug('Щука & ёж: v2.0!')).toBe('schuka-ezh-v2.0');
  });
  it('мусор по краям и пустое', () => {
    expect(projectSlug('  --.проект.--  ')).toBe('proekt');
    expect(projectSlug('!!!')).toBe('project');
  });
  it('результат всегда проходит схему протокола', () => {
    for (const n of ['лендинг студии', 'Ä b', '日本', 'x'.repeat(200), '-a', '.hidden']) expect(projectSlug(n)).toMatch(SLUG_RE);
  });
});

describe('ссылка git', () => {
  it('имя репозитория', () => {
    expect(repoNameFromUrl('git@github.com:revealyan/studio-site.git')).toBe('studio-site');
    expect(repoNameFromUrl('https://github.com/revealyan/perimeter/')).toBe('perimeter');
    expect(repoNameFromUrl('file:///srv/git/pipeline.git')).toBe('pipeline');
    expect(repoNameFromUrl('')).toBe('');
  });
  it('похожа ли на ссылку', () => {
    expect(looksLikeGitUrl('git@github.com:a/b.git')).toBe(true);
    expect(looksLikeGitUrl('https://github.com/a/b')).toBe(true);
    expect(looksLikeGitUrl('-u evil')).toBe(false);
    expect(looksLikeGitUrl('просто текст')).toBe(false);
  });
});
