// Каталог MCP-серверов — официальный реестр (registry.modelcontextprotocol.io, его ведут авторы протокола MCP).
// Поиск + разбор записи в «варианты установки»: шаблон конфига Claude Code и поля, которые заполняет человек
// (ключи, адреса, пути). Шаблон заполняет клиент и шлёт обычный cmd:mcp.add — отдельной установки нет.
//
// Поиск реестра — подстрока в имени и сортировка по алфавиту: «github» совпадает с каждым io.github.*, а сервер
// самого сервиса тонет среди копий и обёрток. Поэтому два запроса («q» и «q/» — пространство имён автора) и свой
// порядок: автор = сервис, точное имя, заголовок, описание; обёртки Smithery (нужен их ключ) — ниже.
// Пространства имён реестр проверяет: io.github.<логин> — вход этим логином, com.notion — владение доменом.

import { accessSync, constants, existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

/** Поле, которое заполняет человек. */
export interface McpField {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  choices?: string[];
}

/** Шаблон конфига: «{{ключ}}» — значение поля; необязательное пустое поле убирает заголовок/переменную/аргумент. */
export interface McpTemplate {
  type: 'http' | 'sse' | 'stdio';
  url?: string;
  headers?: { name: string; value: string }[];
  command?: string;
  /** field — необязательный аргумент: без значения пропускается целиком (с именем флага) */
  args?: { tokens: string[]; field?: string }[];
  env?: { name: string; value: string }[];
}

export type McpVariantKind = 'remote' | 'npm' | 'pypi' | 'oci';

export interface McpVariant {
  id: string;
  kind: McpVariantKind;
  /** «HTTP · mcp.notion.com», «npm · @upstash/context7-mcp» */
  label: string;
  template: McpTemplate;
  fields: McpField[];
  /** чем запускается на сервере (у удалённых — ничем) */
  runtime?: 'npx' | 'uvx' | 'docker';
  /** почему нельзя поставить на этом сервере («нет npx») */
  missing?: string;
}

export interface McpCatalogEntry {
  /** имя в реестре: io.github.upstash/context7 */
  id: string;
  title: string;
  description: string;
  version: string;
  /** кто опубликовал: «notion.com», «github.com/upstash» */
  publisher: string;
  repo?: string;
  website?: string;
  /** имя для Claude Code: notion, context7 */
  suggestedName: string;
  variants: McpVariant[];
  /** запись реестра помечена устаревшей */
  deprecated?: boolean;
}

// ─── Записи реестра (схема server.json 2025-09…2025-12; читаем осторожно — поля необязательны) ──────────

interface RegInput {
  name?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  value?: string;
  valueHint?: string;
  choices?: string[];
  type?: string;
  variables?: Record<string, RegInput>;
}
interface RegServer {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  websiteUrl?: string;
  remotes?: { type?: string; url?: string; headers?: RegInput[]; variables?: Record<string, RegInput> }[];
  packages?: {
    registryType?: string;
    identifier?: string;
    version?: string;
    runtimeHint?: string;
    transport?: { type?: string };
    runtimeArguments?: RegInput[];
    packageArguments?: RegInput[];
    environmentVariables?: RegInput[];
  }[];
}
export interface RegItem {
  server?: RegServer;
  _meta?: Record<string, { status?: string } | undefined>;
}

const VAR_RE = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/** Собирает поля варианта: ключи уникальны, повтор переменной — то же поле. */
class FieldSet {
  readonly list: McpField[] = [];
  add(key: string, src: RegInput | undefined, fallback: { label?: string; secret?: boolean; required?: boolean } = {}): string {
    const k = key.replace(/[^A-Za-z0-9_.-]/g, '_') || 'value';
    if (this.list.some((f) => f.key === k)) return k;
    const description = src?.description?.trim();
    this.list.push({
      key: k,
      label: fallback.label ?? k,
      ...(description ? { description: description.slice(0, 300) } : {}),
      required: src?.isRequired ?? fallback.required ?? false,
      secret: src?.isSecret ?? fallback.secret ?? false,
      ...(src?.default !== undefined && src.default !== '' ? { default: String(src.default) } : {}),
      ...(Array.isArray(src?.choices) && src.choices.length ? { choices: src.choices.map(String).slice(0, 50) } : {}),
    });
    return k;
  }
}

/** «Bearer {api_key}» → «Bearer {{api_key}}» + поля; метаданные переменной — из variables, иначе от владельца. */
function templ(value: string, fields: FieldSet, vars: Record<string, RegInput> | undefined, owner: RegInput | undefined): string {
  return value.replace(VAR_RE, (_m, name: string) => {
    const meta = vars?.[name];
    const key = fields.add(name, meta ?? owner, { label: name, ...(owner?.isSecret !== undefined ? { secret: owner.isSecret } : {}), ...(owner?.isRequired !== undefined ? { required: owner.isRequired } : {}) });
    return `{{${key}}}`;
  });
}

/** Аргументы запуска (runtime/package) → элементы args шаблона. */
function argItems(list: RegInput[] | undefined, fields: FieldSet): { tokens: string[]; field?: string }[] {
  const out: { tokens: string[]; field?: string }[] = [];
  for (const [i, a] of (list ?? []).entries()) {
    const named = a.type === 'named' && a.name;
    if (a.value !== undefined && a.value !== '') {
      const v = templ(String(a.value), fields, a.variables, a);
      out.push({ tokens: named ? [a.name!, v] : [v] });
      continue;
    }
    if (!a.valueHint && a.default === undefined && named) {
      // флаг без значения: обязательный — ставим, необязательный — нет
      if (a.isRequired) out.push({ tokens: [a.name!] });
      continue;
    }
    const label = a.valueHint || (named ? a.name!.replace(/^-+/, '') : `аргумент ${i + 1}`);
    const key = fields.add(named ? a.name!.replace(/^-+/, '') : a.valueHint || `arg${i + 1}`, a, { label });
    const tokens = named ? [a.name!, `{{${key}}}`] : [`{{${key}}}`];
    out.push(a.isRequired ? { tokens } : { tokens, field: key });
  }
  return out;
}

function hostOf(url: string): string {
  try { return new URL(url.replace(VAR_RE, 'x')).host; } catch { return url.slice(0, 60); }
}

/** Варианты установки записи; неподдержанные (mcpb, nuget, пакет с HTTP-транспортом) пропускаются. */
export function variantsOf(s: RegServer, has: (cmd: string) => boolean = () => true): McpVariant[] {
  const out: McpVariant[] = [];
  for (const [i, r] of (s.remotes ?? []).entries()) {
    const t = r.type === 'sse' ? 'sse' : r.type === 'streamable-http' || r.type === 'http' ? 'http' : null;
    if (!t || !r.url) continue;
    const fields = new FieldSet();
    const url = templ(r.url, fields, r.variables, { isRequired: true }); // переменная адреса без значения — битый адрес
    const headers: { name: string; value: string }[] = [];
    for (const h of r.headers ?? []) {
      if (!h.name) continue;
      if (h.value !== undefined && h.value !== '') headers.push({ name: h.name, value: templ(String(h.value), fields, h.variables, h) });
      else headers.push({ name: h.name, value: `{{${fields.add(h.name, h, { label: h.name })}}}` });
    }
    out.push({
      id: `remote-${i}`, kind: 'remote', label: `${t === 'sse' ? 'SSE' : 'HTTP'} · ${hostOf(r.url)}`,
      template: { type: t, url, ...(headers.length ? { headers } : {}) },
      fields: fields.list,
    });
  }
  for (const [i, p] of (s.packages ?? []).entries()) {
    const reg = p.registryType;
    if ((p.transport?.type ?? 'stdio') !== 'stdio' || !p.identifier) continue;
    const kind: McpVariantKind | null = reg === 'npm' ? 'npm' : reg === 'pypi' ? 'pypi' : reg === 'oci' ? 'oci' : null;
    if (!kind) continue;
    const fields = new FieldSet();
    const env: { name: string; value: string }[] = [];
    for (const e of p.environmentVariables ?? []) {
      if (!e.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)) continue;
      if (e.value !== undefined && e.value !== '') env.push({ name: e.name, value: templ(String(e.value), fields, e.variables, e) });
      else env.push({ name: e.name, value: `{{${fields.add(e.name, e, { label: e.name })}}}` });
    }
    const runtimeArgs = argItems(p.runtimeArguments, fields);
    const pkgArgs = argItems(p.packageArguments, fields);
    const ver = p.version && p.version !== 'latest' ? p.version : '';
    let runtime: 'npx' | 'uvx' | 'docker';
    let args: { tokens: string[]; field?: string }[];
    if (kind === 'npm') {
      runtime = 'npx';
      const hasY = runtimeArgs.some((a) => a.tokens.includes('-y') || a.tokens.includes('--yes'));
      args = [...(hasY ? [] : [{ tokens: ['-y'] }]), ...runtimeArgs, { tokens: [ver ? `${p.identifier}@${ver}` : p.identifier] }, ...pkgArgs];
    } else if (kind === 'pypi') {
      runtime = 'uvx';
      args = [...runtimeArgs, { tokens: [ver ? `${p.identifier}==${ver}` : p.identifier] }, ...pkgArgs];
    } else {
      runtime = 'docker';
      const tagged = /:[^/]+$/.test(p.identifier) || p.identifier.includes('@sha256:');
      const image = tagged || !ver ? p.identifier : `${p.identifier}:${ver}`;
      const hasRun = runtimeArgs.some((a) => a.tokens[0] === 'run');
      // переменные Claude Code передаёт процессу docker — внутрь контейнера их пробрасывает -e ИМЯ
      args = [...(hasRun ? [] : [{ tokens: ['run', '-i', '--rm'] }]), ...runtimeArgs, ...env.map((e) => ({ tokens: ['-e', e.name] })), { tokens: [image] }, ...pkgArgs];
    }
    const label = kind === 'npm' ? 'npm' : kind === 'pypi' ? 'PyPI' : 'Docker';
    const missing = has(runtime) ? undefined
      : runtime === 'npx' ? 'на сервере нет npx (Node.js)' : runtime === 'uvx' ? 'на сервере нет uvx (пакет uv)' : 'docker на сервере недоступен (нет или пользователь не в группе docker)';
    out.push({
      id: `${kind}-${i}`, kind, label: `${label} · ${p.identifier}`, runtime,
      template: { type: 'stdio', command: runtime, args, ...(env.length ? { env } : {}) },
      fields: fields.list,
      ...(missing ? { missing } : {}),
    });
  }
  return out;
}

