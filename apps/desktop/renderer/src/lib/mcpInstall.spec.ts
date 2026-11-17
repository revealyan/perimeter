// Установка MCP: разбор вставок из документации и заполнение шаблонов каталога.
import { describe, expect, it } from 'vitest';
import type { McpField, McpTemplate } from '../supervisor';
import {
  ACCOUNT_KEY, accountKeyFits, draftToConfig, draftWarnings, emptyDraft, fillTemplate, freeName, looksPlaceholder, nameFromPackage, nameFromUrl,
  parseMcpPaste, previewTemplate, splitArgs, joinArgs, withAccountKeyMark,
} from './mcpInstall';

describe('вставка: JSON', () => {
  it('документация z.ai: mcpServers с заглушкой ключа', () => {
    const r = parseMcpPaste(`{
      "mcpServers": {
        "web-search-prime": {
          "type": "http",
          "url": "https://api.z.ai/api/mcp/web_search_prime/mcp",
          "headers": { "Authorization": "Bearer your_api_key" }
        }
      }
    }`);
    expect(r.error).toBeUndefined();
    expect(r.servers).toEqual([{ ...emptyDraft('http'), name: 'web-search-prime', url: 'https://api.z.ai/api/mcp/web_search_prime/mcp', headers: [{ name: 'Authorization', value: 'Bearer your_api_key' }] }]);
    expect(draftWarnings(r.servers[0]!)).toHaveLength(1);
  });

  it('VS Code: servers, комментарии, висячие запятые, // внутри адреса не трогаем', () => {
    const r = parseMcpPaste(`{
      // мой сервер
      "servers": {
        "notion": { "type": "http", "url": "https://mcp.notion.com/mcp", }, /* ещё */
        "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/yan"], "env": { "DEBUG": "1" } },
      },
    }`);
    expect(r.error).toBeUndefined();
    expect(r.servers.map((d) => [d.name, d.type, d.url || d.command, d.args])).toEqual([
      ['notion', 'http', 'https://mcp.notion.com/mcp', ''],
      ['fs', 'stdio', 'npx', '-y @modelcontextprotocol/server-filesystem /home/yan'],
    ]);
    expect(r.servers[1]!.env).toEqual([{ name: 'DEBUG', value: '1' }]);
  });

  it('кусок «"имя": {…}» без скобок; один конфиг без имени; SSE по адресу', () => {
    expect(parseMcpPaste(`"zai-mcp-server": { "command": "npx", "args": ["-y", "@z_ai/mcp-server"], "env": { "Z_AI_API_KEY": "your_api_key", "Z_AI_MODE": "ZAI" } }`).servers[0])
      .toMatchObject({ name: 'zai-mcp-server', type: 'stdio', command: 'npx', args: '-y @z_ai/mcp-server' });
    expect(parseMcpPaste('{ "url": "https://mcp.example.com/sse" }').servers[0]).toMatchObject({ type: 'sse', name: 'example' });
    expect(parseMcpPaste('{ "serverUrl": "https://mcp.linear.app/mcp" }').servers[0]).toMatchObject({ type: 'http', url: 'https://mcp.linear.app/mcp', name: 'linear' });
  });

  it('Windows-обёртка cmd /c снимается с заметкой', () => {
    const r = parseMcpPaste('{"mcpServers":{"ctx":{"command":"cmd","args":["/c","npx","-y","@upstash/context7-mcp"]}}}');
    expect(r.servers[0]).toMatchObject({ command: 'npx', args: '-y @upstash/context7-mcp' });
    expect(r.notes[0]).toMatch(/cmd \/c/);
  });

  it('битый JSON и JSON без серверов — понятная ошибка', () => {
    expect(parseMcpPaste('{"mcpServers": {').error).toMatch(/JSON не разобрался/);
    expect(parseMcpPaste('{"foo": 1}').error).toMatch(/нет MCP-серверов/);
  });
});

