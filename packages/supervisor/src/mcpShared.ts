// Общий список MCP среды (2026-11-12, владелец: «одни на всех, уметь выключать»). Серверы по-прежнему живут у самого
// Claude Code — в настройках каждого аккаунта (user scope, `claude mcp add-json/remove`): так их видит и `claude`
// в терминале, и вход OAuth работает у каждого аккаунта. Здесь — запасная копия (mcp-shared.json рядом с profiles.json,
// права 600): выключенный у всех сервер не теряется, новый аккаунт получает всё, включить у аккаунта — взять отсюда.
// Аккаунты с общим файлом настроек (.claude.json) — одна цель: включение у одного видно у другого.
// Ключ аккаунта-шлюза: копия хранит ещё и шаблон с {{account-key}} — у каждого аккаунта подставляется его собственный
// ключ, если он подходит серверу (HTTP — домен адреса, команда — шлюз keyHost, чей ключ она ждёт); не подходит —
// остаётся ключ, с которым сервер добавили.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACCOUNT_KEY_MARK, withAccountKey, type McpConfig } from './mcp.js';

export interface StoredMcp {
  /** конфиг как есть (с настоящими значениями) */
  config: McpConfig;
  /** тот же конфиг с {{account-key}} вместо ключа аккаунта — если ключ в нём был */
  template?: McpConfig;
  /**
   * шлюз, чей ключ заменён меткой (api.z.ai): команде (stdio) подставляется ключ только аккаунта этого шлюза;
   * не известен — у команды метка не раздаётся (остаётся config)
   */
  keyHost?: string;
}

/** Шлюз z.ai: его ключ ждут серверы набора z.ai. */
export const ZAI_KEY_HOST = 'api.z.ai';

/**
 * Стандартные MCP-серверы z.ai (идут с кодинг-планом; так их ставит документация z.ai — сверено с настройками владельца):
 * поиск, чтение страниц, zread (репозитории GitHub), распознавание изображений. Ключ — ключ аккаунта z.ai.
 */
export const ZAI_MCP_PRESET: Record<string, McpConfig> = {
  'web-search-prime': { type: 'http', url: 'https://api.z.ai/api/mcp/web_search_prime/mcp', headers: { Authorization: `Bearer ${ACCOUNT_KEY_MARK}` } },
  'web-reader': { type: 'http', url: 'https://api.z.ai/api/mcp/web_reader/mcp', headers: { Authorization: `Bearer ${ACCOUNT_KEY_MARK}` } },
  zread: { type: 'http', url: 'https://api.z.ai/api/mcp/zread/mcp', headers: { Authorization: `Bearer ${ACCOUNT_KEY_MARK}` } },
  'zai-mcp-server': { type: 'stdio', command: 'npx', args: ['-y', '@z_ai/mcp-server'], env: { Z_AI_MODE: 'ZAI', Z_AI_API_KEY: ACCOUNT_KEY_MARK } },
};

/** Аккаунт на шлюзе z.ai — ему положен набор z.ai. */
export function isZaiGateway(baseUrl: string | undefined): boolean {
  try { return baseUrl ? /(^|\.)z\.ai$/i.test(new URL(baseUrl).hostname) : false; } catch { return false; }
}

/** Ключ и шлюз аккаунта для подстановки {{account-key}}. */
export interface AccountKey {
  key?: string;
  baseUrl?: string;
}

/** Ключ аккаунта из его окружения: токен шлюза или ключ API (токен подписки — не ключ для MCP). */
export function accountKeyOf(env: Record<string, string>, subToken: boolean): AccountKey {
  if (subToken) return {};
  const key = env['ANTHROPIC_AUTH_TOKEN'] ?? env['ANTHROPIC_API_KEY'];
  return { ...(key ? { key } : {}), ...(env['ANTHROPIC_BASE_URL'] ? { baseUrl: env['ANTHROPIC_BASE_URL'] } : {}) };
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
  return Object.keys(out).length ? out : undefined;
}

/** Запись из .claude.json аккаунта → конфиг для `claude mcp add-json`; WebSocket и непонятное — null (не переносим). */
export function toMcpConfig(raw: Record<string, unknown>): McpConfig | null {
  const type = String(raw['type'] ?? (raw['command'] ? 'stdio' : raw['url'] ? 'http' : '')).toLowerCase();
  if (type === 'stdio') {
    const command = typeof raw['command'] === 'string' ? raw['command'] : '';
    if (!command) return null;
    const args = Array.isArray(raw['args']) ? (raw['args'] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
    const env = strRecord(raw['env']);
    return { type: 'stdio', command, ...(args?.length ? { args } : {}), ...(env ? { env } : {}) };
  }
  if (type === 'http' || type === 'sse') {
    const url = typeof raw['url'] === 'string' ? raw['url'] : '';
    if (!url) return null;
    const headers = strRecord(raw['headers']);
    return { type, url, ...(headers ? { headers } : {}) };
  }
  return null;
}

/** Ключи аккаунтов цели → {{account-key}} в заголовках и переменных; ключа там нет — undefined. */
export function templateOf(cfg: McpConfig, keys: Array<string | undefined>): McpConfig | undefined {
  const ks = keys.filter((k): k is string => typeof k === 'string' && k.length >= 8);
  let hit = false;
  const sub = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => {
    let x = v;
    for (const key of ks) if (x.includes(key)) { x = x.split(key).join(ACCOUNT_KEY_MARK); hit = true; }
    return [k, x];
  }));
  const t: McpConfig = cfg.type === 'stdio'
    ? { ...cfg, ...(cfg.env ? { env: sub(cfg.env) } : {}) }
    : { ...cfg, ...(cfg.headers ? { headers: sub(cfg.headers) } : {}) };
  return hit ? t : undefined;
}