const TLD = new Set(['com', 'io', 'ai', 'dev', 'app', 'net', 'org', 'co', 'mcp', 'www', 'so', 'sh', 'cloud', 'tech', 'xyz', 'me', 'uk', 'de', 'ru']);

/** Части имени: пространство автора, логин GitHub, «содержательные» метки домена, имя сервера. */
function nameParts(id: string): { ns: string; owner: string | null; labels: string[]; seg: string } {
  const slash = id.indexOf('/');
  const ns = (slash >= 0 ? id.slice(0, slash) : id).toLowerCase();
  const seg = (slash >= 0 ? id.slice(slash + 1) : '').toLowerCase();
  const owner = ns.startsWith('io.github.') ? ns.slice('io.github.'.length) : null;
  const labels = owner ? [owner] : ns.split('.').filter((l) => l && !TLD.has(l));
  return { ns, owner, labels, seg };
}

/** «github-mcp-server» → «github», «mcp» → «» */
function stripMcp(s: string): string {
  return s.replace(/^(mcp|server)[-_.]/, '').replace(/[-_.](mcp[-_.]server|mcp|server|mcp[-_.]?srv)$/, '').replace(/^mcp$/, '');
}

export function publisherOf(id: string): string {
  const { ns, owner } = nameParts(id);
  if (owner) return `github.com/${owner}`;
  return ns.split('.').reverse().join('.');
}