describe('вставка: команды claude mcp', () => {
  it('HTTP с заголовком (документация Context7)', () => {
    const r = parseMcpPaste('claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: YOUR_API_KEY"');
    expect(r.servers[0]).toMatchObject({ name: 'context7', type: 'http', url: 'https://mcp.context7.com/mcp', headers: [{ name: 'CONTEXT7_API_KEY', value: 'YOUR_API_KEY' }] });
    expect(looksPlaceholder('YOUR_API_KEY')).toBe(true);
  });

  it('stdio через --, переменные -e, -s user, перенос строки «\\», приглашение $', () => {
    const r = parseMcpPaste('$ claude mcp add -s user -e Z_AI_API_KEY=key1 -e Z_AI_MODE=ZAI \\\n  zai -- npx -y "@z_ai/mcp-server"');
    expect(r.error).toBeUndefined();
    expect(r.servers[0]).toMatchObject({ name: 'zai', type: 'stdio', command: 'npx', args: '-y @z_ai/mcp-server', env: [{ name: 'Z_AI_API_KEY', value: 'key1' }, { name: 'Z_AI_MODE', value: 'ZAI' }] });
  });

  it('z.ai: -t http -H "Authorization: Bearer …"; несколько команд подряд', () => {
    const r = parseMcpPaste([
      'claude mcp add -s user -t http web-search-prime https://api.z.ai/api/mcp/web_search_prime/mcp --header "Authorization: Bearer your_api_key"',
      'claude mcp add -s user -t http web-reader https://api.z.ai/api/mcp/web_reader/mcp --header "Authorization: Bearer your_api_key"',
    ].join('\n'));
    expect(r.servers.map((d) => d.name)).toEqual(['web-search-prime', 'web-reader']);
    expect(r.servers[1]!.headers).toEqual([{ name: 'Authorization', value: 'Bearer your_api_key' }]);
  });

  it('add-json и --transport=sse; без транспорта — HTTP с заметкой', () => {
    expect(parseMcpPaste(`claude mcp add-json weather '{"type":"stdio","command":"/path/to/weather-cli","args":["--api-key","abc123"]}'`).servers[0])
      .toMatchObject({ name: 'weather', type: 'stdio', command: '/path/to/weather-cli', args: '--api-key abc123' });
    expect(parseMcpPaste('claude mcp add --transport=sse asana https://mcp.asana.com/sse').servers[0]).toMatchObject({ type: 'sse', name: 'asana' });
    const r = parseMcpPaste('claude mcp add notion https://mcp.notion.com/mcp');
    expect(r.servers[0]).toMatchObject({ type: 'http' });
    expect(r.notes.join()).toMatch(/HTTP/);
  });

  it('не добавление — ошибка', () => {
    expect(parseMcpPaste('claude mcp remove notion').error).toBeTruthy();
  });
});

describe('вставка: адрес и строка запуска', () => {
  it('голый адрес → HTTP с именем от адреса', () => {
    expect(parseMcpPaste('https://mcp.notion.com/mcp').servers[0]).toMatchObject({ name: 'notion', type: 'http' });
  });
  it('npx/uvx/docker и переменные перед командой', () => {
    expect(parseMcpPaste('npx -y @upstash/context7-mcp@latest').servers[0]).toMatchObject({ name: 'context7', command: 'npx', args: '-y @upstash/context7-mcp@latest' });
    expect(parseMcpPaste('uvx mcp-server-fetch').servers[0]).toMatchObject({ name: 'fetch', command: 'uvx' });
    expect(parseMcpPaste('docker run -i --rm ghcr.io/github/github-mcp-server').servers[0]).toMatchObject({ name: 'github', command: 'docker' });
    expect(parseMcpPaste('GITHUB_TOKEN=abc npx -y @modelcontextprotocol/server-github').servers[0]).toMatchObject({ name: 'github', env: [{ name: 'GITHUB_TOKEN', value: 'abc' }] });
  });
  it('мусор — подсказка о форматах', () => {
    expect(parseMcpPaste('привет').error).toMatch(/JSON/);
  });
});

describe('черновик → конфиг', () => {
  it('HTTP: заголовки, пустые строки пропускаются, без значения — ошибка', () => {
    const d = { ...emptyDraft('http'), name: 'a', url: 'https://x.y/mcp', headers: [{ name: 'Authorization', value: 'Bearer k' }, { name: '', value: '' }] };
    expect(draftToConfig(d)).toEqual({ type: 'http', url: 'https://x.y/mcp', headers: { Authorization: 'Bearer k' } });
    expect(draftToConfig({ ...d, headers: [{ name: 'X-Key', value: '' }] })).toMatch(/нет значения/);
    expect(draftToConfig({ ...d, url: 'mcp.notion.com' })).toMatch(/http/);
  });
  it('stdio: команда со словами разбирается в аргументы', () => {
    expect(draftToConfig({ ...emptyDraft('stdio'), command: 'npx -y pkg', args: '--port 3', env: [{ name: 'K', value: 'v' }] }))
      .toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg', '--port', '3'], env: { K: 'v' } });
    expect(draftToConfig({ ...emptyDraft('stdio'), command: 'npx', env: [{ name: '1BAD', value: 'v' }] })).toMatch(/переменная/);
  });
  it('аргументы с пробелами и кавычками — туда и обратно', () => {
    const args = ['-y', 'a b', 'say "hi"', ''];
    expect(splitArgs(joinArgs(args))).toEqual(args);
  });
});

