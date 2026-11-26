// Фоновый поиск сессий Claude Code вне Perimeter (владелец 2026-11-26: «в фоне автоматом сканить и дать
// уведомление»): что нового с прошлого раза — по каждой среде. Чистые функции; хранилище — localStorage.

/** Как часто сканировать (и сразу при подключении). */
export const FOREIGN_SCAN_MS = 10 * 60_000;

const key = (env: string) => `perimeter:foreign-seen:${env}`;

export function loadSeen(ls: Pick<Storage, 'getItem'>, env: string): Set<string> {
  try { return new Set(JSON.parse(ls.getItem(key(env)) ?? '[]') as string[]); } catch { return new Set(); }
}

export function saveSeen(ls: Pick<Storage, 'setItem'>, env: string, ids: Iterable<string>): void {
  ls.setItem(key(env), JSON.stringify([...ids].slice(-2000)));
}

/**
 * Новые чужие сессии с прошлого раза. Первый скан среды (ничего не видели) — не шумим про старое: запоминаем всё,
 * сообщаем только о том, что появится потом.
 */
export function newForeign(found: Array<{ claudeSessionId: string }>, seen: Set<string>, firstRun: boolean): { fresh: string[]; seen: Set<string> } {
  const next = new Set(seen);
  const fresh: string[] = [];
  for (const f of found) {
    if (next.has(f.claudeSessionId)) continue;
    next.add(f.claudeSessionId);
    if (!firstRun) fresh.push(f.claudeSessionId);
  }
  return { fresh, seen: next };
}
