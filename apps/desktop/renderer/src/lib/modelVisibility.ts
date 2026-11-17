// Видимость моделей в выборе (как в Claude Desktop): часть моделей аккаунта прячется в «Другие модели».
// Хранится на клиенте по паре «подключение + аккаунт» — у разных VPS одноимённые аккаунты бывают разными.
import type { ModelChoice } from './modelsModel';

const key = (env: string, profile: string) => `perimeter:hidden-models:${env}:${profile}`;
const listeners = new Set<() => void>();

/** Скрытые модели аккаунта в подключении. */
export function hiddenModels(env: string, profile: string): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key(env, profile)) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function setModelHidden(env: string, profile: string, id: string, hidden: boolean): void {
  const set = hiddenModels(env, profile);
  if (hidden) set.add(id); else set.delete(id);
  if (set.size === 0) localStorage.removeItem(key(env, profile));
  else localStorage.setItem(key(env, profile), JSON.stringify([...set]));
  for (const fn of [...listeners]) fn();
}

export function subscribeHidden(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Разбить модели на «в списке» и «другие». Текущая модель сессии всегда на виду, даже если скрыта;
 * если скрыто всё — список не пустеет: первая модель остаётся на виду.
 */
export function splitVisible(models: ModelChoice[], hidden: Set<string>, current?: string): { shown: ModelChoice[]; other: ModelChoice[] } {
  const shown: ModelChoice[] = [];
  const other: ModelChoice[] = [];
  for (const m of models) (hidden.has(m.id) && m.id !== current ? other : shown).push(m);
  if (shown.length === 0 && other.length > 0) shown.push(other.shift()!);
  return { shown, other };
}