describe('заглушки и имена', () => {
  it('заглушки узнаются, настоящие ключи и метка аккаунта — нет', () => {
    for (const v of ['your_api_key', 'Bearer YOUR_TOKEN', '<token>', '${GITHUB_TOKEN}', 'Bearer xxxx', '...', 'your-personal-access-token']) expect(looksPlaceholder(v)).toBe(true);
    for (const v of ['Bearer ghp_abc123', 'sk-ant-api03-xyz', `Bearer ${ACCOUNT_KEY}`, 'eu']) expect(looksPlaceholder(v)).toBe(false);
  });
  it('имена из адресов и пакетов, свободное имя', () => {
    expect(nameFromUrl('https://api.z.ai/api/mcp/web_search_prime/mcp')).toBe('web_search_prime');
    expect(nameFromUrl('https://mcp.figma.com/mcp')).toBe('figma');
    expect(nameFromPackage('@modelcontextprotocol/server-github')).toBe('github');
    expect(freeName('notion', new Set(['notion', 'notion-2']))).toBe('notion-3');
  });
  it('ключ аккаунта предлагается только домену шлюза (или команде)', () => {
    expect(accountKeyFits('api.z.ai', { type: 'http', url: 'https://api.z.ai/api/mcp/web_reader/mcp' })).toBe(true);
    expect(accountKeyFits('open.bigmodel.cn', { type: 'http', url: 'https://mcp.bigmodel.cn/x' })).toBe(true);
    expect(accountKeyFits('api.z.ai', { type: 'http', url: 'https://mcp.context7.com/mcp' })).toBe(false);
    expect(accountKeyFits('api.z.ai', { type: 'stdio' })).toBe(true);
    expect(accountKeyFits(undefined, { type: 'stdio' })).toBe(false);
  });
  it('метка ключа аккаунта в значение', () => {
    expect(withAccountKeyMark('Authorization', 'Bearer your_api_key')).toBe(`Bearer ${ACCOUNT_KEY}`);
    expect(withAccountKeyMark('Authorization', '')).toBe(`Bearer ${ACCOUNT_KEY}`);
    expect(withAccountKeyMark('Z_AI_API_KEY', 'your_api_key')).toBe(ACCOUNT_KEY);
  });
});

describe('шаблон каталога', () => {
  const fields: McpField[] = [
    { key: 'TOKEN', label: 'TOKEN', required: true, secret: true },
    { key: 'REGION', label: 'REGION', required: false, secret: false, default: 'eu' },
    { key: 'port', label: 'port', required: false, secret: false },
    { key: 'Authorization', label: 'Authorization', required: false, secret: true },
  ];
  const stdio: McpTemplate = {
    type: 'stdio', command: 'npx',
    args: [{ tokens: ['-y'] }, { tokens: ['pkg@1.0.0'] }, { tokens: ['--port', '{{port}}'], field: 'port' }],
    env: [{ name: 'TOKEN', value: '{{TOKEN}}' }, { name: 'REGION', value: '{{REGION}}' }],
  };

  it('обязательное пустое — ошибка; необязательный аргумент без значения пропадает; умолчание подставляется', () => {
    expect(fillTemplate(stdio, fields, {})).toMatch(/TOKEN/);
    expect(fillTemplate(stdio, fields, { TOKEN: 't1' })).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg@1.0.0'], env: { TOKEN: 't1', REGION: 'eu' } });
    expect(fillTemplate(stdio, fields, { TOKEN: 't1', port: '8080', REGION: 'us' })).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg@1.0.0', '--port', '8080'], env: { TOKEN: 't1', REGION: 'us' } });
  });

  it('HTTP: необязательный заголовок без значения — без заголовка; метка аккаунта остаётся', () => {
    const http: McpTemplate = { type: 'http', url: 'https://mcp.context7.com/mcp', headers: [{ name: 'Authorization', value: '{{Authorization}}' }] };
    const f = fields.filter((x) => x.key === 'Authorization');
    expect(fillTemplate(http, f, {})).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp' });
    expect(fillTemplate(http, f, { Authorization: `Bearer ${ACCOUNT_KEY}` })).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp', headers: { Authorization: `Bearer ${ACCOUNT_KEY}` } });
    const smithery: McpTemplate = { type: 'http', url: 'https://server.smithery.ai/x/mcp', headers: [{ name: 'Authorization', value: 'Bearer {{k}}' }] };
    expect(fillTemplate(smithery, [{ key: 'k', label: 'k', required: false, secret: true }], { k: 'abc' })).toMatchObject({ headers: { Authorization: 'Bearer abc' } });
  });

  it('переменная в адресе', () => {
    const t: McpTemplate = { type: 'http', url: 'https://{{tenant}}.example.com/mcp' };
    const f: McpField[] = [{ key: 'tenant', label: 'tenant', required: true, secret: false }];
    expect(fillTemplate(t, f, {})).toMatch(/tenant/);
    expect(fillTemplate(t, f, { tenant: 'acme' })).toEqual({ type: 'http', url: 'https://acme.example.com/mcp' });
  });

  it('предпросмотр без секретов', () => {
    expect(previewTemplate(stdio, fields, { TOKEN: 'secret-1', port: '9' })).toBe('npx -y pkg@1.0.0 --port 9');
    const t: McpTemplate = { type: 'stdio', command: 'docker', args: [{ tokens: ['run', '{{TOKEN}}', '{{port}}'] }] };
    expect(previewTemplate(t, fields, { TOKEN: 'secret-1' })).toBe('docker run ••• ‹port›');
  });
});