export function suggestName(id: string): string {
  const { labels, seg } = nameParts(id);
  const base = stripMcp(seg) || labels[labels.length - 1] || seg || 'mcp';
  const clean = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64);
  return /^[A-Za-z0-9]/.test(clean) ? clean : `mcp-${clean}`.slice(0, 64);
}

/** Насколько запись подходит под запрос; 0 — совпало только «io.github.» и т. п. */
export function scoreEntry(e: Pick<McpCatalogEntry, 'id' | 'title' | 'description' | 'variants' | 'deprecated'>, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const { ns, labels, seg } = nameParts(e.id);
  const segCore = stripMcp(seg);
  const title = e.title.toLowerCase();
  const desc = e.description.toLowerCase();
  const nameNoPrefix = `${labels.join('.')}/${seg}`;
  let total = 0;
  for (const w of words) {
    let s = 0;
    if (labels.includes(w)) s += 100; // сервер опубликовал сам сервис (com.notion, io.github.github)
    if (seg === w || segCore === w) s += 60;
    else if (seg.startsWith(w)) s += 30;
    else if (nameNoPrefix.includes(w)) s += 15;
    if (title === w) s += 30;
    else if (title.includes(w)) s += 15;
    if (desc.includes(w)) s += 5;
    if (s === 0) return 0; // каждое слово запроса должно где-то совпасть
    total += s;
  }
  if (ns === 'ai.smithery') total -= 40; // обёртки Smithery: нужен их ключ
  if (e.deprecated) total -= 50;
  if (e.variants.some((v) => v.kind === 'remote')) total += 3;
  if (e.variants.every((v) => v.missing)) total -= 10;
  return Math.max(total, 1);
}

