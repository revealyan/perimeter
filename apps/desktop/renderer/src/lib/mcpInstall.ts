// Установка MCP из UI: черновик сервера (форма «Вручную» и разбор вставки) и заполнение шаблона каталога.
// Вставка понимает то, что пишут в документации серверов: JSON {"mcpServers": …} (Claude Desktop, Cursor),
// {"servers": …} (VS Code), один конфиг или кусок «"имя": {…}», команды `claude mcp add …` / `add-json`,
// голый адрес https://… и строку запуска npx/uvx/docker.
import type { McpConfig, McpField, McpTemplate } from '../supervisor';

export interface KV { name: string; value: string }

export interface McpDraft {
  name: string;
  type: 'http' | 'sse' | 'stdio';
  url: string;
  headers: KV[];
  command: string;
  /** аргументы одной строкой, как в терминале */
  args: string;
  env: KV[];
}

/** Метка: ключ аккаунта подставит сервер (клиент ключа не знает). */
export const ACCOUNT_KEY = '{{account-key}}';
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function emptyDraft(type: McpDraft['type'] = 'http'): McpDraft {
  return { name: '', type, url: '', headers: [], command: '', args: '', env: [] };
}

/** «-y "@scope/pkg" /tmp» → ['-y', '@scope/pkg', '/tmp'] */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]!);
  return out;
}

export function joinArgs(args: string[]): string {
  return args.map((a) => (a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');
}

/** Значение похоже на заглушку из документации («your_api_key», «<token>», «${KEY}»). */
export function looksPlaceholder(v: string): boolean {
  const s = v.split(ACCOUNT_KEY).join('');
  if (!s.trim()) return false;
  return /(your|my)[-_ ]?(personal[-_ ]?)?(access[-_ ]?|api[-_ ]?)?(key|token|secret|pat)\b|<[^<>]+>|\{[^{}]+\}|\$\{[^}]+\}|^\s*(bearer\s+)?x{4,}\s*$|^\s*(bearer\s+)?(\.\.\.|…)\s*$|api[-_ ]?key[-_ ]?here|replace[-_ ]?(me|with)|change[-_ ]?me|^\s*\*{3,}\s*$/i.test(s);
}

/** Имя заголовка/переменной намекает на секрет — значение прячем. */
export function secretish(name: string): boolean {
  return /auth|token|key|secret|pass|cookie|credential|pat\b/i.test(name);
}

/** Черновик → конфиг для cmd:mcp.add или текст ошибки. */
export function draftToConfig(d: McpDraft): McpConfig | string {
  if (d.type === 'stdio') {
    let command = d.command.trim();
    let args = splitArgs(d.args);
    if (!command) return 'нужна команда запуска';
    if (/\s/.test(command)) { const parts = splitArgs(command); command = parts[0]!; args = [...parts.slice(1), ...args]; }
    const env: Record<string, string> = {};
    for (const r of d.env) {
      const k = r.name.trim();
      if (!k && !r.value.trim()) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `переменная «${k || '…'}»: латиница, цифры и _`;
      env[k] = r.value;
    }
    return { type: 'stdio', command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
  }
  const url = d.url.trim();
  if (!/^https?:\/\/[^\s/]+\S*$/.test(url)) return 'нужен адрес http(s)://…';
  const headers: Record<string, string> = {};
  for (const r of d.headers) {
    const k = r.name.trim();
    if (!k && !r.value.trim()) continue;
    if (!/^[A-Za-z0-9-]+$/.test(k)) return `заголовок «${k || '…'}»: латиница, цифры и -`;
    if (!r.value.trim()) return `у заголовка ${k} нет значения`;
    headers[k] = r.value.trim();
  }
  return { type: d.type, url, ...(Object.keys(headers).length ? { headers } : {}) };
}

/** Проблемы, которые не мешают добавить, но почти наверняка ошибка (заглушки вместо ключей). */
export function draftWarnings(d: McpDraft): string[] {
  const rows = d.type === 'stdio' ? d.env : d.headers;
  const out = rows.filter((r) => looksPlaceholder(r.value)).map((r) => `${r.name}: похоже на заглушку из документации — вставьте настоящее значение`);
  if (d.type !== 'stdio' && looksPlaceholder(d.url)) out.push('в адресе заглушка — подставьте своё значение');
  if (d.type === 'stdio' && looksPlaceholder(d.args)) out.push('в аргументах заглушка — подставьте своё значение');
  return out;
}

/** Имя из адреса: mcp.notion.com → notion, api.z.ai/api/mcp/web_search_prime/mcp → web-search-prime. */
export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter((x) => x && !/^(api|mcp|sse|v\d+|stream|http)$/i.test(x));
    if (segs.length) return sanitizeName(segs[segs.length - 1]!);
    const labels = u.hostname.split('.').filter((l) => !/^(mcp|api|www|server|com|io|ai|dev|app|net|org|co)$/i.test(l));
    return sanitizeName(labels[0] ?? u.hostname.split('.')[0] ?? 'mcp');
  } catch { return 'mcp'; }
}

