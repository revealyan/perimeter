// Лимиты аккаунта (usage), как /usage в Claude Code Desktop.
//
// Источники (проверено 23.11):
// - подписка Claude: Claude Code шлёт в поток rate_limit_event с окнами (unifiedWindows: five_hour, seven_day…,
//   utilization — доля 0–1, resetsAt — секунды) — из заголовков anthropic-ratelimit-unified-* ответов API; так
//   работает и для входа токеном (setup-token), у которого /usage (SDK usage_EXPERIMENTAL) недоступен
//   (rate_limits_available=false — нет области профиля). Для входа через браузер /usage отвечает и без хода.
// - z.ai (GLM Coding Plan): GET <домен>/api/monitor/usage/quota/limit, Authorization: <ключ> (как официальный плагин
//   glm-plan-usage); с осени 2026 — кредиты: CREDIT_LIMIT с unit/number окна (3/5 — 5 часов, 6/1 — неделя),
//   percentage 0–100, usage — лимит, currentValue — израсходовано, nextResetTime — мс.
import type { UsageInfo, UsageWindow } from '@perimeter/protocol';

const CLAUDE_LABELS: Record<string, string> = {
  five_hour: '5 часов',
  seven_day: 'неделя',
  seven_day_opus: 'неделя · Opus',
  seven_day_sonnet: 'неделя · Sonnet',
  seven_day_oauth_apps: 'неделя · приложения',
  seven_day_overage_included: 'неделя · сверх лимита',
};
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
const byOrder = (a: UsageWindow, b: UsageWindow) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clampPct = (p: number) => Math.max(0, Math.min(100, Math.round(p * 10) / 10));

/** rate_limit_event Claude Code → окна. Нечего взять — null. */
export function usageFromRateLimit(info: unknown, at = Date.now()): UsageInfo | null {
  if (typeof info !== 'object' || info === null) return null;
  const i = info as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  const uw = i['unifiedWindows'];
  if (typeof uw === 'object' && uw !== null) {
    for (const [id, w] of Object.entries(uw as Record<string, Record<string, unknown>>)) {
      const u = num(w?.['utilization']);
      if (u === undefined) continue;
      const reset = num(w['resetsAt']);
      windows.push({
        id, label: CLAUDE_LABELS[id] ?? id, pct: clampPct(u * 100),
        ...(reset !== undefined ? { resetsAt: reset * 1000 } : {}),
        ...(typeof w['status'] === 'string' ? { status: w['status'] } : {}),
      });
    }
  } else {
    // старая форма: одно окно — rateLimitType + utilization
    const id = typeof i['rateLimitType'] === 'string' ? i['rateLimitType'] : undefined;
    const u = num(i['utilization']);
    if (id && u !== undefined) {
      const reset = num(i['resetsAt']);
      windows.push({ id, label: CLAUDE_LABELS[id] ?? id, pct: clampPct(u <= 1 ? u * 100 : u), ...(reset !== undefined ? { resetsAt: reset * 1000 } : {}), ...(typeof i['status'] === 'string' ? { status: i['status'] } : {}) });
    }
  }
  if (windows.length === 0) return null;
  return { source: 'claude', windows: windows.sort(byOrder), at };
}

