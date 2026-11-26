// Обновление приложения: что написать в настройках и в строке статуса по состоянию из main (updater.mjs).
export type UpdateState = {
  state: 'off' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error';
  current: string;
  version?: string;
  percent?: number;
  reason?: string;
  message?: string;
  url?: string;
  /** macOS без подписи: не качается сам — «Скачать vX» открывает страницу релиза */
  manual?: boolean;
};

/** Строка в «Настройки → Общие». */
export function updateText(s: UpdateState): string {
  switch (s.state) {
    case 'off': return s.reason ?? 'обновления выключены';
    case 'idle': return 'проверю при запуске и раз в 4 часа';
    case 'checking': return 'проверяю…';
    case 'latest': return 'это последняя версия';
    case 'available': return s.manual ? `есть ${s.version ?? 'новая версия'} — скачайте со страницы релиза (на macOS без подписи Apple обновление ставится вручную)` : `найдена ${s.version ?? 'новая версия'} — скачиваю`;
    case 'downloading': return `скачиваю ${s.version ?? ''}${s.percent !== undefined ? ` · ${s.percent}%` : ''}`.trim();
    case 'ready': return `${s.version ?? 'новая версия'} скачана — перезапустите, чтобы поставить`;
    case 'error': return `не удалось проверить: ${s.message ?? 'ошибка'}`;
  }
}

/** Плашка в строке статуса: только когда есть что показать (качается или готово). */
export function updateBadge(s: UpdateState | null): { text: string; action: boolean; tip?: string } | null {
  if (!s) return null;
  if (s.state === 'ready') return { text: `Перезапустить: ${s.version ?? 'обновление'}`, action: true };
  if (s.state === 'available' && s.manual) return { text: `Скачать ${s.version ?? 'обновление'}`, action: true, tip: 'Откроет страницу релиза: скачайте и замените приложение (на macOS без подписи Apple обновление ставится вручную)' };
  if (s.state === 'downloading') return { text: `обновление ${s.version ?? ''} · ${s.percent ?? 0}%`.replace('  ', ' '), action: false };
  return null;
}

/** Ход автообновления supervisor'а на сервере (main/server-autoupdate.mjs). */
export type ServerUpdateEvent = { connId: string; state: 'waiting' | 'updating' | 'done' | 'failed'; message?: string; version?: string };

export function serverUpdateText(e: ServerUpdateEvent, name: string): string {
  switch (e.state) {
    case 'waiting': return `«${name}»: в сессиях идут ходы — обновлю supervisor, когда закончатся`;
    case 'updating': return `«${name}»: обновляю supervisor${e.version ? ` до ${e.version}` : ''}…`;
    case 'done': return `«${name}»: supervisor обновлён${e.version ? ` до ${e.version}` : ''}`;
    case 'failed': return `«${name}»: supervisor не обновился — ${e.message || 'ошибка'} (кнопка «Обновить» в настройках подключения)`;
  }
}