/** Имя из пакета: @upstash/context7-mcp@1.0 → context7, mcp-server-fetch → fetch. */
export function nameFromPackage(pkg: string): string {
  const base = pkg.replace(/^@[^/]+\//, '').replace(/[@=:].*$/, '').split('/').pop() ?? pkg;
  return sanitizeName(base.replace(/^(mcp|server)[-_]/i, '').replace(/^(mcp|server)[-_]/i, '').replace(/[-_](mcp[-_]server|mcp|server)$/i, '') || base);
}

export function sanitizeName(s: string): string {
  const c = s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64);
  return c && /^[A-Za-z0-9]/.test(c) ? c : 'mcp';
}

/** Свободное имя: notion → notion-2, если занято. */
export function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return base;
}

// ─── Разбор вставки ─────────────────────────────────────────────────────────

export interface PasteResult {
  servers: McpDraft[];
  /** что поправлено при разборе — показать человеку */
  notes: string[];
  error?: string;
}

/** JSON с комментариями и висячими запятыми (как в документации и settings.json VS Code) → строгий JSON. */
function relaxJson(src: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    out += c;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isServerCfg(v: unknown): boolean {
  const o = obj(v);
  return !!o && (typeof o['command'] === 'string' || typeof o['url'] === 'string' || typeof o['serverUrl'] === 'string' || typeof o['httpUrl'] === 'string');
}

function kv(v: unknown): KV[] {
  const o = obj(v);
  return o ? Object.entries(o).map(([name, value]) => ({ name, value: String(value ?? '') })) : [];
}

/** Конфиг из JSON → черновик (типы: http, streamable-http, sse, stdio; Windows-обёртка cmd /c снимается). */
function cfgToDraft(name: string, raw: Record<string, unknown>, notes: string[]): McpDraft {
  const url = String(raw['url'] ?? raw['serverUrl'] ?? raw['httpUrl'] ?? '');
  const t = String(raw['type'] ?? raw['transport'] ?? '').toLowerCase().replace(/[_\s]/g, '-');
  const d = emptyDraft();
  d.name = name;
  if (typeof raw['command'] === 'string' && !url) {
    d.type = 'stdio';
    let command = raw['command'];
    let args = Array.isArray(raw['args']) ? (raw['args'] as unknown[]).map(String) : [];
    if (/^cmd(\.exe)?$/i.test(command) && /^\/c$/i.test(args[0] ?? '') && args[1]) {
      command = args[1];
      args = args.slice(2);
      notes.push(`${name || 'сервер'}: «cmd /c» — обёртка для Windows, на сервере не нужна — убрал`);
    }
    d.command = command;
    d.args = joinArgs(args);
    d.env = kv(raw['env']);
    return d;
  }
  d.type = t === 'sse' || (!t && /\/sse\/?$/.test(url)) ? 'sse' : 'http';
  d.url = url;
  d.headers = kv(raw['headers']);
  return d;
}

/** Разобрать JSON-вставку. */
function parseJson(text: string, notes: string[]): McpDraft[] | string {
  let src = relaxJson(text.trim());
  if (src.startsWith('"')) src = `{${src}}`; // кусок «"имя": {…}» без внешних скобок
  let j: unknown;
  try { j = JSON.parse(src); } catch (e) { return `JSON не разобрался: ${(e as Error).message}`; }
  const root = obj(j);
  if (!root) return 'ожидался объект JSON';
  const map = obj(root['mcpServers']) ?? obj(root['servers']) ?? obj(obj(root['mcp'])?.['servers']) ?? null;
  if (map) return Object.entries(map).filter(([, v]) => isServerCfg(v)).map(([n, v]) => cfgToDraft(n, obj(v)!, notes));
  if (isServerCfg(root)) return [cfgToDraft('', root, notes)];
  const entries = Object.entries(root).filter(([, v]) => isServerCfg(v));
  if (entries.length) return entries.map(([n, v]) => cfgToDraft(n, obj(v)!, notes));
  return 'в JSON нет MCP-серверов (ждал mcpServers, servers или поля url/command)';
}

/** Командная строка → слова (кавычки, экранирование, перенос строки через \\). */
function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) { cur += line[i + 1]; i += 1; }
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && line[i + 1] !== undefined) { if (line[i + 1] !== '\n') cur += line[i + 1]; i += 1; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
    has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** `claude mcp add …` / `claude mcp add-json …` → черновик. */
function parseClaudeAdd(words: string[], notes: string[]): McpDraft | string {
  const i = words.findIndex((w, k) => w === 'mcp' && /claude(\.exe)?$/i.test(words[k - 1] ?? ''));
  const sub = words[i + 1];
  const rest = words.slice(i + 2);
  const pos: string[] = [];
  const headers: KV[] = [];
  const env: KV[] = [];
  let transport = '';
  let tail: string[] | null = null;
  for (let k = 0; k < rest.length; k += 1) {
    const w = rest[k]!;
    if (w === '--') { tail = rest.slice(k + 1); break; }
    const eq = w.indexOf('=');
    const flag = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : w;
    const inline = w.startsWith('--') && eq > 0 ? w.slice(eq + 1) : undefined;
    const val = () => inline ?? rest[++k] ?? '';
    if (flag === '-t' || flag === '--transport') transport = val().toLowerCase();
    else if (flag === '-s' || flag === '--scope') val();
    else if (flag === '-H' || flag === '--header') { const h = val(); const c = h.indexOf(':'); if (c > 0) headers.push({ name: h.slice(0, c).trim(), value: h.slice(c + 1).trim() }); }
    else if (flag === '-e' || flag === '--env') { const e = val(); const c = e.indexOf('='); if (c > 0) env.push({ name: e.slice(0, c), value: e.slice(c + 1) }); }
    else if (flag === '--client-id' || flag === '--client-secret' || flag === '--callback-port') { val(); notes.push(`${flag} не переносится — вход OAuth сделайте кнопкой «Войти» после добавления`); }
    else if (w.startsWith('-') && pos.length >= 2 && sub === 'add') pos.push(w); // флаги команды сервера без «--»
    else pos.push(w);
  }
  if (sub === 'add-json') {
    const [name, json] = pos;
    if (!name || !json) return 'add-json: нужны имя и JSON';
    const r = parseJson(json, notes);
    if (typeof r === 'string') return r;
    if (!r[0]) return 'add-json: в JSON нет конфига';
    return { ...r[0], name };
  }
  if (sub !== 'add') return `команда «claude mcp ${sub ?? ''}» — не добавление`;
  const name = pos[0] ?? '';
  const target = tail ?? pos.slice(1);
  if (!target.length) return 'после имени нужен адрес или команда';
  const d = emptyDraft();
  d.name = name;
  if (transport === 'http' || transport === 'sse' || (!transport && !tail && /^https?:\/\//.test(target[0]!))) {
    if (!transport) notes.push('транспорт не указан — адрес https://, считаю HTTP');
    d.type = transport === 'sse' ? 'sse' : 'http';
    d.url = target[0]!;
    d.headers = headers;
    return d;
  }
  d.type = 'stdio';
  d.command = target[0]!;
  d.args = joinArgs(target.slice(1));
  d.env = env;
  return d;
}

/** Разобрать вставку: JSON, команды claude mcp add, адрес, строку запуска. */
export function parseMcpPaste(text: string): PasteResult {
  const notes: string[] = [];
  const t = text.trim();
  if (!t) return { servers: [], notes };
  if (/^[{"]/.test(t)) {
    const r = parseJson(t, notes);
    return typeof r === 'string' ? { servers: [], notes, error: r } : named({ servers: r, notes });
  }
  if (/\bclaude(\.exe)?\s+mcp\s+add/.test(t)) {
    // несколько команд: по строкам (с учётом переноса «\») и через && / ;
    const cmds = t.replace(/\\\r?\n/g, ' ').split(/\r?\n|&&|;(?=\s*claude)/).map((x) => x.trim()).filter((x) => /\bclaude(\.exe)?\s+mcp\s+add/.test(x));
    const servers: McpDraft[] = [];
    for (const c of cmds) {
      const r = parseClaudeAdd(shellWords(c.replace(/^\$\s*/, '')), notes);
      if (typeof r === 'string') return { servers: [], notes, error: r };
      servers.push(r);
    }
    return named({ servers, notes });
  }
  if (/^https?:\/\/\S+$/.test(t)) {
    const d = emptyDraft(/\/sse\/?$/.test(t) ? 'sse' : 'http');
    d.url = t;
    return named({ servers: [d], notes });
  }
  const words = shellWords(t.replace(/\\\r?\n/g, ' ').replace(/^\$\s*/, ''));
  if (/^(npx|uvx|uv|docker|node|python3?|bunx|pnpm|deno)$/.test(words[0] ?? '')) {
    const d = emptyDraft('stdio');
    d.command = words[0]!;
    d.args = joinArgs(words.slice(1));
    return named({ servers: [d], notes });
  }
  // ИМЯ=значение перед командой — переменные окружения
  const envPrefix: KV[] = [];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) { const w = words.shift()!; const c = w.indexOf('='); envPrefix.push({ name: w.slice(0, c), value: w.slice(c + 1) }); }
  if (envPrefix.length && words[0]) {
    const d = emptyDraft('stdio');
    d.command = words[0];
    d.args = joinArgs(words.slice(1));
    d.env = envPrefix;
    return named({ servers: [d], notes });
  }
  return { servers: [], notes, error: 'не понял формат: вставьте JSON из документации сервера, команду «claude mcp add …», адрес https://… или строку запуска npx/uvx/docker' };
}

/** Безымянным — имя из адреса или пакета. */
function named(r: PasteResult): PasteResult {
  for (const d of r.servers) {
    if (d.name && NAME_RE.test(d.name)) continue;
    if (d.name) { d.name = sanitizeName(d.name); continue; }
    if (d.type !== 'stdio') d.name = nameFromUrl(d.url);
    else {
      const args = splitArgs(d.args);
      const pkg = d.command === 'docker' ? args.filter((a) => !a.startsWith('-')).pop() : args.find((a) => !a.startsWith('-'));
      d.name = nameFromPackage(pkg ?? d.command);
    }
  }
  return r;
}

// ─── Шаблон каталога ────────────────────────────────────────────────────────

const REF = /\{\{([^{}]+)\}\}/g;

function refs(s: string): string[] {
  return [...s.matchAll(REF)].map((m) => m[1]!).filter((k) => `{{${k}}}` !== ACCOUNT_KEY);
}

/** Значение поля: введённое или по умолчанию. */
function valueOf(f: McpField | undefined, values: Record<string, string>): string {
  const v = (f ? values[f.key] : undefined)?.trim() ?? '';
  return v || f?.default || '';
}

/** Заполнить шаблон: обязательные поля — проверка; пустые необязательные убирают свой заголовок/переменную/аргумент. */
export function fillTemplate(t: McpTemplate, fields: McpField[], values: Record<string, string>): McpConfig | string {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const f of fields) if (f.required && !valueOf(f, values)) return `заполните «${f.label}»`;
  const sub = (s: string) => s.replace(REF, (m, k: string) => (m === ACCOUNT_KEY ? m : valueOf(byKey.get(k), values)));
  const filled = (s: string) => refs(s).every((k) => valueOf(byKey.get(k), values) !== '');
  const pairs = (list: { name: string; value: string }[] | undefined) => {
    const o: Record<string, string> = {};
    for (const p of list ?? []) if (filled(p.value)) o[p.name] = sub(p.value);
    return o;
  };
  if (t.type === 'stdio') {
    const args: string[] = [];
    for (const a of t.args ?? []) {
      if (a.field && !valueOf(byKey.get(a.field), values)) continue;
      args.push(...a.tokens.map(sub));
    }
    const env = pairs(t.env);
    return { type: 'stdio', command: t.command ?? '', ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
  }
  const url = sub(t.url ?? '');
  if (!/^https?:\/\/[^\s/]+\S*$/.test(url)) return 'адрес сервера получился неполным — заполните поля адреса';
  const headers = pairs(t.headers);
  return { type: t.type, url, ...(Object.keys(headers).length ? { headers } : {}) };
}

/** Что увидит человек перед установкой: адрес или строка запуска; секретные поля — точками. */
export function previewTemplate(t: McpTemplate, fields: McpField[], values: Record<string, string>): string {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const show = (s: string) => s.replace(REF, (m, k: string) => {
    if (m === ACCOUNT_KEY) return '‹ключ аккаунта›';
    const f = byKey.get(k);
    const v = valueOf(f, values);
    return !v ? `‹${f?.label ?? k}›` : f?.secret ? '•••' : v;
  });
  if (t.type !== 'stdio') return show(t.url ?? '');
  const toks = [t.command ?? ''];
  for (const a of t.args ?? []) {
    if (a.field && !valueOf(byKey.get(a.field), values)) continue;
    toks.push(...a.tokens.map(show));
  }
  return joinArgs(toks).replace(/"(‹[^›]*›)"/g, '$1');
}

/**
 * Можно ли предложить ключ аккаунта: HTTP — только серверу домена шлюза (как проверяет и supervisor), команда —
 * да (процесс на своём сервере; решает человек). Каталог для команд ключ не предлагает — там чужие пакеты.
 */
export function accountKeyFits(gatewayHost: string | undefined, target: { type: McpDraft['type']; url?: string }): boolean {
  if (!gatewayHost) return false;
  if (target.type === 'stdio') return true;
  try {
    const dom = (h: string) => h.toLowerCase().split('.').slice(-2).join('.');
    return dom(new URL(target.url ?? '').hostname) === dom(gatewayHost);
  } catch { return false; }
}

/** Подставить в значение метку ключа аккаунта: «Bearer xxx» → «Bearer {{account-key}}». */
export function withAccountKeyMark(header: string, value: string): string {
  const m = /^(bearer|token|basic)\s+/i.exec(value.trim());
  if (m) return `${m[0]}${ACCOUNT_KEY}`;
  if (/^authorization$/i.test(header)) return `Bearer ${ACCOUNT_KEY}`;
  return ACCOUNT_KEY;
}
