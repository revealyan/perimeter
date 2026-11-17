// MCP-подключения из UI (ночь 2026-11-12, по образцу аккаунтов): настройки живут у самого Claude Code —
// `claude mcp add-json -s user`, `remove -s user`, `list` в CLAUDE_CONFIG_DIR аккаунта; своего хранилища нет.
// Секреты (заголовки HTTP, env stdio) только уходят на сервер: клиенту — имена заголовков и переменных.
// Проверка в `claude mcp list` у stdio-серверов запускает их команды — это поведение самого Claude Code.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loginEnv, stripAnsi } from './accounts.js';

export type McpTransport = 'http' | 'sse' | 'stdio' | 'ws';
export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unknown';

export interface McpServerInfo {
  name: string;
  transport: McpTransport;
  /** адрес (http/sse/ws) или команда с аргументами (stdio) — без секретов */
  target: string;
  status: McpStatus;
  /** как показал Claude Code («Connected», «Needs authentication», «Failed to connect»…) */
  statusText: string;
  /** user — настроен у аккаунта (можно удалить отсюда); other — из проекта, плагина или claude.ai */
  scope: 'user' | 'other';
  headerNames?: string[];
  envNames?: string[];
}

export type McpConfig =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

/** Имя сервера: как у Claude Code — латиница, цифры, - и _. */
export const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Строка `claude mcp list`: «имя: цель (HTTP) - ✔ Connected». */
export function parseMcpList(out: string): Map<string, { target: string; transport: McpTransport; status: McpStatus; statusText: string }> {
  const res = new Map<string, { target: string; transport: McpTransport; status: McpStatus; statusText: string }>();
  for (const raw of stripAnsi(out).split('\n')) {
    const line = raw.trim();
    const m = /^([^:\s][^:]*?):\s+(.+?)\s+\((HTTP|SSE|stdio|STDIO|WebSocket|WS)\)\s+-\s+(.+)$/.exec(line);
    if (!m) continue;
    const t = m[3]!.toLowerCase();
    const transport: McpTransport = t === 'http' ? 'http' : t === 'sse' ? 'sse' : t === 'stdio' ? 'stdio' : 'ws';
    const tail = m[4]!.trim();
    const text = tail.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const status: McpStatus = /needs auth/i.test(tail) ? 'needs-auth'
      : /connected/i.test(tail) && !/fail|not connected|disconnected/i.test(tail) ? 'connected'
        : /pending/i.test(tail) ? 'pending'
          : /fail|error|✘|✗/i.test(tail) ? 'failed' : 'unknown';
    res.set(m[1]!.trim(), { target: m[2]!.trim(), transport, status, statusText: text || tail });
  }
  return res;
}

/** Глобальный файл Claude Code: `<CLAUDE_CONFIG_DIR>/.claude.json`, без явной папки — `~/.claude.json`. */
export function globalConfigFile(configDir: string | undefined, home = homedir()): string {
  return configDir ? join(configDir, '.claude.json') : join(home, '.claude.json');
}

/** MCP-серверы аккаунта (user scope) из глобального файла его Claude Code. */
export function readUserMcp(configDir: string | undefined): Record<string, Record<string, unknown>> {
  try {
    const j = JSON.parse(readFileSync(globalConfigFile(configDir), 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> };
    return j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  } catch {
    return {};
  }
}

/** Сведения для клиента: список Claude Code + свои серверы аккаунта; секреты — только имена. */
export function mergeMcp(listed: ReturnType<typeof parseMcpList>, user: Record<string, Record<string, unknown>>): McpServerInfo[] {
  const out: McpServerInfo[] = [];
  const names = new Set([...listed.keys(), ...Object.keys(user)]);
  for (const name of names) {
    const l = listed.get(name);
    const u = user[name];
    const type = String(u?.['type'] ?? (u?.['command'] ? 'stdio' : u?.['url'] ? 'http' : l?.transport ?? 'stdio')).toLowerCase();
    const transport: McpTransport = type === 'http' ? 'http' : type === 'sse' ? 'sse' : type === 'ws' || type === 'websocket' ? 'ws' : 'stdio';
    const target = u
      ? transport === 'stdio'
        ? [String(u['command'] ?? ''), ...(Array.isArray(u['args']) ? (u['args'] as unknown[]).map(String) : [])].join(' ').trim()
        : String(u['url'] ?? '')
      : l?.target ?? '';
    const headers = u?.['headers'] && typeof u['headers'] === 'object' ? Object.keys(u['headers'] as object) : [];
    const env = u?.['env'] && typeof u['env'] === 'object' ? Object.keys(u['env'] as object) : [];
    out.push({
      name, transport, target,
      status: l?.status ?? 'unknown',
      statusText: l?.statusText ?? 'не проверялся',
      scope: u ? 'user' : 'other',
      ...(headers.length ? { headerNames: headers } : {}),
      ...(env.length ? { envNames: env } : {}),
    });
  }
  return out.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'user' ? -1 : 1));
}

