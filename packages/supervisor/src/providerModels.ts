// Список моделей аккаунта у провайдера: GET {ANTHROPIC_BASE_URL}/v1/models — Anthropic и совместимые шлюзы (z.ai).
// Настоящие id (claude-opus-5-5, glm-5.3) идут в Claude Code через --model как есть — без псевдонимов opus/sonnet,
// которые Claude Code подменяет сам (отсюда были «1211 Unknown Model» у z.ai и «Opus» без версии).
// Ответ: data[] { id, display_name, max_input_tokens?, capabilities? }, страницы — has_more + last_id → after_id.
// Авторизация: ANTHROPIC_API_KEY → x-api-key, ANTHROPIC_AUTH_TOKEN → Bearer, токен подписки → Bearer + бета oauth.
// Ключ не логируется и в ошибки не попадает.

import { EffortLevelSchema, type EffortLevel, type ModelInfoFrame } from '@perimeter/protocol';

const EFFORT_LEVELS: readonly EffortLevel[] = EffortLevelSchema.options;

export const ANTHROPIC_API = 'https://api.anthropic.com';

export interface ProviderAccess {
  baseUrl: string;
  kind: 'x-api-key' | 'bearer' | 'oauth';
  key: string;
}

/**
 * Как спросить провайдера, по окружению аккаунта (env профиля + settings.json Claude Code): есть ключ — доступ,
 * нет (подписка через `claude auth login`, креды в файле Claude Code) — null: список даст сам Claude Code.
 */
export function providerAccess(env: Record<string, string | undefined>): ProviderAccess | null {
  const baseUrl = (env['ANTHROPIC_BASE_URL'] || ANTHROPIC_API).replace(/\/+$/, '');
  if (env['ANTHROPIC_API_KEY'] && !env['ANTHROPIC_AUTH_TOKEN']) return { baseUrl, kind: 'x-api-key', key: env['ANTHROPIC_API_KEY'] };
  if (env['ANTHROPIC_AUTH_TOKEN']) return { baseUrl, kind: 'bearer', key: env['ANTHROPIC_AUTH_TOKEN'] };
  if (env['CLAUDE_CODE_OAUTH_TOKEN']) return { baseUrl, kind: 'oauth', key: env['CLAUDE_CODE_OAUTH_TOKEN'] };
  return null;
}

export function providerHeaders(a: ProviderAccess): Record<string, string> {
  const h: Record<string, string> = { 'anthropic-version': '2023-06-01', accept: 'application/json' };
  if (a.kind === 'x-api-key') h['x-api-key'] = a.key;
  else h['authorization'] = `Bearer ${a.key}`;
  if (a.kind === 'oauth') h['anthropic-beta'] = 'oauth-2025-04-20';
  return h;
}

interface RawModel {
  id?: unknown;
  display_name?: unknown;
  max_input_tokens?: unknown;
  capabilities?: { effort?: Record<string, { supported?: unknown } | unknown> & { supported?: unknown } };
}

/** Уровни усилия из capabilities.effort (лист supported у каждого уровня); нет сведений — пусто. */
function effortsOf(m: RawModel): EffortLevel[] {
  const e = m.capabilities?.effort;
  if (!e || e.supported !== true) return [];
  return EFFORT_LEVELS.filter((l) => (e[l] as { supported?: unknown } | undefined)?.supported === true);
}

/** Запись /v1/models → модель для клиента: id как есть, название провайдера — пояснением. */
export function toModel(m: RawModel): ModelInfoFrame | null {
  if (typeof m.id !== 'string' || !m.id.trim()) return null;
  const name = typeof m.display_name === 'string' && m.display_name.trim() && m.display_name !== m.id ? m.display_name.trim() : undefined;
  const ctx = typeof m.max_input_tokens === 'number' && Number.isInteger(m.max_input_tokens) && m.max_input_tokens > 0 ? m.max_input_tokens : undefined;
  return {
    id: m.id.trim(),
    ...(name ? { description: name.slice(0, 200) } : {}),
    efforts: effortsOf(m),
    ...(ctx ? { ctx } : {}),
  };
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Модели провайдера (до 5 страниц по 1000). Ошибка сети/HTTP — исключение с кодом, без ключа в тексте. */
export async function fetchProviderModels(a: ProviderAccess, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 15_000): Promise<ModelInfoFrame[]> {
  const out: ModelInfoFrame[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const url = `${a.baseUrl}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let body: { data?: unknown; has_more?: unknown; last_id?: unknown };
    try {
      const r = await fetchImpl(url, { headers: providerHeaders(a), signal: ctl.signal });
      if (!r.ok) throw new Error(`провайдер ответил ${r.status}${r.status === 404 ? ' — списка моделей у него нет' : r.status === 401 || r.status === 403 ? ' — ключ не подходит для списка моделей' : ''}`);
      body = (await r.json()) as typeof body;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw new Error(`провайдер не ответил за ${Math.round(timeoutMs / 1000)} с`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(body.data)) throw new Error('ответ провайдера не похож на список моделей');
    for (const raw of body.data as RawModel[]) {
      const m = toModel(raw);
      if (m && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
    if (body.has_more !== true || typeof body.last_id !== 'string') break;
    after = body.last_id;
  }
  if (out.length === 0) throw new Error('провайдер вернул пустой список моделей');
  return out;
}
