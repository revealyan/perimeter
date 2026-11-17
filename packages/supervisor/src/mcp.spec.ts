// MCP-подключения из UI: разбор `claude mcp list`, сведения без секретов, проверка конфига, команды через WSS
// (запуск `claude mcp …` подменён), вход OAuth на поддельном Claude Code.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Frame } from '@perimeter/protocol';
import { globalConfigFile, mergeMcp, mcpAdd, parseMcpList, readUserMcp, validateMcp, type McpDeps } from './mcp.js';
import { loginEnv, type LoginEvent } from './accounts.js';
import { ProfileRegistry, explicitConfigDir } from './profiles.js';
import { SessionManager } from './session/manager.js';
import { WssServer } from './wss.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fake-claude.mjs');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cc-mcp-')); dirs.push(d); return d; };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const waitFor = async (pred: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('не дождались');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// так выводит `claude mcp list` Claude Code 2.1.319 (проверено на Velohost)
const LIST = `Checking MCP server health…

context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected
notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication
broken: https://down.example.com/mcp (HTTP) - ✘ Failed to connect
fs: npx -y @modelcontextprotocol/server-filesystem /tmp (stdio) - ✔ Connected
`;

describe('разбор и сведения', () => {
  it('статусы из `claude mcp list`', () => {
    const m = parseMcpList(LIST);
    expect(m.get('context7')).toEqual({ target: 'https://mcp.context7.com/mcp', transport: 'http', status: 'connected', statusText: 'Connected' });
    expect(m.get('notion')).toMatchObject({ status: 'needs-auth', statusText: 'Needs authentication' });
    expect(m.get('broken')).toMatchObject({ status: 'failed' });
    expect(m.get('fs')).toMatchObject({ transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-filesystem /tmp', status: 'connected' });
    expect(m.has('Checking MCP server health…')).toBe(false);
  });

  it('свои серверы аккаунта — с именами заголовков и переменных, без значений; чужие — scope other', () => {
    const user = {
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer SECRET-1' } },
      fs: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { TOKEN: 'SECRET-2' } },
    };
    const info = mergeMcp(parseMcpList(LIST), user);
    expect(JSON.stringify(info)).not.toMatch(/SECRET/);
    expect(info.find((s) => s.name === 'notion')).toMatchObject({ scope: 'user', headerNames: ['Authorization'], status: 'needs-auth' });
    expect(info.find((s) => s.name === 'fs')).toMatchObject({ scope: 'user', envNames: ['TOKEN'], transport: 'stdio' });
    expect(info.find((s) => s.name === 'context7')).toMatchObject({ scope: 'other' });
    expect(info.slice(0, 2).every((s) => s.scope === 'user')).toBe(true); // свои — сверху
  });

  it('проверка конфига: имя, адрес, заголовки и переменные', () => {
    expect(validateMcp('ok-name_1', { type: 'http', url: 'https://x.dev/mcp' })).toBeNull();
    expect(validateMcp('плохое имя', { type: 'http', url: 'https://x.dev/mcp' })).toMatch(/латиница/);
    expect(validateMcp('a', { type: 'http', url: 'ftp://x' })).toMatch(/http или https/);
    expect(validateMcp('a', { type: 'http', url: 'не адрес' })).toMatch(/URL/);
    expect(validateMcp('a', { type: 'http', url: 'https://x', headers: { 'Bad Header': 'v' } })).toMatch(/заголовок/);
    expect(validateMcp('a', { type: 'stdio', command: ' ' })).toMatch(/команда/);
    expect(validateMcp('a', { type: 'stdio', command: 'npx', env: { '1BAD': 'v' } })).toMatch(/переменная/);
  });

  it('добавление: add-json -s user; ошибка Claude Code — без значений секретов', async () => {
    const calls: string[][] = [];
    const d: McpDeps = { bin: ['claude'], run: async (_b, args) => { calls.push(args); return { code: 1, out: 'Error: bad header Bearer TOPSECRET-XYZ' }; } };
    await expect(mcpAdd(d, '/x', 'gh', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer TOPSECRET-XYZ' } }))
      .rejects.toThrow(/\*\*\*/);
    expect(calls[0]!.slice(0, 4)).toEqual(['mcp', 'add-json', '-s', 'user']);
    expect(JSON.parse(calls[0]![5]!)).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer TOPSECRET-XYZ' } });
  });
});

describe('папка Claude Code аккаунта по умолчанию', () => {
  it('без явной папки CLAUDE_CONFIG_DIR детям не ставится, MCP читаются из ~/.claude.json', () => {
    expect(loginEnv(undefined, { CLAUDE_CONFIG_DIR: '/x', PATH: '/bin' })).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(loginEnv('/acc/.claude', { PATH: '/bin' })['CLAUDE_CONFIG_DIR']).toBe('/acc/.claude');
    expect(globalConfigFile(undefined, '/home/yan')).toBe(join('/home/yan', '.claude.json'));
    expect(globalConfigFile('/acc/.claude')).toBe(join('/acc/.claude', '.claude.json'));
  });
  it('явная папка — у профиля, в его env или у самого supervisor’а', () => {
    const saved = process.env['CLAUDE_CONFIG_DIR'];
    delete process.env['CLAUDE_CONFIG_DIR'];
    try {
      expect(explicitConfigDir({ name: 'default' })).toBeUndefined();
      expect(explicitConfigDir({ name: 'a', configDir: '/a' })).toBe('/a');
      expect(explicitConfigDir({ name: 'b', env: { CLAUDE_CONFIG_DIR: '/b' } })).toBe('/b');
      process.env['CLAUDE_CONFIG_DIR'] = '/sup';
      expect(explicitConfigDir({ name: 'default' })).toBe('/sup');
    } finally {
      if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = saved;
    }
  });
});

describe('MCP через WSS', () => {
  async function boot() {
    const d = tmp();
    // у аккаунта supervisor'а (default) — своя папка на каждый запуск: общий список пишет и в неё
    const savedCfg = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = join(d, 'base');
    cleanups.push(() => { if (savedCfg === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = savedCfg; });
    // аккаунт supervisor'а наследует окружение процесса: ключи машины, где идут тесты, сюда попадать не должны
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      const v = process.env[k];
      if (v === undefined) continue;
      delete process.env[k];
      cleanups.push(() => { process.env[k] = v; });
    }
    const profiles = ProfileRegistry.load(join(d, 'profiles.json'));
    const cfgDir = join(d, 'cfg');
    profiles.create({ name: 'main', configDir: cfgDir });
    profiles.create({ name: 'glm', configDir: join(d, 'glm'), env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'ZAI-KEY-777' } });
    let authed = false;
    // поддельный `claude mcp …`: add-json/remove правят .claude.json папки, list — статусы
    const mcpRun: McpDeps['run'] = async (_bin, args, dir) => {
      mkdirSync(dir!, { recursive: true }); // настоящий Claude Code создаёт папку сам
      const file = join(dir!, '.claude.json');
      const cur = (() => { try { return JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }; } catch { return {}; } })();
      cur.mcpServers ??= {};
      if (args[1] === 'add-json') {
        // как настоящий Claude Code: поверх существующего не пишет
        if (cur.mcpServers[args[4]!]) return { code: 1, out: `MCP server ${args[4]} already exists in user config` };
        cur.mcpServers[args[4]!] = JSON.parse(args[5]!); writeFileSync(file, JSON.stringify(cur)); return { code: 0, out: 'Added' };
      }
      if (args[1] === 'remove') { delete cur.mcpServers[args[4]!]; writeFileSync(file, JSON.stringify(cur)); return { code: 0, out: 'Removed' }; }
      const lines = Object.entries(cur.mcpServers).map(([n, c]) => `${n}: ${(c as { url?: string }).url ?? 'cmd'} (HTTP) - ${n === 'notion' && !authed ? '! Needs authentication' : '✔ Connected'}`);
      return { code: 0, out: lines.join('\n') };
    };
    const server = new WssServer(new SessionManager(0), {
      port: 0, profiles, sessionFactory: () => { throw new Error('не нужно'); },
      accounts: {
        root: join(d, 'accounts'), mcpRun,
        mcpCatalog: {
          has: () => true,
          fetch: async () => ({ ok: true, status: 200, json: async () => ({ servers: [{ server: { name: 'com.notion/mcp', description: 'Official Notion MCP server', remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }] } }] }) }),
        },
        login: { bin: [process.execPath, FAKE], backend: 'pipe', openTab: async () => ({ rbId: 'rb1' }), closeTab: async () => undefined },
      },
    });
    const port = await server.start();
    cleanups.push(() => server.stop());
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
    cleanups.push(() => ws.close());
    const frames: Frame[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame));
    let n = 0;
    const call = async (f: Record<string, unknown>) => {
      const id = `c${++n}`;
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), id, ...f }));
      await waitFor(() => frames.some((x) => 'id' in x && x.id === id && 'ok' in x));
      return frames.find((x) => 'id' in x && x.id === id && 'ok' in x) as unknown as { ok: boolean; data?: Record<string, unknown>; code?: string; message?: string };
    };
    await call({ type: 'cmd:hello', lastSeq: {} });
    return { call, frames, cfgDir, dir: d, profiles, setAuthed: () => { authed = true; } };
  }

  it('добавить → в списке без секретов; удалить; плохое имя и неизвестный аккаунт — ошибки', async () => {
    const b = await boot();
    const r = await b.call({ type: 'cmd:mcp.add', profile: 'main', name: 'gh', config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer GH-SECRET-1' } } });
    expect(r.ok).toBe(true);
    expect(r.data!['servers']).toEqual([{ name: 'gh', transport: 'http', target: 'https://api.githubcopilot.com/mcp/', status: 'connected', statusText: 'Connected', scope: 'user', headerNames: ['Authorization'] }]);
    expect(JSON.stringify(b.frames)).not.toContain('GH-SECRET-1');
    expect(readUserMcp(b.cfgDir)['gh']).toMatchObject({ headers: { Authorization: 'Bearer GH-SECRET-1' } });
    expect(((await b.call({ type: 'cmd:mcp.remove', profile: 'main', name: 'gh' })).data!['servers'] as unknown[]).length).toBe(0);
    expect((await b.call({ type: 'cmd:mcp.add', profile: 'main', name: 'плохое', config: { type: 'http', url: 'https://x' } })).ok).toBe(false);
    expect((await b.call({ type: 'cmd:mcp.list', profile: 'nope' })).code).toBe('UNKNOWN_PROFILE');
  });

  it('общий список: строки по именам у всех аккаунтов; включить — копия (ключ аккаунта свой, если подходит); выключить; удалить у всех', async () => {
    const b = await boot();
    b.profiles.create({ name: 'glm2', configDir: join(b.dir, 'glm2'), env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'ZAI-KEY-888' } });
    expect((await b.call({ type: 'cmd:mcp.add', profile: 'main', name: 'gh', config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer GH-SECRET-1' } } })).ok).toBe(true);
    expect((await b.call({ type: 'cmd:mcp.add', profile: 'glm', name: 'web-search', config: { type: 'http', url: 'https://api.z.ai/api/mcp/web_search_prime/mcp', headers: { Authorization: 'Bearer {{account-key}}' } } })).ok).toBe(true);

    const list = await b.call({ type: 'cmd:mcp.shared', check: true });
    expect(list.ok).toBe(true);
    const targets = (list.data!['targets'] as Array<{ id: string }>).map((t) => t.id);
    expect(targets).toEqual(expect.arrayContaining(['main', 'glm', 'glm2']));
    const rows = list.data!['servers'] as Array<{ name: string; on: Record<string, { status: string }>; stored: boolean }>;
    expect(rows.find((r) => r.name === 'gh')).toMatchObject({ stored: false, on: { main: { status: 'connected' } } });
    expect(Object.keys(rows.find((r) => r.name === 'web-search')!.on)).toEqual(['glm']);

    // включить у других: GitHub — как есть; z.ai — у glm2 его собственный ключ, у main (ключа нет) — тот, с которым добавили
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'glm', name: 'gh', on: true })).ok).toBe(true);
    expect(readUserMcp(join(b.dir, 'glm'))['gh']).toMatchObject({ headers: { Authorization: 'Bearer GH-SECRET-1' } });
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'glm2', name: 'web-search', on: true })).ok).toBe(true);
    expect(readUserMcp(join(b.dir, 'glm2'))['web-search']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-888' } });
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'main', name: 'web-search', on: true })).ok).toBe(true);
    expect(readUserMcp(b.cfgDir)['web-search']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });
    const after = await b.call({ type: 'cmd:mcp.shared' });
    expect((after.data!['servers'] as Array<{ name: string; accountKey: boolean }>).find((r) => r.name === 'web-search')).toMatchObject({ accountKey: true });

    // выключить у main: строка остаётся (копия хранится), у glm включён
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'main', name: 'gh', on: false })).ok).toBe(true);
    expect(readUserMcp(b.cfgDir)['gh']).toBeUndefined();
    const off = await b.call({ type: 'cmd:mcp.shared' });
    expect((off.data!['servers'] as Array<{ name: string; on: Record<string, unknown> }>).find((r) => r.name === 'gh')!.on).toEqual({ glm: { status: 'unknown', statusText: 'не проверялся' } });
    // включить обратно — из копии
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'main', name: 'gh', on: true })).ok).toBe(true);
    expect(readUserMcp(b.cfgDir)['gh']).toMatchObject({ headers: { Authorization: 'Bearer GH-SECRET-1' } });

    // удалить у всех
    const rm = await b.call({ type: 'cmd:mcp.shared.remove', name: 'gh' });
    expect(rm.data!['results']).toEqual(expect.arrayContaining([{ profile: 'main', ok: true }, { profile: 'glm', ok: true }]));
    expect(readUserMcp(join(b.dir, 'glm'))['gh']).toBeUndefined();
    expect(((await b.call({ type: 'cmd:mcp.shared' })).data!['servers'] as Array<{ name: string }>).map((r) => r.name)).not.toContain('gh');
    // секреты клиенту не уходят
    const wire = JSON.stringify(b.frames);
    for (const secret of ['GH-SECRET-1', 'ZAI-KEY-777', 'ZAI-KEY-888']) expect(wire).not.toContain(secret);
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'nope', name: 'gh', on: true })).code).toBe('UNKNOWN_PROFILE');
  });

  it('добавить всем: метка ключа — у каждого свой; новый аккаунт сам получает общие серверы', async () => {
    const b = await boot();
    const r = await b.call({ type: 'cmd:mcp.shared.add', name: 'zread', config: { type: 'http', url: 'https://api.z.ai/api/mcp/zread/mcp', headers: { Authorization: 'Bearer {{account-key}}' } } });
    expect(r.ok).toBe(true);
    expect(r.data!['results']).toEqual(expect.arrayContaining([{ profile: 'main', ok: true }, { profile: 'glm', ok: true }]));
    expect(readUserMcp(join(b.dir, 'glm'))['zread']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });
    expect(readUserMcp(b.cfgDir)['zread']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });
    // ключ аккаунта чужому домену — отказ, как и раньше
    expect((await b.call({ type: 'cmd:mcp.shared.add', name: 'evil', config: { type: 'http', url: 'https://evil.example/mcp', headers: { A: '{{account-key}}' } } })).ok).toBe(false);

    const add = await b.call({ type: 'cmd:profile.add', name: 'claude', template: 'claude-token', apiKey: 'sk-ant-oat-good-1234WXYZ' });
    expect(add.ok).toBe(true);
    const dir = explicitConfigDir(b.profiles.get('claude')!);
    await waitFor(() => readUserMcp(dir)['zread'] !== undefined);
    expect(readUserMcp(dir)['zread']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });
  });

  it('набор z.ai: виден, пока не стоит; ставится всем одной командой (у z.ai — свой ключ); новый аккаунт z.ai ставит его сам', async () => {
    const b = await boot();
    const before = await b.call({ type: 'cmd:mcp.shared' });
    expect(before.data!['presets']).toEqual([{ id: 'zai', missing: ['web-search-prime', 'web-reader', 'zread', 'zai-mcp-server'] }]);
    const r = await b.call({ type: 'cmd:mcp.preset', preset: 'zai' });
    expect(r.data!['added']).toEqual(['web-search-prime', 'web-reader', 'zread', 'zai-mcp-server']);
    expect(readUserMcp(join(b.dir, 'glm'))['web-search-prime']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });
    expect(readUserMcp(join(b.dir, 'glm'))['zai-mcp-server']).toMatchObject({ command: 'npx', args: ['-y', '@z_ai/mcp-server'], env: { Z_AI_MODE: 'ZAI', Z_AI_API_KEY: 'ZAI-KEY-777' } });
    // у аккаунта без ключа z.ai — ключ, с которым набор поставили
    expect(readUserMcp(b.cfgDir)['zread']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });
    expect((await b.call({ type: 'cmd:mcp.shared' })).data!['presets']).toBeUndefined();
    expect(JSON.stringify(b.frames)).not.toContain('ZAI-KEY-777');

    // новый аккаунт z.ai со своей папкой: получает общие серверы, у z.ai-набора — его собственный ключ
    b.profiles.create({ name: 'glm3', configDir: join(b.dir, 'glm3'), env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'ZAI-KEY-333' } });
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'glm3', name: 'zread', on: true })).ok).toBe(true);
    expect(readUserMcp(join(b.dir, 'glm3'))['zread']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-333' } });
  });

  it('смена ключа z.ai: его старый ключ в MCP других аккаунтов и в копии общего списка — заменён новым', async () => {
    const b = await boot();
    b.profiles.create({ name: 'glm2', configDir: join(b.dir, 'glm2'), env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'ZAI-KEY-888' } });
    // тот же ключ, что у glm, но это его собственный — при смене ключа у glm не трогается
    b.profiles.create({ name: 'twin', configDir: join(b.dir, 'twin'), env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'ZAI-KEY-777' } });
    expect((await b.call({ type: 'cmd:mcp.preset', preset: 'zai' })).data!['added']).toHaveLength(4);
    expect((await b.call({ type: 'cmd:mcp.add', profile: 'main', name: 'gh', config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer GH-SECRET-1' } } })).ok).toBe(true);
    // до смены: у main (ключа нет) — ключ glm, с которым ставили набор
    expect(readUserMcp(b.cfgDir)['zread']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    cleanups.push(() => spy.mockRestore());
    const r = await b.call({ type: 'cmd:profile.update', profile: 'glm', apiKey: 'ZAI-KEY-NEW-999' });
    expect(r.ok).toBe(true);
    const zaiKeys = (dir: string) => {
      const u = readUserMcp(dir) as Record<string, { headers?: Record<string, string>; env?: Record<string, string> }>;
      return [u['web-search-prime']?.headers?.['Authorization'], u['web-reader']?.headers?.['Authorization'], u['zread']?.headers?.['Authorization'], u['zai-mcp-server']?.env?.['Z_AI_API_KEY']];
    };
    const fresh = ['Bearer ZAI-KEY-NEW-999', 'Bearer ZAI-KEY-NEW-999', 'Bearer ZAI-KEY-NEW-999', 'ZAI-KEY-NEW-999'];
    // фон прошёл по всем аккаунтам — его последняя строка в журнале
    await waitFor(() => logs.some((l) => l.includes('новый ключ — в MCP аккаунтов')));
    const done = logs.find((l) => l.includes('новый ключ — в MCP аккаунтов'))!;
    expect(done).toContain('main/zread');
    expect(done).toContain('glm/zai-mcp-server');
    expect(done).not.toMatch(/glm2\/|twin\//);
    for (const d of [b.cfgDir, join(b.dir, 'glm')]) expect(zaiKeys(d)).toEqual(fresh);
    // остальное у сервера то же
    expect(readUserMcp(b.cfgDir)['zai-mcp-server']).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@z_ai/mcp-server'], env: { Z_AI_MODE: 'ZAI', Z_AI_API_KEY: 'ZAI-KEY-NEW-999' } });
    expect(readUserMcp(b.cfgDir)['web-reader']).toEqual({ type: 'http', url: 'https://api.z.ai/api/mcp/web_reader/mcp', headers: { Authorization: 'Bearer ZAI-KEY-NEW-999' } });
    // свои ключи других аккаунтов z.ai и чужие серверы — как были
    expect(zaiKeys(join(b.dir, 'glm2'))).toEqual(['Bearer ZAI-KEY-888', 'Bearer ZAI-KEY-888', 'Bearer ZAI-KEY-888', 'ZAI-KEY-888']);
    expect(zaiKeys(join(b.dir, 'twin'))).toEqual(['Bearer ZAI-KEY-777', 'Bearer ZAI-KEY-777', 'Bearer ZAI-KEY-777', 'ZAI-KEY-777']);
    expect(readUserMcp(b.cfgDir)['gh']).toMatchObject({ headers: { Authorization: 'Bearer GH-SECRET-1' } });
    for (const d of [b.cfgDir, join(b.dir, 'glm')]) expect(JSON.stringify(readUserMcp(d))).not.toContain('ZAI-KEY-777');

    // копия общего списка: включить заново у аккаунта без ключа z.ai — уже с новым ключом; у glm2 — по-прежнему свой
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'main', name: 'web-reader', on: false })).ok).toBe(true);
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'main', name: 'web-reader', on: true })).ok).toBe(true);
    expect(readUserMcp(b.cfgDir)['web-reader']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-NEW-999' } });
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'glm2', name: 'zread', on: false })).ok).toBe(true);
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'glm2', name: 'zread', on: true })).ok).toBe(true);
    expect(readUserMcp(join(b.dir, 'glm2'))['zread']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-888' } });

    // ключи не уходят ни клиенту, ни в журнал — ни старый, ни новый
    const wire = JSON.stringify(b.frames) + logs.join(' ');
    for (const secret of ['ZAI-KEY-777', 'ZAI-KEY-NEW-999', 'ZAI-KEY-888']) expect(wire).not.toContain(secret);
  });

  it('ключ не z.ai-аккаунта в zai-mcp-server не уходит: у него — сохранённый ключ z.ai', async () => {
    const b = await boot();
    // ключ Anthropic API без шлюза и ключ другого шлюза
    b.profiles.create({ name: 'anth', configDir: join(b.dir, 'anth'), env: { ANTHROPIC_API_KEY: 'ANTH-KEY-12345678' } });
    b.profiles.create({ name: 'gw', configDir: join(b.dir, 'gw'), env: { ANTHROPIC_BASE_URL: 'https://gw.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'GW-KEY-12345678' } });
    b.profiles.create({ name: 'glm2', configDir: join(b.dir, 'glm2'), env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'ZAI-KEY-888' } });
    expect((await b.call({ type: 'cmd:mcp.preset', preset: 'zai' })).data!['added']).toHaveLength(4);
    const zaiEnv = (acc: string) => (readUserMcp(join(b.dir, acc))['zai-mcp-server'] as { env?: Record<string, string> } | undefined)?.env?.['Z_AI_API_KEY'];
    expect(zaiEnv('anth')).toBe('ZAI-KEY-777');
    expect(zaiEnv('gw')).toBe('ZAI-KEY-777');
    expect(zaiEnv('glm2')).toBe('ZAI-KEY-888');
    expect(readUserMcp(join(b.dir, 'gw'))['zread']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });
    // включить заново — из копии, то же самое
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'anth', name: 'zai-mcp-server', on: false })).ok).toBe(true);
    expect((await b.call({ type: 'cmd:mcp.toggle', profile: 'anth', name: 'zai-mcp-server', on: true })).ok).toBe(true);
    expect(zaiEnv('anth')).toBe('ZAI-KEY-777');

    // команда с меткой, добавленная одному аккаунту z.ai: копия помнит его шлюз — другим аккаунтам не их ключ
    const cmd = { type: 'stdio', command: 'npx', args: ['-y', 'some-zai-tool'], env: { TOKEN: '{{account-key}}' } };
    expect((await b.call({ type: 'cmd:mcp.add', profile: 'glm', name: 'zai-tool', config: cmd })).ok).toBe(true);
    for (const acc of ['anth', 'gw', 'glm2']) expect((await b.call({ type: 'cmd:mcp.toggle', profile: acc, name: 'zai-tool', on: true })).ok).toBe(true);
    const tok = (acc: string) => (readUserMcp(join(b.dir, acc))['zai-tool'] as { env?: Record<string, string> }).env?.['TOKEN'];
    expect([tok('anth'), tok('gw'), tok('glm2')]).toEqual(['ZAI-KEY-777', 'ZAI-KEY-777', 'ZAI-KEY-888']);

    // «добавить всем» команду с меткой: ключ — шлюза первого аккаунта-шлюза (glm), не Anthropic и не gw
    expect((await b.call({ type: 'cmd:mcp.shared.add', name: 'zai-tool2', config: { ...cmd, args: ['-y', 'other-zai-tool'] } })).ok).toBe(true);
    const tok2 = (acc: string) => (readUserMcp(join(b.dir, acc))['zai-tool2'] as { env?: Record<string, string> }).env?.['TOKEN'];
    expect([tok2('anth'), tok2('gw'), tok2('glm'), tok2('glm2')]).toEqual(['ZAI-KEY-777', 'ZAI-KEY-777', 'ZAI-KEY-777', 'ZAI-KEY-888']);
    expect(readUserMcp(b.cfgDir)['zai-tool2']).toMatchObject({ env: { TOKEN: 'ZAI-KEY-777' } });

    for (const acc of ['anth', 'gw']) {
      const all = JSON.stringify(readUserMcp(join(b.dir, acc)));
      expect(all).not.toContain('ANTH-KEY-12345678');
      expect(all).not.toContain('GW-KEY-12345678');
    }
  });

  it('новый аккаунт z.ai по шаблону — набор z.ai ставится сам', async () => {
    const b = await boot();
    const add = await b.call({ type: 'cmd:profile.add', name: 'zai', template: 'zai', apiKey: 'ZAI-KEY-NEW-555' });
    expect(add.ok).toBe(true);
    const dir = explicitConfigDir(b.profiles.get('zai')!);
    await waitFor(() => readUserMcp(dir)['zai-mcp-server'] !== undefined);
    expect(readUserMcp(dir)['web-reader']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-NEW-555' } });
  });

  it('каталог: поиск через WSS', async () => {
    const b = await boot();
    const r = await b.call({ type: 'cmd:mcp.catalog.search', query: 'notion' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ skipped: 0, entries: [{ id: 'com.notion/mcp', suggestedName: 'notion', publisher: 'notion.com' }] });
  });

  it('ключ аккаунта: сервер подставляет сам, клиенту не возвращается; чужой домен — отказ', async () => {
    const b = await boot();
    const r = await b.call({ type: 'cmd:mcp.add', profile: 'glm', name: 'web-search', config: { type: 'http', url: 'https://api.z.ai/api/mcp/web_search_prime/mcp', headers: { Authorization: 'Bearer {{account-key}}' } } });
    expect(r.ok).toBe(true);
    expect(readUserMcp(join(b.dir, 'glm'))['web-search']).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-777' } });
    expect(JSON.stringify(b.frames)).not.toContain('ZAI-KEY-777');
    const bad = await b.call({ type: 'cmd:mcp.add', profile: 'glm', name: 'evil', config: { type: 'http', url: 'https://evil.example/mcp', headers: { A: '{{account-key}}' } } });
    expect(bad).toMatchObject({ ok: false, code: 'MCP_FAILED' });
    expect(bad.message).toMatch(/api\.z\.ai/);
  });

  it('вход OAuth: ссылка → вкладка; адрес возврата руками → вход проверен по списку → done', async () => {
    const b = await boot();
    await b.call({ type: 'cmd:mcp.add', profile: 'main', name: 'notion', config: { type: 'http', url: 'https://mcp.notion.com/mcp' } });
    const r = await b.call({ type: 'cmd:mcp.login.start', profile: 'main', name: 'notion', width: 1000, height: 700 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ rbId: 'rb1' });
    expect(String(r.data!['url'])).toMatch(/^https:\/\/mcp\.example\.com\/authorize/);
    const loginId = r.data!['loginId'] as string;
    b.setAuthed();
    expect((await b.call({ type: 'cmd:profile.login.code', loginId, code: 'http://localhost:5555/callback?code=good&state=m1' })).ok).toBe(true);
    const ev = () => b.frames.filter((f) => 'type' in f && f.type === 'event:profile.login') as unknown as LoginEvent[];
    await waitFor(() => ev().some((e) => e.state === 'done'));
    expect(ev().at(-1)).toMatchObject({ state: 'done', profile: 'main' });
  });
});
