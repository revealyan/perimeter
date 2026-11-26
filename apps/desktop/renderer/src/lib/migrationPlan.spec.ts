import { describe, expect, it } from 'vitest';
import type { AccountKind, Inventory, InventoryAccount, InventoryProject } from '@perimeter/protocol';
import { fmtBytes, migrationPlan, projectRoute } from './migrationPlan';

const proj = (o: Partial<InventoryProject>): InventoryProject => ({ name: 'p', path: '/home/yan/projects/p', exists: true, bytes: 1000, files: 3, heavy: [], truncated: false, git: null, sessions: 0, ...o });
const git = (o: Partial<NonNullable<InventoryProject['git']>> = {}) => ({ remote: 'git@github.com:u/p.git', branch: 'main', head: 'abc', dirty: 0, untracked: 0, unpushed: 0, localBranches: [], stash: 0, ignored: [], ...o });
const inv = (o: Partial<Inventory> = {}): Inventory => ({
  server: { host: 'h', user: 'yan', home: '/home/yan', platform: 'linux', version: 'v', storageRoot: '/home/yan/projects' },
  accounts: [], mcpShared: [], projects: [],
  sessions: { total: 0, archived: 0, withoutProject: 0, noTranscript: 0, byAccount: {} },
  thinking: { bytes: 0 }, browserProfile: { exists: false, bytes: 0 }, git: { name: null, email: null },
  github: { keyComment: null, fingerprint: null }, extras: { crontab: false, userUnits: [], dockerData: false }, ...o,
});
const acc = (name: string, kind: AccountKind, baseUrl?: string): InventoryAccount => ({ name, kind, ...(baseUrl ? { baseUrl } : {}), hasSecret: true, ownConfigDir: true, settings: false, claudeMd: false, mcpServers: [], skills: 0, commands: 0, agents: 0, plugins: 0, transcripts: { files: 0, bytes: 0 } });

describe('план переезда', () => {
  it('проект: git — целиком бандлом (ветки/stash/правки/вне git — пометками); не git — архив', () => {
    expect(projectRoute(proj({ git: git() }))).toEqual({ action: 'bundle', extras: [] });
    expect(projectRoute(proj({ git: git({ dirty: 2, ignored: ['.env'] }) }))).toEqual({ action: 'bundle', extras: ['правки в 2 файл.', '.env (вне git)'] });
    expect(projectRoute(proj({ git: git({ unpushed: 3, localBranches: ['perimeter/w-1'], stash: 1 }) })).extras).toEqual(['ветки: perimeter/w-1', '3 коммит. не на remote', 'stash 1']);
    expect(projectRoute(proj({}))).toEqual({ action: 'archive', extras: [] });
  });

  it('аккаунты: есть на цели — exists (другой шлюз — предупреждение); вход подписки — заново; ключ/токен — поедет', () => {
    const plan = migrationPlan(
      inv({ accounts: [acc('zai', 'gateway', 'https://api.z.ai/api/anthropic'), acc('claude', 'subscription-login'), acc('work', 'api-key'), acc('Main', 'gateway', 'https://a')] }),
      inv({ accounts: [acc('main', 'gateway', 'https://b')] }),
    );
    const a = plan.filter((i) => i.group === 'accounts').map((i) => [i.title, i.action, i.on, !!i.warn]);
    expect(a).toEqual([['zai', 'copy', true, false], ['claude', 'manual', false, false], ['work', 'copy', true, false], ['Main', 'exists', false, true]]);
  });

  it('проекты и сессии: есть на цели — не трогаем; большие через приложение — предупреждение; сессии без истории и архив — отдельно', () => {
    const plan = migrationPlan(
      inv({
        projects: [proj({ name: 'perimeter', git: git(), heavy: ['node_modules'] }), proj({ name: 'notes', bytes: 300 * 1024 * 1024 }), proj({ name: 'gone', exists: false }), proj({ name: 'Here', git: git() })],
        sessions: { total: 14, archived: 2, withoutProject: 7, noTranscript: 4, byAccount: {} },
        mcpShared: ['figma', 'zread'], thinking: { bytes: 300_000 }, browserProfile: { exists: true, bytes: 48_000_000 },
      }),
      inv({ projects: [proj({ name: 'here', path: '/srv/here', git: git() })], mcpShared: ['figma'] }),
    );
    const by = (id: string) => plan.find((i) => i.id === id)!;
    expect(by('prj:perimeter')).toMatchObject({ action: 'bundle', on: true });
    expect(by('prj:perimeter').detail).toContain('не везём: node_modules');
    expect(by('prj:notes')).toMatchObject({ action: 'archive', on: true });
    expect(by('prj:notes').warn).toMatch(/долго/);
    expect(by('prj:gone').action).toBe('skip');
    expect(by('prj:Here').action).toBe('exists');
    expect(by('mcp:figma').action).toBe('exists');
    expect(by('mcp:zread')).toMatchObject({ action: 'copy', on: true });
    expect(by('ses:active').detail).toMatch(/^8 с историей/);
    expect(by('ses:archived').on).toBe(false);
    expect(by('ses:empty').action).toBe('skip');
    expect(by('data:thinking').on).toBe(true);
    expect(by('data:browser').on).toBe(false);
  });

  it('ключ GitHub — не копируем: на цели создать (или уже есть); вне Perimeter — списком дел', () => {
    const plan = migrationPlan(inv({ github: { keyComment: 'perimeter-velohost', fingerprint: 'x' }, extras: { crontab: true, userUnits: ['bot.service'], dockerData: true } }), inv());
    expect(plan.filter((i) => i.group === 'todo').map((i) => [i.id, i.action])).toEqual([['todo:github', 'manual'], ['todo:cron', 'manual'], ['todo:units', 'manual'], ['todo:docker', 'manual']]);
    expect(fmtBytes(48_653_049)).toBe('46 МБ');
    expect(fmtBytes(4_580_837)).toBe('4,4 МБ');
  });
});
