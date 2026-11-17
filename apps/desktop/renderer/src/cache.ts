// Локальный кэш подключений в IndexedDB: список сессий, проекты, аккаунты и ленты открытых сессий.
// Зачем: туннель до VPS медленный — сайдбар и чат показываются из кэша сразу, а сервер присылает только
// то, что случилось после (догон по lastSeq), вместо целого транскрипта.
// Ленты пишутся вместе с их seq в одной транзакции — иначе догон дал бы дыру или дубли.
// Нет IndexedDB (тесты в node) — все операции молча ничего не делают.
import { feedsToEvict, type CachedFeed, type CachedSession } from './lib/cacheModel';

const DB_NAME = 'perimeter-cache';
const DB_VERSION = 1;

/** Снимок подключения: всё, что нужно сайдбару до hello. */
export interface CachedMeta {
  savedAt: number;
  activeId: string | null;
  sessions: CachedSession[];
  profiles: unknown[];
  projects: unknown[];
  storage: unknown;
}

/** Голова ленты: seq и время — читаются все разом при старте (ленты — по требованию). */
interface FeedHead { key: string; env: string; sid: string; lastSeq: number; savedAt: number }

let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (!d.objectStoreNames.contains('heads')) d.createObjectStore('heads', { keyPath: 'key' }).createIndex('env', 'env');
      if (!d.objectStoreNames.contains('feeds')) d.createObjectStore('feeds');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB: прервано'));
  });
}

function get<T>(r: IDBRequest): Promise<T | undefined> {
  return new Promise((resolve) => {
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => resolve(undefined);
  });
}

const feedKey = (env: string, sid: string) => `${env}\u0000${sid}`;

export const cacheStore = {
  /** Снимок подключения и seq кэшированных лент (null — кэша нет). */
  async load(env: string): Promise<{ meta: CachedMeta; heads: Map<string, number> } | null> {
    const d = await db();
    if (!d) return null;
    try {
      const tx = d.transaction(['meta', 'heads'], 'readonly');
      const [meta, heads] = await Promise.all([
        get<CachedMeta>(tx.objectStore('meta').get(env)),
        get<FeedHead[]>(tx.objectStore('heads').index('env').getAll(env)),
      ]);
      if (!meta) return null;
      return { meta, heads: new Map((heads ?? []).map((h) => [h.sid, h.lastSeq])) };
    } catch {
      return null;
    }
  },

  async saveMeta(env: string, meta: CachedMeta): Promise<void> {
    const d = await db();
    if (!d) return;
    const tx = d.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(meta, env);
    await done(tx).catch(() => undefined);
  },

  async loadFeed<T>(env: string, sid: string): Promise<CachedFeed<T> | null> {
    const d = await db();
    if (!d) return null;
    try {
      const tx = d.transaction('feeds', 'readonly');
      return (await get<CachedFeed<T>>(tx.objectStore('feeds').get(feedKey(env, sid)))) ?? null;
    } catch {
      return null;
    }
  },

  /** Лента и её голова — одной транзакцией; лишние старые ленты подключения — вон. */
  async saveFeed<T>(env: string, sid: string, feed: CachedFeed<T>): Promise<void> {
    const d = await db();
    if (!d) return;
    try {
      const tx = d.transaction(['feeds', 'heads'], 'readwrite');
      const key = feedKey(env, sid);
      tx.objectStore('feeds').put(feed, key);
      const heads = tx.objectStore('heads');
      heads.put({ key, env, sid, lastSeq: feed.lastSeq, savedAt: feed.savedAt } satisfies FeedHead);
      const all = (await get<FeedHead[]>(heads.index('env').getAll(env))) ?? [];
      for (const old of feedsToEvict(all.map((h) => ({ sid: h.sid, savedAt: h.savedAt })))) {
        heads.delete(feedKey(env, old));
        tx.objectStore('feeds').delete(feedKey(env, old));
      }
      await done(tx);
    } catch { /* кэш — не источник истины: не записалось — откроется с сервера */ }
  },

  async dropFeed(env: string, sid: string): Promise<void> {
    const d = await db();
    if (!d) return;
    try {
      const tx = d.transaction(['feeds', 'heads'], 'readwrite');
      tx.objectStore('feeds').delete(feedKey(env, sid));
      tx.objectStore('heads').delete(feedKey(env, sid));
      await done(tx);
    } catch { /* нечего удалять */ }
  },

  /** Подключение удалено — его кэш тоже. */
  async dropEnv(env: string): Promise<void> {
    const d = await db();
    if (!d) return;
    try {
      const tx = d.transaction(['meta', 'feeds', 'heads'], 'readwrite');
      tx.objectStore('meta').delete(env);
      const heads = tx.objectStore('heads');
      const all = (await get<FeedHead[]>(heads.index('env').getAll(env))) ?? [];
      for (const h of all) {
        heads.delete(h.key);
        tx.objectStore('feeds').delete(h.key);
      }
      await done(tx);
    } catch { /* нечего удалять */ }
  },
};
