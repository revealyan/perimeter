// Общий список MCP: перенос записи между аккаунтами, метка ключа аккаунта, копии на диске.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpSharedStore, accountKeyOf, configFor, isZaiGateway, rekeyConfig, templateOf, toMcpConfig } from './mcpShared.js';
import { withAccountKey } from './mcp.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('общий список MCP', () => {
  it('запись .claude.json → конфиг: stdio без type, http/sse; WebSocket и пустое — не переносим', () => {
    expect(toMcpConfig({ command: 'npx', args: ['-y', 'x', 3], env: { A: '1', B: 2 } })).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } });
    expect(toMcpConfig({ type: 'http', url: 'https://a/mcp', headers: { H: 'v' } })).toEqual({ type: 'http', url: 'https://a/mcp', headers: { H: 'v' } });
    expect(toMcpConfig({ type: 'sse', url: 'https://a/sse' })).toEqual({ type: 'sse', url: 'https://a/sse' });
    expect(toMcpConfig({ type: 'ws', url: 'wss://a' })).toBeNull();
    expect(toMcpConfig({ type: 'stdio' })).toBeNull();
  });

  it('ключ аккаунта → метка; у другого аккаунта — его ключ, если подходит домену, иначе как сохранено', () => {
    const cfg = { type: 'http' as const, url: 'https://api.z.ai/api/mcp/zread/mcp', headers: { Authorization: 'Bearer ZAI-KEY-777' } };
    const template = templateOf(cfg, ['ZAI-KEY-777', undefined, 'short']);
    expect(template).toEqual({ ...cfg, headers: { Authorization: 'Bearer {{account-key}}' } });
    expect(templateOf(cfg, ['другой-ключ-0000'])).toBeUndefined();
    const e = { config: cfg, template: template! };
    expect(configFor(e, [{ key: 'ZAI-KEY-888', baseUrl: 'https://api.z.ai/api/anthropic' }])).toMatchObject({ headers: { Authorization: 'Bearer ZAI-KEY-888' } });
    // ключ чужого шлюза серверу z.ai не уходит — остаётся сохранённый
    expect(configFor(e, [{ key: 'OTHER-KEY-1', baseUrl: 'https://gw.example/anthropic' }])).toBe(cfg);
    expect(configFor(e, [{}])).toBe(cfg);
    expect(accountKeyOf({ ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://b' }, false)).toEqual({ key: 't', baseUrl: 'https://b' });
    expect(accountKeyOf({ CLAUDE_CODE_OAUTH_TOKEN: 'oat', ANTHROPIC_AUTH_TOKEN: 't' }, true)).toEqual({});
  });

  it('копии на диске: переживают перезапуск, файл только владельцу, битый — начинаем с пустого', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-mcpsh-'));
    dirs.push(d);
    const file = join(d, 'sub', 'mcp-shared.json');
    const a = new McpSharedStore(file);
    a.put('fs', { config: { type: 'stdio', command: 'npx', args: ['fs'] } });
    expect(new McpSharedStore(file).get('fs')).toEqual({ config: { type: 'stdio', command: 'npx', args: ['fs'] } });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    a.remove('fs');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, servers: {} });
    const broken = join(d, 'broken.json');
    writeFileSync(broken, '{ не json');
    expect(new McpSharedStore(broken).all()).toEqual({});
  });

  it('смена ключа: старый → новый только в заголовках и переменных; копии на диске обновляются, шаблон — нет', () => {
    const http = { type: 'http' as const, url: 'https://api.z.ai/api/mcp/zread/mcp', headers: { Authorization: 'Bearer ZAI-KEY-777', X: 'v' } };
    expect(rekeyConfig(http, 'ZAI-KEY-777', 'ZAI-KEY-999')).toEqual({ ...http, headers: { Authorization: 'Bearer ZAI-KEY-999', X: 'v' } });
    expect(rekeyConfig(http, 'OTHER-KEY-1', 'ZAI-KEY-999')).toBeNull();
    expect(rekeyConfig(http, 'short', 'ZAI-KEY-999')).toBeNull(); // как в templateOf: короткие не ищем
    const stdio = { type: 'stdio' as const, command: 'npx', args: ['ZAI-KEY-777'], env: { Z_AI_API_KEY: 'ZAI-KEY-777' } };
    expect(rekeyConfig(stdio, 'ZAI-KEY-777', 'ZAI-KEY-999')).toEqual({ ...stdio, env: { Z_AI_API_KEY: 'ZAI-KEY-999' } });

    const d = mkdtempSync(join(tmpdir(), 'cc-mcpsh-'));
    dirs.push(d);
    const file = join(d, 'mcp-shared.json');
    const s = new McpSharedStore(file);
    const template = { ...http, headers: { Authorization: 'Bearer {{account-key}}', X: 'v' } };
    s.put('zread', { config: http, template });
    s.put('gh', { config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer GH-1' } } });
    expect(s.rekey('ZAI-KEY-777', 'ZAI-KEY-999')).toEqual(['zread']);
    // keyHost у HTTP без него в файле — из адреса
    expect(new McpSharedStore(file).get('zread')).toEqual({ config: { ...http, headers: { Authorization: 'Bearer ZAI-KEY-999', X: 'v' } }, template, keyHost: 'api.z.ai' });
    expect(new McpSharedStore(file).get('gh')!.config).toMatchObject({ headers: { Authorization: 'Bearer GH-1' } });
    expect(s.rekey('ZAI-KEY-777', 'ZAI-KEY-999')).toEqual([]);
  });

  it('команда с меткой: ключ только аккаунту шлюза keyHost; старая копия без keyHost — z.ai узнаётся, прочее не раздаётся', () => {
    const zaiAcc = { key: 'ZAI-KEY-888', baseUrl: 'https://api.z.ai/api/anthropic' };
    const anth = { key: 'ANTH-KEY-12345678' };
    const gw = { key: 'GW-KEY-12345678', baseUrl: 'https://gw.example/anthropic' };
    const tpl = { type: 'stdio' as const, command: 'npx', args: ['-y', '@z_ai/mcp-server'], env: { Z_AI_MODE: 'ZAI', Z_AI_API_KEY: '{{account-key}}' } };
    expect(withAccountKey(tpl, zaiAcc, 'api.z.ai')).toMatchObject({ env: { Z_AI_API_KEY: 'ZAI-KEY-888' } });
    expect(() => withAccountKey(tpl, anth, 'api.z.ai')).toThrow(/шлюза нет/);
    expect(() => withAccountKey(tpl, gw, 'api.z.ai')).toThrow(/gw\.example/);
    // без keyHost — добавление одному аккаунту: его ключ (выбор владельца)
    expect(withAccountKey(tpl, anth)).toMatchObject({ env: { Z_AI_API_KEY: 'ANTH-KEY-12345678' } });

    const d = mkdtempSync(join(tmpdir(), 'cc-mcpsh-'));
    dirs.push(d);
    const file = join(d, 'mcp-shared.json');
    const saved = { ...tpl, env: { Z_AI_MODE: 'ZAI', Z_AI_API_KEY: 'ZAI-KEY-777' } };
    const other = { type: 'stdio' as const, command: 'npx', args: ['-y', 'x'], env: { T: 'ZAI-KEY-777' } };
    // файл до 2026-11-13: шаблоны без keyHost
    writeFileSync(file, JSON.stringify({ version: 1, servers: {
      'zai-mcp-server': { config: saved, template: tpl },
      x: { config: other, template: { ...other, env: { T: '{{account-key}}' } } },
      zread: { config: { type: 'http', url: 'https://api.z.ai/api/mcp/zread/mcp' }, template: { type: 'http', url: 'https://api.z.ai/api/mcp/zread/mcp', headers: { A: '{{account-key}}' } } },
    } }));
    const s = new McpSharedStore(file);
    expect(s.get('zai-mcp-server')!.keyHost).toBe('api.z.ai');
    expect(s.get('x')!.keyHost).toBeUndefined();
    expect(s.get('zread')!.keyHost).toBe('api.z.ai');
    expect(configFor(s.get('zai-mcp-server')!, [anth, gw])).toBe(s.get('zai-mcp-server')!.config);
    expect(configFor(s.get('zai-mcp-server')!, [anth, zaiAcc])).toMatchObject({ env: { Z_AI_API_KEY: 'ZAI-KEY-888' } });
    // неизвестно, чей ключ ждёт команда, — никому не подставляем, даже аккаунту z.ai
    expect(configFor(s.get('x')!, [zaiAcc, anth])).toBe(s.get('x')!.config);
    // keyHost переживает перезапись и смену ключа
    s.rekey('ZAI-KEY-777', 'ZAI-KEY-999');
    expect(new McpSharedStore(file).get('zai-mcp-server')).toMatchObject({ keyHost: 'api.z.ai', config: { env: { Z_AI_API_KEY: 'ZAI-KEY-999' } } });
  });

  it('шлюз z.ai узнаётся по адресу', () => {
    expect(isZaiGateway('https://api.z.ai/api/anthropic')).toBe(true);
    expect(isZaiGateway('https://z.ai')).toBe(true);
    expect(isZaiGateway('https://notz.ai.example.com')).toBe(false);
    expect(isZaiGateway('https://api.anthropic.com')).toBe(false);
    expect(isZaiGateway(undefined)).toBe(false);
  });
});
