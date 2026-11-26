// Переезд, этап 1 — опись: размеры без тяжёлого, состояние git (что клоном, что бандлом/патчем/архивом), аккаунты
// по способу входа; секреты — только флагом.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountInventory, collectInventory, dirSize, gitState } from './migrate.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'mig-')); dirs.push(d); return d; };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

describe('переезд: опись', () => {
  it('размер — без тяжёлого (его списком) и без .git/worktrees воркеров', () => {
    const r = tmp();
    writeFileSync(join(r, 'a.txt'), 'hello');
    mkdirSync(join(r, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(r, 'node_modules', 'x', 'big.js'), 'x'.repeat(5000));
    mkdirSync(join(r, '.perimeter', 'wt', 'abc'), { recursive: true });
    writeFileSync(join(r, '.perimeter', 'wt', 'abc', 'copy.txt'), 'x'.repeat(100));
    mkdirSync(join(r, 'src'));
    writeFileSync(join(r, 'src', 'b.ts'), '12345678');
    expect(dirSize(r)).toEqual({ bytes: 13, files: 2, heavy: ['node_modules'], truncated: false });
  });

  it('git: незакоммиченное, новое, локальные ветки без upstream, stash, игнорируемое не-тяжёлое (.env); не git — null', async () => {
    const r = tmp();
    git(r, 'init', '-q', '-b', 'main');
    writeFileSync(join(r, '.gitignore'), 'node_modules/\n.env\n');
    writeFileSync(join(r, 'a.txt'), '1');
    git(r, 'add', '.');
    git(r, 'commit', '-q', '-m', 'init');
    git(r, 'branch', 'perimeter/w-1234');
    writeFileSync(join(r, 'a.txt'), '2');
    writeFileSync(join(r, 'new.txt'), 'n');
    writeFileSync(join(r, '.env'), 'SECRET=1');
    mkdirSync(join(r, 'node_modules'));
    writeFileSync(join(r, 'node_modules', 'm.js'), '');
    writeFileSync(join(r, 'stashme.txt'), 's');
    git(r, 'add', 'stashme.txt');
    git(r, 'stash', 'push', '-q', '--', 'stashme.txt');
    const g = await gitState(r);
    expect(g).toMatchObject({ remote: null, branch: 'main', dirty: 1, untracked: 1, unpushed: null, stash: 1, ignored: ['.env'] });
    expect(g!.localBranches.sort()).toEqual(['main', 'perimeter/w-1234']);
    const plain = tmp();
    expect(await gitState(plain)).toBeNull();
    // папка внутри чужого репозитория — не свой git
    mkdirSync(join(r, 'sub'));
    expect(await gitState(join(r, 'sub'))).toBeNull();
  });

  it('git по другому написанию пути (ссылка; на Windows — короткие имена RUNNER~1) — всё равно свой git', async () => {
    const r = tmp();
    git(r, 'init', '-q', '-b', 'main');
    writeFileSync(join(r, 'a.txt'), '1');
    git(r, 'add', '.');
    git(r, 'commit', '-q', '-m', 'init');
    const alias = join(tmp(), 'alias');
    symlinkSync(r, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await gitState(alias)).toMatchObject({ branch: 'main', dirty: 0 });
  });

  it('аккаунты: способ входа, ключ — флагом без значения, свои skills (не симлинки), MCP аккаунта, транскрипты', () => {
    const base = tmp();
    const own = join(tmp(), '.claude');
    mkdirSync(join(own, 'skills', 'mine'), { recursive: true });
    mkdirSync(join(base, 'commands'), { recursive: true });
    symlinkSync(join(base, 'commands'), join(own, 'commands'), process.platform === 'win32' ? 'junction' : 'dir'); // Windows без прав — junction
    writeFileSync(join(own, '.claude.json'), JSON.stringify({ mcpServers: { figma: {}, db: {} }, other: 1 }));
    mkdirSync(join(own, 'projects', '-p'), { recursive: true });
    writeFileSync(join(own, 'projects', '-p', 's.jsonl'), 'x'.repeat(10));
    const a = accountInventory({ name: 'zai', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-secret' }, configDir: own }, 'zai', base);
    expect(a).toMatchObject({ kind: 'gateway', baseUrl: 'https://api.z.ai/api/anthropic', hasSecret: true, ownConfigDir: true, mcpServers: ['db', 'figma'], skills: 1, commands: 0, transcripts: { files: 1, bytes: 10 } });
    expect(JSON.stringify(a)).not.toContain('sk-secret');
    writeFileSync(join(own, '.credentials.json'), '{}');
    expect(accountInventory({ name: 'c', configDir: own }, 'c', base).kind).toBe('subscription-login');
    expect(accountInventory({ name: 't', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat' }, configDir: own }, 't', base).kind).toBe('subscription-token');
  });

  it('сводка: сессии по аккаунтам, без проекта, без транскрипта, архив; общие MCP; журнал размышлений', async () => {
    const home = tmp();
    const proj = join(home, 'projects', 'p1');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(home, 'mcp-shared.json'), JSON.stringify({ version: 1, servers: { zread: {}, figma: {} } }));
    writeFileSync(join(home, 'thinking.log'), 'x'.repeat(42));
    const sessions = [
      { id: '1', name: 'a', state: 'dead', needs: null, cwd: proj, projectId: 'p', claudeSessionId: 'c1', profile: 'zai' },
      { id: '2', name: 'b', state: 'dead', needs: null, cwd: home, claudeSessionId: 'c2', archived: true },
      { id: '3', name: 'c', state: 'dead', needs: null, cwd: '/tmp/x', profile: 'zai' },
    ] as never[];
    const inv = await collectInventory({
      profiles: [{ profile: { name: 'zai', env: { ANTHROPIC_BASE_URL: 'u', ANTHROPIC_AUTH_TOKEN: 'k' } }, external: 'zai' }],
      projects: [{ name: 'p1', path: proj }], storageRoot: join(home, 'projects'), sessions,
      hasTranscript: (s) => (s as { claudeSessionId?: string }).claudeSessionId === 'c1',
      externalOf: (p) => p ?? 'по умолчанию',
      thinkingFile: join(home, 'thinking.log'), mcpSharedFile: join(home, 'mcp-shared.json'), rbProfileDir: join(home, 'rb'), version: 't', home,
    });
    expect(inv.sessions).toEqual({ total: 3, archived: 1, withoutProject: 2, noTranscript: 2, byAccount: { zai: 2, 'по умолчанию': 1 } });
    expect(inv.mcpShared).toEqual(['figma', 'zread']);
    expect(inv.thinking.bytes).toBe(42);
    expect(inv.projects[0]).toMatchObject({ name: 'p1', exists: true, git: null, sessions: 1 });
    expect(inv.browserProfile).toEqual({ exists: false, bytes: 0 });
    expect(inv.server).toMatchObject({ home, storageRoot: join(home, 'projects') });
  });
});
