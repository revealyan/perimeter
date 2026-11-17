// Вкладка «Браузер»: адресная строка с историей внутри панели, разбор ввода («5173», «:3000/x»,
// «localhost:5173»), выбор, как открыть превью (VPS — через ssh-туннель, этот компьютер — напрямую),
// подсказки портов из net.ports. Чистые функции.
import type { EnvId } from '../supervisor';
import type { PortInfo } from './panelData';

// ─── история ────────────────────────────────────────────────────────────────

export interface BrowserHistory { list: string[]; index: number }
export const EMPTY_HISTORY: BrowserHistory = { list: [], index: -1 };
const HISTORY_MAX = 50;

export function currentUrl(h: BrowserHistory): string | null {
  return h.list[h.index] ?? null;
}

/** Переход: всё «вперёд» отбрасывается; повтор текущего адреса историю не растит. */
export function navigate(h: BrowserHistory, url: string): BrowserHistory {
  if (currentUrl(h) === url) return h;
  const list = [...h.list.slice(0, h.index + 1), url].slice(-HISTORY_MAX);
  return { list, index: list.length - 1 };
}

export const canBack = (h: BrowserHistory): boolean => h.index > 0;
export const canForward = (h: BrowserHistory): boolean => h.index < h.list.length - 1;
export const back = (h: BrowserHistory): BrowserHistory => (canBack(h) ? { ...h, index: h.index - 1 } : h);
export const forward = (h: BrowserHistory): BrowserHistory => (canForward(h) ? { ...h, index: h.index + 1 } : h);

export type Device = 'desktop' | 'phone';
export interface BrowserState { history: BrowserHistory; device: Device }
export const BROWSER_DEFAULT: BrowserState = { history: EMPTY_HISTORY, device: 'desktop' };

/** Состояние из localStorage — с проверкой формы (битое → по умолчанию). */
export function normalizeBrowserState(raw: unknown): BrowserState {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const h = typeof o['history'] === 'object' && o['history'] !== null ? (o['history'] as Record<string, unknown>) : {};
  const list = Array.isArray(h['list']) ? (h['list'] as unknown[]).filter((u): u is string => typeof u === 'string').slice(-HISTORY_MAX) : [];
  const idx = typeof h['index'] === 'number' ? Math.trunc(h['index']) : list.length - 1;
  return {
    history: { list, index: list.length === 0 ? -1 : Math.max(0, Math.min(idx, list.length - 1)) },
    device: o['device'] === 'phone' ? 'phone' : 'desktop',
  };
}

// ─── адрес ──────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);
export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || host.toLowerCase().endsWith('.localhost');
}

/**
 * Ввод адресной строки → URL. «5173» и «:5173/x» — порт на машине сессии (localhost),
 * «localhost:3000» без схемы — http, прочие домены без схемы — https. null — не похоже на адрес.
 */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  let candidate: string;
  const port = /^:?(\d{1,5})(\/.*)?$/.exec(s);
  if (port) {
    const n = Number(port[1]);
    if (n < 1 || n > 65535) return null;
    candidate = `http://localhost:${n}${port[2] ?? '/'}`;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) candidate = s;
  else {
    const host = s.split(/[/:?#]/)[0] ?? '';
    if (!host || /\s/.test(s)) return null;
    candidate = `${isLoopback(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'http' : 'https'}://${s}`;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Адрес для показа: без «http://» и без одинокого «/» в конце. */
export function displayUrl(url: string): string {
  return url.replace(/^http:\/\//, '').replace(/^([^/?#]+)\/$/, '$1');
}

/** Порт адреса (явный или по схеме). */
export function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

export type PreviewPlan =
  | { kind: 'forward'; port: number }
  | { kind: 'direct'; reason: 'local' | 'external' | 'no-tunnel' };

/**
 * Как открыть превью. Порт машины сессии на VPS — через проброс ssh (если клиент умеет — Electron);
 * без Electron (браузер-стенд) и на этом компьютере — напрямую; внешний адрес — как есть.
 */
export function previewPlan(url: string, env: EnvId, canForward: boolean): PreviewPlan {
  let u: URL;
  try { u = new URL(url); } catch { return { kind: 'direct', reason: 'external' }; }
  if (!isLoopback(u.hostname)) return { kind: 'direct', reason: 'external' };
  if (env === 'local') return { kind: 'direct', reason: 'local' };
  if (!canForward) return { kind: 'direct', reason: 'no-tunnel' };
  return { kind: 'forward', port: portOf(url) ?? 80 };
}

/** Тот же путь/запрос/якорь, но на другом происхождении (проброшенный локальный порт). */
export function rebase(url: string, base: string): string {
  try {
    const u = new URL(url);
    const b = new URL(base);
    return `${b.origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

// ─── подсказки портов ───────────────────────────────────────────────────────

const DEV_PROC = /^(node|nodejs|vite|next|nuxt|astro|bun|deno|python\d*(\.\d+)?|py|uvicorn|gunicorn|flask|django|ruby|rails|puma|php|php-fpm|java|dotnet|go|air|cargo|webpack|esbuild|http-server|serve|caddy|nginx)$/i;

/** Имя процесса для чипа: без пути и .exe. */
export function procName(p: string | undefined): string {
  return ((p ?? '').split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '');
}

/**
 * Порты для чипов «:5173 · vite»: без дублей (IPv4/IPv6), без системных (<1024, кроме 80), исключённых
 * (порт самого supervisor'а) и явно не dev-серверов (известен процесс, и он не похож на dev: svchost, steam…).
 */
export function portSuggestions(ports: PortInfo[], exclude: number[] = [], limit = 6): PortInfo[] {
  const by = new Map<number, PortInfo>();
  for (const p of ports) {
    if ((p.port < 1024 && p.port !== 80) || exclude.includes(p.port)) continue;
    if (p.process && !DEV_PROC.test(procName(p.process))) continue;
    const cur = by.get(p.port);
    if (!cur || (!cur.process && p.process)) by.set(p.port, p);
  }
  return [...by.values()]
    .sort((a, b) => (a.process ? 0 : 1) - (b.process ? 0 : 1) || a.port - b.port)
    .slice(0, limit);
}
