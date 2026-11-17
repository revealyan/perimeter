// Каталог MCP: разбор настоящих записей реестра (снимок 2026-11-12) и порядок выдачи.
import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import { clearCatalogCache, hasCommand, scoreEntry, searchCatalog, suggestName, toEntry, variantsOf, type RegItem } from './mcpCatalog.js';
import { withAccountKey } from './mcp.js';

const sample = JSON.parse(readFileSync(new URL('./mcpCatalog.fixture.json', import.meta.url), 'utf8')) as { servers: RegItem[] };
const byId = (id: string) => sample.servers.find((s) => s.server?.name === id)!;

describe('разбор записи реестра', () => {
  it('Context7: удалённый с необязательным ключом + npm; mcpb пропускается', () => {
    const e = toEntry(byId('io.github.upstash/context7'))!;
    expect(e.publisher).toBe('github.com/upstash');
    expect(e.suggestedName).toBe('context7');
    expect(e.variants.map((v) => v.kind)).toEqual(['remote', 'npm']);
    const [remote, npm] = e.variants;
    expect(remote!.template).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp', headers: [{ name: 'Authorization', value: '{{Authorization}}' }] });
    expect(remote!.fields).toMatchObject([{ key: 'Authorization', required: false, secret: true }]);
    expect(npm!.template).toMatchObject({ type: 'stdio', command: 'npx', args: [{ tokens: ['-y'] }, { tokens: ['@upstash/context7-mcp@4.7.0'] }], env: [{ name: 'CONTEXT7_API_KEY', value: '{{CONTEXT7_API_KEY}}' }] });
    expect(npm!.runtime).toBe('npx');
  });

  it('Notion: два удалённых (HTTP и SSE), имя — от домена', () => {
    const e = toEntry(byId('com.notion/mcp'))!;
    expect(e.publisher).toBe('notion.com');
    expect(e.suggestedName).toBe('notion');
    expect(e.variants.map((v) => v.label)).toEqual(['HTTP · mcp.notion.com', 'SSE · mcp.notion.com']);
    expect(e.variants.every((v) => v.fields.length === 0)).toBe(true);
  });

  it('GitHub: Docker-вариант — docker run -i --rm, аргументы запуска, образ с тегом как есть', () => {
    const e = toEntry(byId('io.github.github/github-mcp-server'))!;
    expect(e.suggestedName).toBe('github');
    const oci = e.variants.find((v) => v.kind === 'oci')!;
    const flat = oci.template.args!.flatMap((a) => a.tokens);
    expect(flat.slice(0, 3)).toEqual(['run', '-i', '--rm']);
    expect(flat).toContain('ghcr.io/github/github-mcp-server:2.1.0');
    expect(flat).not.toContain('ghcr.io/github/github-mcp-server:2.1.0:2.1.0');
    expect(oci.template.command).toBe('docker');
  });

  it('обёртка Smithery: шаблон «Bearer {smithery_api_key}» → поле с ключом', () => {
    const e = toEntry(byId('ai.smithery/renCosta2025-context7fork'))!;
    expect(e.variants[0]!.template.headers).toEqual([{ name: 'Authorization', value: 'Bearer {{smithery_api_key}}' }]);
    expect(e.variants[0]!.fields.map((f) => f.key)).toEqual(['smithery_api_key']);
  });

  it('PyPI → uvx пакет==версия; нет команды на сервере — вариант с причиной', () => {
    const v = variantsOf(byId('com.mcparmory/notion').server!, (c) => c !== 'uvx');
    const py = v.find((x) => x.kind === 'pypi')!;
    expect(py.template).toMatchObject({ command: 'uvx', args: [{ tokens: ['mcparmory-notion==1.0.2'] }] });
    expect(py.missing).toMatch(/uvx/);
    expect(v.find((x) => x.kind === 'oci')!.missing).toBeUndefined();
  });

  it('обязательные и необязательные переменные, аргументы с подсказкой', () => {
    const v = variantsOf({
      name: 'x/y',
      packages: [{
        registryType: 'npm', identifier: 'pkg', version: '1.0.0', transport: { type: 'stdio' },
        packageArguments: [
          { type: 'positional', valueHint: 'root_dir', isRequired: true },
          { type: 'named', name: '--port', valueHint: 'port' },
          { type: 'named', name: '--read-only' },
          { type: 'named', name: '--mode', value: 'fast' },
        ],
        environmentVariables: [{ name: 'TOKEN', isRequired: true, isSecret: true }, { name: 'REGION', default: 'eu' }],
      }],
    });
    const t = v[0]!.template;
    expect(t.args).toEqual([
      { tokens: ['-y'] }, { tokens: ['pkg@1.0.0'] },
      { tokens: ['{{root_dir}}'] }, { tokens: ['--port', '{{port}}'], field: 'port' }, { tokens: ['--mode', 'fast'] },
    ]);
    expect(v[0]!.fields).toMatchObject([
      { key: 'TOKEN', required: true, secret: true }, { key: 'REGION', required: false, default: 'eu' },
      { key: 'root_dir', required: true }, { key: 'port', required: false },
    ]);
  });

  it('неподдержанное (mcpb, nuget, пакет с HTTP) — записи нет', () => {
    expect(toEntry({ server: { name: 'a/b', packages: [{ registryType: 'mcpb', identifier: 'https://x/y.mcpb' }, { registryType: 'nuget', identifier: 'X' }] } })).toBeNull();
    expect(toEntry({ server: { name: 'a/b', packages: [{ registryType: 'npm', identifier: 'p', transport: { type: 'streamable-http' } }] } })).toBeNull();
    expect(toEntry({ server: { name: 'a/b', remotes: [{ type: 'streamable-http', url: 'https://x' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } })).toBeNull();
  });

  it('имена для Claude Code', () => {
    expect(suggestName('io.github.github/github-mcp-server')).toBe('github');
    expect(suggestName('com.figma.mcp/mcp')).toBe('figma');
    expect(suggestName('io.github.awkoy/notion-mcp-server')).toBe('notion');
    expect(suggestName('ai.b77/time')).toBe('time');
  });
});

describe('порядок выдачи', () => {
  const entries = sample.servers.map((s) => toEntry(s)!).filter(Boolean);
  const rank = (q: string) => entries.map((e) => ({ id: e.id, s: scoreEntry(e, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.id);

  it('сервис сам — первым, копии и обёртки — ниже', () => {
    expect(rank('context7')[0]).toBe('io.github.upstash/context7');
    expect(rank('context7').at(-1)).toBe('ai.smithery/renCosta2025-context7fork');
    expect(rank('notion')[0]).toBe('com.notion/mcp');
    expect(rank('figma')[0]).toBe('com.figma.mcp/mcp');
    expect(rank('github')[0]).toBe('io.github.github/github-mcp-server');
  });

  it('«github» не совпадает с каждым io.github.*', () => {
    expect(rank('github')).toEqual(['io.github.github/github-mcp-server']);
  });

  it('несколько слов — каждое должно совпасть', () => {
    expect(rank('notion api')).not.toContain('io.github.upstash/context7');
    expect(rank('context7 docs')[0]).toBe('io.github.upstash/context7');
    expect(rank('context7 documentation')).toEqual(['ai.smithery/renCosta2025-context7fork']); // слово есть только в описании копии
  });
});

describe('searchCatalog', () => {
  beforeEach(() => clearCatalogCache());
  const fakeFetch = (calls: string[]) => async (url: string) => {
    calls.push(url);
    const q = decodeURIComponent(/search=([^&]*)/.exec(url)![1]!).toLowerCase();
    const servers = sample.servers.filter((s) => s.server!.name!.toLowerCase().includes(q));
    return { ok: true, status: 200, json: async () => ({ servers }) };
  };

  it('два запроса (слово и «слово/»), свой порядок, кэш', async () => {
    const calls: string[] = [];
    const d = { fetch: fakeFetch(calls), has: () => true };
    const r = await searchCatalog('Notion', d);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('search=notion&limit=100&version=latest');
    expect(calls[1]).toContain('search=notion%2F');
    expect(r.entries[0]!.id).toBe('com.notion/mcp');
    await searchCatalog('notion ', d);
    expect(calls).toHaveLength(2); // из кэша
  });

  it('короткий запрос — пусто без сети; ошибка каталога — исключение', async () => {
    const calls: string[] = [];
    expect((await searchCatalog('n', { fetch: fakeFetch(calls) })).entries).toEqual([]);
    expect(calls).toHaveLength(0);
    await expect(searchCatalog('figma', { fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) })).rejects.toThrow(/503/);
  });

  it('нашлось, но ставить нечем — считается в skipped', async () => {
    const only = { servers: [{ server: { name: 'io.github.x/notion-bundle', packages: [{ registryType: 'mcpb', identifier: 'https://x/n.mcpb' }] } }] };
    const r = await searchCatalog('notion', { fetch: async () => ({ ok: true, status: 200, json: async () => only }) });
    expect(r).toEqual({ entries: [], skipped: 1 });
  });
});

describe('hasCommand', () => {
  it('Windows — с .cmd, POSIX — как есть', () => {
    expect(hasCommand('npx', { Path: 'C:\\node' }, (p) => p === 'C:\\node\\npx.cmd', 'win32')).toBe(true);
    expect(hasCommand('uvx', { PATH: '/usr/bin' }, (p) => p === '/usr/local/bin/uvx', 'linux')).toBe(true);
    expect(hasCommand('docker', { PATH: '/usr/bin' }, () => false, 'linux')).toBe(false);
  });
});

describe('ключ аккаунта в конфиге MCP', () => {
  const zai = { key: 'zk-secret-123', baseUrl: 'https://api.z.ai/api/anthropic' };
  it('подставляется серверам домена шлюза', () => {
    const cfg = withAccountKey({ type: 'http', url: 'https://api.z.ai/api/mcp/web_search_prime/mcp', headers: { Authorization: 'Bearer {{account-key}}' } }, zai);
    expect(cfg).toEqual({ type: 'http', url: 'https://api.z.ai/api/mcp/web_search_prime/mcp', headers: { Authorization: 'Bearer zk-secret-123' } });
  });
  it('чужому домену — отказ; без шлюза — отказ; без метки — как есть', () => {
    expect(() => withAccountKey({ type: 'http', url: 'https://evil.example/mcp', headers: { A: '{{account-key}}' } }, zai)).toThrow(/шлюза/);
    expect(() => withAccountKey({ type: 'http', url: 'https://api.z.ai/mcp', headers: { A: '{{account-key}}' } }, { key: 'k' })).toThrow(/шлюза нет/);
    const plain = { type: 'http' as const, url: 'https://x.y/mcp', headers: { A: 'b' } };
    expect(withAccountKey(plain, {})).toBe(plain);
  });
  it('stdio — в переменные; в аргументы и адрес — нельзя; без ключа — отказ', () => {
    expect(withAccountKey({ type: 'stdio', command: 'npx', env: { Z_AI_API_KEY: '{{account-key}}' } }, zai)).toMatchObject({ env: { Z_AI_API_KEY: 'zk-secret-123' } });
    expect(() => withAccountKey({ type: 'stdio', command: 'npx', args: ['--key', '{{account-key}}'] }, zai)).toThrow(/заголовки и переменные/);
    expect(() => withAccountKey({ type: 'stdio', command: 'npx', env: { K: '{{account-key}}' } }, {})).toThrow(/нет ключа/);
  });
});