/**
 * Смена ключа аккаунта: старый ключ → новый в заголовках и переменных (там же, куда его кладёт {{account-key}}).
 * Старого ключа в конфиге нет (или он короче 8 символов, как в templateOf) — null: трогать нечего.
 */
export function rekeyConfig(cfg: McpConfig, oldKey: string, newKey: string): McpConfig | null {
  if (oldKey.length < 8 || oldKey === newKey) return null;
  let hit = false;
  const sub = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => {
    if (!v.includes(oldKey)) return [k, v];
    hit = true;
    return [k, v.split(oldKey).join(newKey)];
  }));
  const out: McpConfig = cfg.type === 'stdio'
    ? { ...cfg, ...(cfg.env ? { env: sub(cfg.env) } : {}) }
    : { ...cfg, ...(cfg.headers ? { headers: sub(cfg.headers) } : {}) };
  return hit ? out : null;
}

/** Конфиг для цели: шаблон с ключом её аккаунта (если подходит серверу), иначе как сохранён. */
export function configFor(e: StoredMcp, accounts: AccountKey[]): McpConfig {
  // команде без известного шлюза ключа чужой ключ не подставляем: кому он нужен — не проверить
  if (e.template && (e.template.type !== 'stdio' || e.keyHost)) {
    for (const a of accounts) {
      if (!a.key) continue;
      try { return withAccountKey(e.template, a, e.keyHost); } catch { /* ключ этого аккаунта серверу не подходит */ }
    }
  }
  return e.config;
}

/** Хост шлюза аккаунта (ANTHROPIC_BASE_URL); нет или битый — undefined. */
export function gatewayHostOf(a: AccountKey): string | undefined {
  try { return a.baseUrl ? new URL(a.baseUrl).hostname : undefined; } catch { return undefined; }
}

/**
 * Шлюз ключа для копии без keyHost (файл до 2026-11-13): HTTP — хост адреса (его и так проверяет домен), команда —
 * только если это zai-mcp-server из набора z.ai; иначе не известен.
 */
export function guessKeyHost(name: string, template: McpConfig): string | undefined {
  if (template.type !== 'stdio') {
    try { return new URL(template.url).hostname; } catch { return undefined; }
  }
  const preset = ZAI_MCP_PRESET[name];
  const same = preset?.type === 'stdio' && preset.command === template.command && JSON.stringify(preset.args ?? []) === JSON.stringify(template.args ?? []);
  return same ? ZAI_KEY_HOST : undefined;
}

/** Копии общих серверов; без файла (тесты) — в памяти. Битый файл — начинаем с пустого (источник правды — аккаунты). */
export class McpSharedStore {
  private map = new Map<string, StoredMcp>();

  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { servers?: Record<string, StoredMcp> };
      for (const [name, e] of Object.entries(raw.servers ?? {})) {
        const config = e && typeof e === 'object' ? toMcpConfig(e.config as unknown as Record<string, unknown>) : null;
        if (!config) continue;
        const template = e.template ? toMcpConfig(e.template as unknown as Record<string, unknown>) : null;
        const keyHost = !template ? undefined : typeof e.keyHost === 'string' && e.keyHost ? e.keyHost : guessKeyHost(name, template);
        this.map.set(name, { config, ...(template ? { template } : {}), ...(keyHost ? { keyHost } : {}) });
      }
    } catch (err) {
      console.log(`[mcp] ${file} не прочитан (${String((err as Error)?.message ?? err)}) — начинаю с пустого`);
    }
  }

  get(name: string): StoredMcp | undefined {
    return this.map.get(name);
  }

  all(): Record<string, StoredMcp> {
    return Object.fromEntries(this.map);
  }

  put(name: string, e: StoredMcp): void {
    this.map.set(name, e);
    this.save();
  }

  remove(name: string): void {
    if (this.map.delete(name)) this.save();
  }

  /**
   * Аккаунт сменил ключ: в копиях, где лежал старый (обычно «как есть» у записей с шаблоном — ключ, с которым сервер
   * добавили), — новый; шаблон с меткой не меняется. Возвращает имена обновлённых серверов.
   */
  rekey(oldKey: string, newKey: string): string[] {
    const hit: string[] = [];
    for (const [name, e] of this.map) {
      const config = rekeyConfig(e.config, oldKey, newKey);
      const template = e.template ? rekeyConfig(e.template, oldKey, newKey) : null;
      if (!config && !template) continue;
      const t = template ?? e.template;
      this.map.set(name, { config: config ?? e.config, ...(t ? { template: t } : {}), ...(e.keyHost ? { keyHost: e.keyHost } : {}) });
      hit.push(name);
    }
    if (hit.length) this.save();
    return hit;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, servers: Object.fromEntries(this.map) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* Windows: права не по POSIX */ }
  }
}