/** Проверить конфиг перед записью: понятная ошибка вместо отказа Claude Code. */
export function validateMcp(name: string, cfg: McpConfig): string | null {
  if (!MCP_NAME_RE.test(name)) return 'имя: латиница, цифры, «-» и «_», до 64 символов';
  if (cfg.type === 'stdio') {
    if (!cfg.command.trim()) return 'нужна команда запуска';
    for (const k of Object.keys(cfg.env ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `переменная «${k}»: латиница, цифры и _`;
  } else {
    let u: URL;
    try { u = new URL(cfg.url); } catch { return 'адрес сервера не похож на URL'; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'адрес — http или https';
    for (const k of Object.keys(cfg.headers ?? {})) if (!/^[A-Za-z0-9-]+$/.test(k)) return `заголовок «${k}»: латиница, цифры и -`;
  }
  return null;
}

function run(bin: string[], args: string[], configDir: string | undefined, extraEnv: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(bin[0]!, [...bin.slice(1), ...args], { env: { ...loginEnv(configDir), ...extraEnv }, cwd: homedir(), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${String(stdout ?? '')}\n${String(stderr ?? '')}` }));
  });
}

export interface McpDeps {
  bin: string[];
  /** подмена запуска в тестах */
  run?: typeof run;
}

/** Список MCP аккаунта со статусами (`claude mcp list` проверяет каждый сервер — до ~минуты). */
export async function mcpList(d: McpDeps, configDir: string | undefined, extraEnv: Record<string, string> = {}): Promise<McpServerInfo[]> {
  const r = await (d.run ?? run)(d.bin, ['mcp', 'list'], configDir, extraEnv, 90_000);
  return mergeMcp(parseMcpList(r.out), readUserMcp(configDir));
}

/** Добавить сервер аккаунту (user scope). Ошибка Claude Code — исключение с его текстом (без секретов конфига). */
export async function mcpAdd(d: McpDeps, configDir: string | undefined, name: string, cfg: McpConfig, extraEnv: Record<string, string> = {}): Promise<void> {
  const bad = validateMcp(name, cfg);
  if (bad) throw new Error(bad);
  const r = await (d.run ?? run)(d.bin, ['mcp', 'add-json', '-s', 'user', name, JSON.stringify(cfg)], configDir, extraEnv, 30_000);
  if (r.code !== 0) throw new Error(cleanErr(r.out, cfg));
}

export async function mcpRemove(d: McpDeps, configDir: string | undefined, name: string, extraEnv: Record<string, string> = {}): Promise<void> {
  if (!MCP_NAME_RE.test(name)) throw new Error('нет такого сервера');
  const r = await (d.run ?? run)(d.bin, ['mcp', 'remove', '-s', 'user', name], configDir, extraEnv, 30_000);
  if (r.code !== 0) throw new Error(cleanErr(r.out));
}

/** Метка в значении заголовка/переменной: сервер подставит ключ аккаунта (клиент его не знает). */
export const ACCOUNT_KEY_MARK = '{{account-key}}';

export function domainOf(host: string): string {
  return host.toLowerCase().split('.').slice(-2).join('.');
}

/**
 * Подставить ключ аккаунта вместо {{account-key}} (MCP z.ai берут тот же ключ, что и шлюз). Только в заголовки и
 * переменные (аргументы видны в списке процессов); HTTP — только серверам домена шлюза аккаунта, чтобы вставленный
 * чужой конфиг не увёл ключ. У команды (stdio) адреса нет: keyHost — шлюз, чей ключ она ждёт (z.ai у zai-mcp-server);
 * задан — подходит только аккаунт этого шлюза, иначе ключ Anthropic или другого шлюза ушёл бы чужому пакету.
 * Без keyHost (добавление одному аккаунту, его выбор) — ключ этого аккаунта. Нет метки — конфиг как есть.
 */
export function withAccountKey(cfg: McpConfig, account: { key?: string; baseUrl?: string }, keyHost?: string): McpConfig {
  const vals = cfg.type === 'stdio' ? cfg.env ?? {} : cfg.headers ?? {};
  const used = Object.values(vals).some((v) => v.includes(ACCOUNT_KEY_MARK));
  const elsewhere = JSON.stringify(cfg.type === 'stdio' ? [cfg.command, cfg.args ?? []] : [cfg.url]).includes(ACCOUNT_KEY_MARK);
  if (elsewhere) throw new Error('ключ аккаунта подставляется только в заголовки и переменные окружения');
  if (!used) return cfg;
  if (!account.key) throw new Error('у аккаунта нет ключа API — подставить нечего');
  if (cfg.type === 'stdio' && keyHost !== undefined) {
    let gwHost = '';
    try { gwHost = account.baseUrl ? new URL(account.baseUrl).hostname : ''; } catch { /* нет шлюза */ }
    if (!gwHost || domainOf(gwHost) !== domainOf(keyHost)) {
      throw new Error(`сервер ждёт ключ шлюза ${keyHost}, а у аккаунта ${gwHost ? `шлюз ${gwHost}` : 'шлюза нет'}`);
    }
  }
  if (cfg.type !== 'stdio') {
    let mcpHost = '';
    let gwHost = '';
    try { mcpHost = new URL(cfg.url).hostname; } catch { /* адрес проверит validateMcp */ }
    try { gwHost = account.baseUrl ? new URL(account.baseUrl).hostname : ''; } catch { /* нет шлюза */ }
    if (!gwHost || !mcpHost || domainOf(mcpHost) !== domainOf(gwHost)) {
      throw new Error(`ключ аккаунта уходит только серверам его шлюза (${gwHost || 'шлюза нет'}), а не ${mcpHost || 'этому адресу'}`);
    }
  }
  const put = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.split(ACCOUNT_KEY_MARK).join(account.key!)]));
  return cfg.type === 'stdio' ? { ...cfg, env: put(cfg.env ?? {}) } : { ...cfg, headers: put(cfg.headers ?? {}) };
}

/** Текст ошибки Claude Code без значений секретов конфига. */
function cleanErr(out: string, cfg?: McpConfig): string {
  let text = stripAnsi(out).split('\n').map((x) => x.trim()).filter(Boolean).slice(-3).join(' · ') || 'Claude Code вернул ошибку';
  const secrets = cfg ? [...Object.values(cfg.type === 'stdio' ? cfg.env ?? {} : cfg.headers ?? {})] : [];
  for (const v of secrets) if (v.length >= 4) text = text.split(v).join('***');
  return text.slice(0, 300);
}
