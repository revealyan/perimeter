// Модели, усилие и ultracode аккаунта — что показывать в поле ввода и настройках. Чистые функции без React.
import { CTX_MAX, CTX_MIN, customModelId, parseCustomModelId, type CustomModel, type EffortLevel } from '@perimeter/protocol';

export type { CustomModel, EffortLevel };

export interface ModelChoice {
  id: string;
  label?: string;
  /** пояснение под названием (как в Claude Code Desktop) */
  description?: string;
  /** уровни усилия; пусто — усилие у модели не настраивается; undefined — неизвестно */
  efforts?: EffortLevel[];
  /** окно контекста по данным провайдера (у своей модели — её окно) */
  ctx?: number;
  /** своя модель аккаунта (база + окно контекста) */
  custom?: boolean;
}

export interface ProfileLike {
  name: string;
  model?: string;
  models?: ModelChoice[];
  modelsSource?: 'auto' | 'manual';
  defaultEffort?: EffortLevel;
  ultracode?: boolean;
  /** модели с контекстом 1M */
  long?: string[];
  /** свои модели: база + окно контекста */
  custom?: CustomModel[];
}

/** id без суффикса [1m]: сессия может знать модель так, как её запустили. */
export function baseModelId(id: string): string {
  return id.replace(/\[1m\]$/i, '');
}

/** Контекст 1M у модели аккаунта: включён настройкой или задан в самом id (старые ручные списки). Своя модель — нет: окно в её названии. */
export function isLong(p: ProfileLike | undefined, id: string): boolean {
  if (parseCustomModelId(id)) return false;
  return /\[1m\]$/i.test(id) || (p?.long ?? []).includes(baseModelId(id));
}

/** «1M», «200K» — окно контекста коротко. */
export function ctxLabel(n: number | undefined): string {
  if (!n) return '';
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

export const EFFORT_ORDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'низкое',
  medium: 'среднее',
  high: 'высокое',
  xhigh: 'очень высокое',
  max: 'максимальное',
};

/** Подсказки для аккаунтов, у которых список моделей ещё не получен (старый supervisor). */
const MODEL_HINTS: Record<string, string[]> = {
  zai: ['glm-5.3', 'glm-5.3-flash'],
};
const COMMON_MODELS = ['sonnet', 'opus', 'haiku'];

/** Подпись своей модели: заданная или «база · окно». */
export function customLabel(c: { base: string; ctx: number; label?: string }): string {
  return c.label?.trim() || `${c.base} · ${ctxLabel(c.ctx)}`;
}

function customChoice(p: ProfileLike | undefined, c: { id: string; base: string; ctx: number; label?: string }): ModelChoice {
  const base = p?.models?.find((m) => m.id.toLowerCase() === c.base.toLowerCase());
  return {
    id: c.id,
    label: customLabel(c),
    description: `своя · ${c.base} · окно ${ctxLabel(c.ctx)}`,
    ...(base?.efforts !== undefined ? { efforts: base.efforts } : {}),
    ctx: c.ctx,
    custom: true,
  };
}

/** Свои модели аккаунта как пункты выбора; усилия — как у базы. */
export function customChoices(p: ProfileLike | undefined): ModelChoice[] {
  return (p?.custom ?? []).map((c) => customChoice(p, c));
}

/** Что предлагать в выборе модели: свои модели, затем список аккаунта, иначе подсказки (без сведений об усилии). */
export function modelChoices(p: ProfileLike): ModelChoice[] {
  const custom = customChoices(p);
  if (p.models && p.models.length > 0) return [...custom, ...p.models];
  const ids = MODEL_HINTS[p.name] ?? [...(p.model ? [p.model] : []), ...COMMON_MODELS];
  return [...custom, ...[...new Set(ids)].map((id) => ({ id }))];
}

/** Своя модель: база + окно в K (100–1000) + подпись; null — не так заполнено или такая уже есть. */
export function addCustomModel(list: CustomModel[], base: string, ctxK: number, label: string): CustomModel[] | null {
  const b = base.trim();
  if (b === '' || /\s/.test(b) || b.includes('@')) return null;
  if (!Number.isFinite(ctxK)) return null;
  const ctx = Math.round(ctxK) * 1000;
  if (ctx < CTX_MIN || ctx > CTX_MAX) return null;
  const id = customModelId(b, ctx);
  if (list.some((c) => c.id === id)) return null;
  const l = label.trim();
  return [...list, { id, base: b, ctx, ...(l ? { label: l } : {}) }];
}

/**
 * Модель сессии в списке аккаунта. Сессия может знать полный id (claude-sonnet-5-5),
 * а список — псевдоним (sonnet): короткий псевдоним без дефисов ищем внутри полного id.
 */
export function findModel(p: ProfileLike | undefined, modelId: string | undefined): ModelChoice | undefined {
  if (!modelId) return undefined;
  // своя модель узнаётся и по id (`glm-5.3@400k`), даже если из аккаунта её уже убрали
  const c = parseCustomModelId(modelId);
  if (c) return customChoice(p, p?.custom?.find((x) => x.id === modelId) ?? { id: modelId, ...c });
  if (!p?.models) return undefined;
  const id = baseModelId(modelId).toLowerCase();
  return p.models.find((m) => m.id.toLowerCase() === id)
    ?? p.models.find((m) => !m.id.includes('-') && !m.id.includes('[') && id.includes(m.id.toLowerCase()));
}

/** Уровни усилия для модели сессии (по порядку); пусто — выбора усилия нет. */
export function effortsFor(p: ProfileLike | undefined, modelId: string | undefined): EffortLevel[] {
  const m = findModel(p, modelId ?? p?.model);
  const list = m?.efforts ?? [];
  return EFFORT_ORDER.filter((e) => list.includes(e));
}

/** Разрешён ли ultracode аккаунту (по умолчанию да; профиль без сведений — да). */
export function ultracodeAllowed(p: ProfileLike | undefined): boolean {
  return p?.ultracode !== false;
}

/** Усилие, с которым пойдёт ход: явное у сессии → по умолчанию аккаунта → null (решает модель). */
export function effectiveEffort(sessionEffort: EffortLevel | undefined, p: ProfileLike | undefined, available: EffortLevel[]): EffortLevel | null {
  const e = sessionEffort ?? p?.defaultEffort;
  return e !== undefined && available.includes(e) ? e : null;
}

/** Диапазон уровней коротко: «низкое → максимальное», один уровень — он сам, пусто — «без усилия». */
export function effortRange(efforts: EffortLevel[] | undefined): string {
  const list = EFFORT_ORDER.filter((e) => (efforts ?? []).includes(e));
  if (list.length === 0) return 'без усилия';
  if (list.length === 1) return EFFORT_LABEL[list[0]!];
  return `${EFFORT_LABEL[list[0]!]} → ${EFFORT_LABEL[list[list.length - 1]!]}`;
}

/** Ручной список: добавить модель (без дублей, обрезка пробелов); null — нечего добавлять. */
export function addManualModel(list: ModelChoice[], raw: string): ModelChoice[] | null {
  const id = raw.trim();
  if (id === '' || /\s/.test(id)) return null;
  if (list.some((m) => m.id.toLowerCase() === id.toLowerCase())) return null;
  return [...list, { id, efforts: [] }];
}