/** Ответ /usage (SDK usage_EXPERIMENTAL) → окна; лимиты недоступны — null. */
export function usageFromUsageApi(r: unknown, at = Date.now()): UsageInfo | null {
  if (typeof r !== 'object' || r === null) return null;
  const o = r as { rate_limits_available?: unknown; rate_limits?: Record<string, unknown> | null; subscription_type?: unknown };
  if (o.rate_limits_available !== true || !o.rate_limits) return null;
  const windows: UsageWindow[] = [];
  for (const [id, w] of Object.entries(o.rate_limits)) {
    if (id === 'model_scoped' && Array.isArray(w)) {
      for (const m of w as Array<Record<string, unknown>>) {
        const u = num(m['utilization']);
        if (u === undefined) continue;
        const reset = typeof m['resets_at'] === 'string' ? Date.parse(m['resets_at']) : NaN;
        windows.push({ id: `model:${String(m['display_name'])}`, label: `неделя · ${String(m['display_name'])}`, pct: clampPct(u), ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) });
      }
      continue;
    }
    if (typeof w !== 'object' || w === null || !(id in CLAUDE_LABELS)) continue;
    const u = num((w as Record<string, unknown>)['utilization']);
    if (u === undefined) continue;
    const rs = (w as Record<string, unknown>)['resets_at'];
    const reset = typeof rs === 'string' ? Date.parse(rs) : NaN;
    windows.push({ id, label: CLAUDE_LABELS[id]!, pct: clampPct(u), ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) });
  }
  if (windows.length === 0) return null;
  return { source: 'claude', ...(typeof o.subscription_type === 'string' ? { plan: o.subscription_type } : {}), windows: windows.sort(byOrder), at };
}

/** unit z.ai → подпись окна (по живому ответу 23.11: 3 — часы, 6 — недели; остальное — по смыслу шкалы). */
function zaiWindowLabel(unit: number | undefined, n: number | undefined): string | null {
  if (unit === undefined || n === undefined) return null;
  switch (unit) {
    case 3: return n === 1 ? 'час' : `${n} ${n >= 2 && n <= 4 ? 'часа' : 'часов'}`;
    case 4: return n === 1 ? 'сутки' : `${n} дн.`;
    case 5: return n === 1 ? 'месяц' : `${n} мес.`;
    case 6: return n === 1 ? 'неделя' : `${n} нед.`;
    default: return null;
  }
}

/** Ответ quota/limit z.ai → окна. */
export function usageFromZai(body: unknown, at = Date.now()): UsageInfo | null {
  const d = (body as { data?: { limits?: unknown; level?: unknown } } | null)?.data;
  if (!d || !Array.isArray(d.limits)) return null;
  const windows: UsageWindow[] = [];
  d.limits.forEach((raw, idx) => {
    const l = raw as Record<string, unknown>;
    const pct = num(l['percentage']);
    if (pct === undefined) return;
    const type = String(l['type'] ?? '');
    const unit = num(l['unit']);
    const n = num(l['number']);
    const span = zaiWindowLabel(unit, n);
    const label = type === 'TIME_LIMIT' ? `MCP${span ? ` · ${span}` : ''}` : span ?? (type === 'TOKENS_LIMIT' ? 'токены' : type.toLowerCase());
    const reset = num(l['nextResetTime']);
    const limit = num(l['usage']);
    const used = num(l['currentValue']);
    windows.push({
      id: `zai:${type}:${unit ?? ''}:${n ?? idx}`, label, pct: clampPct(pct),
      ...(reset !== undefined && reset > 0 ? { resetsAt: reset } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  });
  if (windows.length === 0) return null;
  // короткое окно первым
  windows.sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity));
  return { source: 'zai', ...(typeof d.level === 'string' && d.level ? { plan: d.level } : {}), windows, at };
}

/** Хост шлюза z.ai / Zhipu — у них есть квота. */
export const isZaiHost = (host: string | undefined): boolean => host !== undefined && /(^|\.)(z\.ai|bigmodel\.cn)$/i.test(host);

/** Квота z.ai: GET quota/limit с ключом аккаунта (без Bearer — как официальный плагин). */
export async function fetchZaiUsage(baseUrl: string, key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<UsageInfo> {
  const url = `${new URL(baseUrl).origin}/api/monitor/usage/quota/limit`;
  const r = await fetchImpl(url, { headers: { Authorization: key, 'Accept-Language': 'en-US,en' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`z.ai ответил ${r.status}`);
  const body = await r.json() as { success?: boolean; msg?: string };
  const u = usageFromZai(body);
  if (!u) throw new Error(body.msg ? `z.ai: ${body.msg}` : 'z.ai не прислал лимиты');
  return u;
}
