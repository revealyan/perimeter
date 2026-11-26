// Переезд пакетом: источник собирает выбранное (аккаунты, MCP, проекты git/не git, сессии, журнал), цель с уже
// своим содержимым показывает превью и импортирует, ничего своего не трогая. Настоящие git и tar, временные HOME.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendChunk, exportPackage, readChunk, readManifest, sha256File, type MigrateSelection } from './migratePackage.js';
import { importPackage, previewImport, type ImportDeps } from './migrateImport.js';
import { projectSlug } from './transcript.js';
import type { SavedSession, SessionInfo } from './session/manager.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'mpk-')); dirs.push(d); return d; };
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env });

/** Источник: аккаунт-шлюз (своя папка Claude Code), проект git с недопушенным и правками, проект не git, сессии. */
function source() {
  const home = tmp();
  const cfg = join(home, '.perimeter', 'accounts', 'zai', '.claude');
  mkdirSync(join(cfg, 'skills', 'review'), { recursive: true });
  writeFileSync(join(cfg, 'skills', 'review', 'SKILL.md'), '# review');
  writeFileSync(join(cfg, 'settings.json'), '{"model":"glm"}');
  writeFileSync(join(cfg, 'CLAUDE.md'), 'память');
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } }, numStartups: 9 }));
  const root = join(home, 'projects');
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  git(app, 'init', '-q', '-b', 'main');
  writeFileSync(join(app, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(join(app, 'a.txt'), '1\n');
  git(app, 'add', '.');
  git(app, 'commit', '-q', '-m', 'init');
  git(app, 'remote', 'add', 'origin', 'git@github.com:u/app.git');
  git(app, 'branch', 'perimeter/w-1');
  writeFileSync(join(app, 'a.txt'), '1\n2\n');               // правка
  writeFileSync(join(app, 'new.txt'), 'n');                    // новый файл
  writeFileSync(join(app, '.env'), 'SECRET=1');                // игнорируемый не-тяжёлый
  mkdirSync(join(app, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'x', 'i.js'), 'x');  // тяжёлое — не едет
  const notes = join(root, 'notes');
  mkdirSync(join(notes, 'dist'), { recursive: true });
  writeFileSync(join(notes, 'idea.md'), 'идея');
  writeFileSync(join(notes, 'dist', 'out.js'), 'build');
  // сессии: транскрипт в папке аккаунта, задачи
  const csid = '11111111-2222-4333-8444-555555555555';
  mkdirSync(join(cfg, 'projects', projectSlug(app)), { recursive: true });
  writeFileSync(join(cfg, 'projects', projectSlug(app), `${csid}.jsonl`), `${JSON.stringify({ type: 'user', cwd: app, message: { role: 'user', content: 'привет' } })}\n`);
  mkdirSync(join(cfg, 'tasks', csid), { recursive: true });
  writeFileSync(join(cfg, 'tasks', csid, '1.json'), '{"subject":"задача"}');
  const thinking = join(home, '.perimeter', 'thinking.log');
  writeFileSync(thinking, `${'a'.repeat(32)} "мысль раз"\n${'b'.repeat(32)} "мысль два"\n`);
  const sessions: SessionInfo[] = [
    { id: 's-1', name: 'фича', state: 'dead', needs: null, claudeSessionId: csid, cwd: app, profile: 'zai', projectId: 'p-app', effort: 'high' },
    { id: 's-2', name: 'без истории', state: 'dead', needs: null, claudeSessionId: '99999999-2222-4333-8444-555555555555', cwd: app, profile: 'zai' },
  ];
  return {
    home, cfg, app, notes, csid,
    deps: {
      profiles: [{ profile: { name: 'zai', configDir: cfg, env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-zai', CLAUDE_CONFIG_DIR: cfg }, model: 'glm-5.4' }, external: 'zai' }],
      projects: [{ name: 'app', path: app, profile: 'zai' }, { name: 'notes', path: notes }],
      storageRoot: root, sessions, externalOf: (p: string | undefined) => p ?? 'default',
      mcpShared: { figma: { config: { url: 'https://figma', headers: { Authorization: 'Bearer f' } } }, zread: { config: { url: 'https://z' } } },
      thinkingFile: thinking, rbProfileDir: join(home, 'rb'), workDir: join(home, '.perimeter', 'migrations'), home,
    },
  };
}

const ALL: MigrateSelection = { accounts: ['zai'], mcp: ['figma', 'zread'], projects: ['app', 'notes'], sessions: 'all', thinking: true, browser: false, gitIdentity: false, secrets: true };

/** Цель, где уже кое-что есть: свой аккаунт «main», MCP «figma», папка projects/app занята чужим. */
function target() {
  const home = tmp();
  const root = join(home, 'projects');
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'чужое.txt'), 'не трогать');
  const accounts = new Map<string, { internal: string | undefined; configDir: string; profile?: unknown }>([['main', { internal: 'main', configDir: join(home, 'acc-main') }]]);
  const mcp = new Map<string, unknown>([['figma', { config: { url: 'https://мой-figma' } }]]);
  const projects: Array<{ id: string; name: string; path: string }> = [];
  const sessions: SavedSession[] = [];
  const thinking = new Map<string, string>([['a'.repeat(32), 'мысль раз']]);
  const deps: ImportDeps = {
    accountExists: (n) => accounts.has(n),
    mcpExists: (n) => mcp.has(n),
    projectByName: (n) => projects.find((p) => p.name === n),
    storageRoot: root,
    sessionExists: (id) => sessions.some((s) => s.id === id),
    browserProfileBusy: false,
    gitIdentitySet: true,
    createAccount: (ext, profile) => { const r = { internal: ext, configDir: join(home, 'accounts', ext, '.claude'), profile }; accounts.set(ext, r); return r; },
    accountDir: (ext) => accounts.get(ext),
    defaultAccount: () => ({ internal: undefined, configDir: join(home, '.claude') }),
    putMcp: (n, e) => { mcp.set(n, e); },
    createProject: (p) => { const r = { id: `id-${p.name}`, ...p }; projects.push(r); return r; },
    projectIdByName: (n) => projects.find((p) => p.name === n)?.id,
    importSession: (s) => { sessions.push(s); return true; },
    thinkingPut: (k, t) => { thinking.set(k, t); },
    thinkingHas: (k) => thinking.has(k),
    browserDir: join(home, 'rb'),
  };
  return { home, root, accounts, mcp, projects, sessions, thinking, deps };
}

describe('переезд пакетом', () => {
  it('экспорт: манифест по выбранному; ключи — только с галкой «с ключами»; сессия без транскрипта не едет', async () => {
    const s = source();
    const r = await exportPackage(ALL, s.deps);
    expect(r.manifest).toMatchObject({
      format: 'perimeter-migration', secretsIncluded: true,
      accounts: [{ name: 'zai', kind: 'gateway', needsLogin: false, secretIncluded: true }],
      mcp: ['figma', 'zread'],
      projects: [{ name: 'app', route: 'bundle', remote: 'git@github.com:u/app.git', branch: 'main', patch: true, files: true }, { name: 'notes', route: 'archive' }],
      sessions: [{ id: 's-1', account: 'zai', project: 'app' }], thinking: true,
    });
    expect(await sha256File(r.file)).toBe(r.sha256);
    expect((await readManifest(r.file)).sessions).toHaveLength(1);
    const noKeys = await exportPackage({ ...ALL, secrets: false }, s.deps);
    expect(noKeys.manifest.accounts[0]!.secretIncluded).toBe(false);
    expect(noKeys.manifest.mcp).toEqual([]); // общие MCP — это токены: без галки не едут
    expect(existsSync(join(s.deps.workDir, 'out', r.id))).toBe(false); // черновик сборки убран
  });

  it('передача кусками: по порядку, повтор/пропуск отвергается, итог совпадает байт в байт', async () => {
    const s = source();
    const r = await exportPackage(ALL, s.deps);
    const dst = join(tmp(), 'in.tgz');
    let off = 0;
    for (;;) {
      const c = readChunk(r.file, off, 4096);
      off = appendChunk(dst, off, c.data);
      if (c.eof) break;
    }
    expect(() => appendChunk(dst, 0, 'AAAA')).toThrow(/не по порядку/);
    expect(statSync(dst).size).toBe(r.bytes);
    expect(await sha256File(dst)).toBe(r.sha256);
  });

  it('превью на цели со своим: свой аккаунт/MCP не трогаем, занятая папка проекта — рядом под другим именем', async () => {
    const s = source();
    const t = target();
    const r = await exportPackage(ALL, s.deps);
    const plan = previewImport(r.manifest, t.deps);
    const by = (id: string) => plan.find((p) => p.id === id)!;
    expect(by('acc:zai')).toMatchObject({ action: 'add', on: true });
    expect(by('mcp:figma')).toMatchObject({ action: 'exists', on: false });
    expect(by('mcp:zread')).toMatchObject({ action: 'add', on: true });
    expect(by('prj:0')).toMatchObject({ action: 'rename', on: true });
    expect(by('prj:0').detail).toContain(join(t.root, 'app-2'));
    expect(by('prj:1')).toMatchObject({ action: 'add' });
    expect(by('ses:s-1')).toMatchObject({ action: 'add', on: true });
    expect(by('git')).toBeUndefined(); // git-имя не выбирали
  });

  it('импорт: аккаунт с файлами, MCP без своего, git — ветки/stash/правки/.env без node_modules, не git — без dist, сессия с задачами, журнал без дублей; чужое цело', async () => {
    const s = source();
    git(s.app, 'stash', 'push', '-q', '--include-untracked', '--', 'new.txt'); // stash тоже едет
    writeFileSync(join(s.app, 'new.txt'), 'n'); // и новый файл — снова на месте
    const t = target();
    const r = await exportPackage(ALL, s.deps);
    const chosen = new Set(previewImport(r.manifest, t.deps).filter((p) => p.on).map((p) => p.id));
    const lines = await importPackage(r.file, r.manifest, chosen, t.deps);
    expect(lines.filter((l) => !l.ok)).toEqual([]);
    // аккаунт: заведён с ключом, без CLAUDE_CONFIG_DIR источника; файлы — в его папку
    const acc = t.accounts.get('zai')! as { configDir: string; profile: { env: Record<string, string> } };
    expect(acc.profile.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-zai' });
    expect(readFileSync(join(acc.configDir, 'CLAUDE.md'), 'utf8')).toBe('память');
    expect(existsSync(join(acc.configDir, 'skills', 'review', 'SKILL.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(acc.configDir, '.claude.json'), 'utf8')).mcpServers).toEqual({ db: { command: 'db-mcp' } });
    // MCP: свой figma не тронут, zread добавлен
    expect(t.mcp.get('figma')).toEqual({ config: { url: 'https://мой-figma' } });
    expect(t.mcp.has('zread')).toBe(true);
    // git-проект — рядом с чужой папкой
    const app2 = join(t.root, 'app-2');
    expect(readFileSync(join(t.root, 'app', 'чужое.txt'), 'utf8')).toBe('не трогать');
    // правка легла (на Windows git с core.autocrlf отдаёт \r\n — сравниваем без окончаний строк)
    expect(readFileSync(join(app2, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('1\n2\n');
    expect(readFileSync(join(app2, '.env'), 'utf8')).toBe('SECRET=1');     // игнорируемое — едет
    expect(existsSync(join(app2, 'new.txt'))).toBe(true);
    expect(existsSync(join(app2, 'node_modules'))).toBe(false);            // тяжёлое — нет
    expect(git(app2, 'remote', 'get-url', 'origin').trim()).toBe('git@github.com:u/app.git');
    expect(git(app2, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()).toEqual(['main', 'perimeter/w-1']);
    expect(git(app2, 'stash', 'list')).toMatch(/stash@\{0\}/);
    expect(git(app2, 'branch', '--show-current').trim()).toBe('main');
    // не git — без dist
    const notes = join(t.root, 'notes');
    expect(readFileSync(join(notes, 'idea.md'), 'utf8')).toBe('идея');
    expect(existsSync(join(notes, 'dist'))).toBe(false);
    // сессия: в новом проекте и аккаунте, транскрипт с новым cwd, задачи рядом
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0]).toMatchObject({ id: 's-1', name: 'фича', cwd: app2, profile: 'zai', projectId: 'id-app', effort: 'high', claudeSessionId: s.csid });
    const tr = readFileSync(join(acc.configDir, 'projects', projectSlug(app2), `${s.csid}.jsonl`), 'utf8');
    expect(JSON.parse(tr.split('\n')[0]!).cwd).toBe(app2);
    expect(existsSync(join(acc.configDir, 'tasks', s.csid, '1.json'))).toBe(true);
    // журнал: была одна из двух — дописана только вторая
    expect([...t.thinking.keys()].sort()).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    expect(lines.find((l) => l.id === 'thinking')?.text).toBe('журнал размышлений: +1');
    // повторный импорт того же пакета — ничего не дублирует
    const again = await importPackage(r.file, r.manifest, chosen, t.deps);
    expect(t.sessions).toHaveLength(1);
    expect(again.filter((l) => l.id.startsWith('ses:') || l.id.startsWith('acc:'))).toEqual([]);
  });
});