/** Запись реестра → карточка каталога (null — поставить отсюда нечем). */
export function toEntry(item: RegItem, has?: (cmd: string) => boolean): McpCatalogEntry | null {
  const s = item.server;
  if (!s?.name) return null;
  const status = item._meta?.['io.modelcontextprotocol.registry/official']?.status;
  if (status === 'deleted') return null;
  const variants = variantsOf(s, has);
  if (!variants.length) return null;
  const seg = s.name.slice(s.name.indexOf('/') + 1);
  return {
    id: s.name,
    // без заголовка — имя сервера; «mcp»/«server» ничего не говорят — тогда имя для Claude Code (notion)
    title: (s.title?.trim() || (stripMcp(seg.toLowerCase()) ? seg : suggestName(s.name))).slice(0, 100),
    description: (s.description ?? '').trim().slice(0, 400),
    version: s.version ?? '',
    publisher: publisherOf(s.name),
    ...(s.repository?.url ? { repo: s.repository.url } : {}),
    ...(s.websiteUrl ? { website: s.websiteUrl } : {}),
    suggestedName: suggestName(s.name),
    variants,
    ...(status === 'deprecated' ? { deprecated: true } : {}),
  };
}

/** Есть ли команда в PATH supervisor'а (на Windows — с .cmd/.exe). */
export function hasCommand(cmd: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, platform = process.platform): boolean {
  const win = platform === 'win32';
  const exts = win ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = [...(env['PATH'] ?? env['Path'] ?? '').split(win ? ';' : ':').filter(Boolean), ...(win ? [] : ['/usr/bin', '/usr/local/bin'])];
  const join = win ? win32.join : posix.join;
  return dirs.some((d) => exts.some((x) => exists(join(d, cmd + x))));
}

/**
 * Можно ли запустить: команда есть в PATH; у docker ещё и доступ к демону (пользователь supervisor'а в группе docker) —
 * иначе вариант «Docker» встанет и упадёт при первой сессии.
 */
export function canRun(cmd: string): boolean {
  if (!hasCommand(cmd)) return false;
  if (cmd !== 'docker' || process.platform === 'win32') return true;
  const sock = (process.env['DOCKER_HOST'] ?? 'unix:///var/run/docker.sock').replace(/^unix:\/\//, '');
  if (/^[a-z]+:\/\//.test(sock)) return true; // удалённый демон — проверит сам docker
  try { accessSync(sock, constants.R_OK | constants.W_OK); return true; } catch { return false; }
}

export interface CatalogDeps {
  fetch?: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  has?: (cmd: string) => boolean;
  base?: string;
  now?: () => number;
}

export interface CatalogResult {
  entries: McpCatalogEntry[];
  /** нашлось, но поставить отсюда нечем (mcpb, nuget…) */
  skipped: number;
}

const cache = new Map<string, { at: number; res: CatalogResult }>();
const CACHE_MS = 10 * 60_000;

async function page(d: CatalogDeps, search: string, limit: number): Promise<RegItem[]> {
  const url = `${d.base ?? REGISTRY_URL}/v0/servers?search=${encodeURIComponent(search)}&limit=${limit}&version=latest`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await (d.fetch ?? fetch)(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`каталог ответил ${r.status}`);
    const j = (await r.json()) as { servers?: RegItem[] };
    return Array.isArray(j.servers) ? j.servers : [];
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error('каталог не ответил за 20 с');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Поиск по каталогу: до 30 записей, лучшие сверху. Пустой/короткий запрос — пусто. */
export async function searchCatalog(query: string, d: CatalogDeps = {}): Promise<CatalogResult> {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
  if (q.length < 2) return { entries: [], skipped: 0 };
  const now = (d.now ?? Date.now)();
  const hit = cache.get(q);
  if (hit && now - hit.at < CACHE_MS) return hit.res;
  // реестр ищет подстроку целиком — берём самое длинное слово, остальные проверяем сами
  const main = q.split(' ').sort((a, b) => b.length - a.length)[0]!;
  const [all, vendor] = await Promise.all([
    page(d, main, 100),
    /[/.]/.test(main) ? Promise.resolve([] as RegItem[]) : page(d, `${main}/`, 30).catch(() => [] as RegItem[]),
  ]);
  const seen = new Set<string>();
  const has = d.has ?? canRun;
  const runtimes = new Map<string, boolean>();
  const hasCached = (c: string) => { if (!runtimes.has(c)) runtimes.set(c, has(c)); return runtimes.get(c)!; };
  let skipped = 0;
  const scored: { e: McpCatalogEntry; s: number }[] = [];
  for (const item of [...vendor, ...all]) {
    const id = item.server?.name;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const e = toEntry(item, hasCached);
    const s = e ? scoreEntry(e, q) : scoreEntry({ id, title: item.server?.title ?? '', description: item.server?.description ?? '', variants: [{ id: '', kind: 'remote', label: '', template: { type: 'http' }, fields: [] }] }, q);
    if (s <= 0) continue;
    if (!e) { skipped += 1; continue; }
    scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || a.e.id.localeCompare(b.e.id));
  const res = { entries: scored.slice(0, 30).map((x) => x.e), skipped };
  cache.set(q, { at: now, res });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return res;
}

/** Только для тестов. */
export function clearCatalogCache(): void {
  cache.clear();
}
