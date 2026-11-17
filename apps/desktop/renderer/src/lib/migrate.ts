// Разовая миграция настроек при переименовании codecode → perimeter (2026-11-17):
// ключи localStorage переезжают с префиксом, если новых ещё нет. Кэш лент (IndexedDB)
// не мигрируем — база создастся новая, ленты подтянутся с сервера.

const OLD = 'codecode:';
const NEW = 'perimeter:';

export function migrateLocalStorage(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith(OLD)) keys.push(k);
    }
    for (const k of keys) {
      const to = NEW + k.slice(OLD.length);
      if (localStorage.getItem(to) === null) localStorage.setItem(to, localStorage.getItem(k) ?? '');
    }
  } catch { /* приватный режим/недоступный localStorage — просто начнём с пустого */ }
}
