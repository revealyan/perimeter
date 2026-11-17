// Локальный кэш подключения — чистые функции: что кладём, что достаём, когда ленту кэшировать нельзя.
// Хранилище (IndexedDB) — в ../cache.ts; связка со store — в ../supervisor.ts.

/** Сессия в кэше: всё, кроме ленты и живого состояния (карточки разрешений, печать, ретраи). */
export interface CachedSession {
  id: string;
  name: string;
  state: string;
  needs: string | null;
  model?: string;
  permissionMode?: string;
  profile?: string;
  projectId?: string;
  archived?: boolean;
  effort?: string;
  ultracode?: boolean;
  /** воркер делегирования: родитель и инструмент (вложенность переживает рестарт приложения) */
  parentSessionId?: string;
  agentOf?: string;
  lastActivity: number;
}

/** Лента сессии в кэше: элементы и последний seq, который в них учтён (догон после — с сервера). */
export interface CachedFeed<T> {
  lastSeq: number;
  items: T[];
  savedAt: number;
}

/** Лента больше — не кэшируем: чтение из IndexedDB и JSON-разбор съедят выигрыш, откроется как раньше. */
export const FEED_MAX_ITEMS = 5000;
export const FEED_MAX_CHARS = 8_000_000;
/** Сколько лент держать на подключение (последние сохранённые). */
export const FEEDS_PER_ENV = 40;

const SESSION_KEYS = ['model', 'permissionMode', 'profile', 'projectId', 'archived', 'effort', 'ultracode', 'parentSessionId', 'agentOf'] as const;

export function toCachedSession(s: CachedSession & Record<string, unknown>): CachedSession {
  const out: CachedSession = { id: s.id, name: s.name, state: s.state, needs: s.needs ?? null, lastActivity: s.lastActivity };
  for (const k of SESSION_KEYS) if (s[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = s[k];
  return out;
}

/** Ленту можно кэшировать: не слишком большая. Возвращает её JSON-оценку (символов) или null. */
export function feedFits(items: unknown[]): number | null {
  if (items.length > FEED_MAX_ITEMS) return null;
  let n = 0;
  try { n = JSON.stringify(items).length; } catch { return null; }
  return n > FEED_MAX_CHARS ? null : n;
}

/** Подпись ленты — сохранять ли заново: изменились длина, последний элемент или seq. */
export function feedSignature(items: Array<{ id: string }>, lastSeq: number | undefined): string {
  return `${items.length}|${items[items.length - 1]?.id ?? ''}|${lastSeq ?? -1}`;
}

/**
 * Лента из кэша + то, что успело прийти по сокету до её чтения (догон после lastSeq кэша).
 * Пришедшее с seq не больше кэшированного — уже в кэше (дубль), его отбрасываем.
 */
export function mergeCachedFeed<T extends { id: string }>(cached: CachedFeed<T>, live: T[]): T[] {
  const fresh = live.filter((it) => {
    const m = /^i(\d+)/.exec(it.id);
    return !m || Number(m[1]) > cached.lastSeq;
  });
  return [...cached.items, ...fresh];
}

/**
 * Результаты инструментов, пришедшие догоном до чтения ленты из кэша, легли отдельными строками
 * (вызова в памяти ещё не было). После склейки — приклеить их к своим вызовам, как при живом потоке.
 */
export function attachOrphanResults<T extends { id: string; kind: string; data: Record<string, unknown> }>(items: T[]): T[] {
  const out: T[] = [];
  for (const it of items) {
    const useId = it.kind === 'tool-result' ? it.data['toolUseId'] : undefined;
    if (typeof useId === 'string') {
      const call = [...out].reverse().find((x) => x.kind === 'tool-use' && x.data['id'] === useId);
      if (call) {
        call.data['result'] = it.data['result'];
        call.data['isError'] = it.data['isError'] === true;
        call.data['done'] = true;
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

/** Какие ленты выкинуть, чтобы осталось не больше limit (сначала самые старые). */
export function feedsToEvict(heads: Array<{ sid: string; savedAt: number }>, limit = FEEDS_PER_ENV): string[] {
  if (heads.length <= limit) return [];
  return [...heads].sort((a, b) => a.savedAt - b.savedAt).slice(0, heads.length - limit).map((h) => h.sid);
}
