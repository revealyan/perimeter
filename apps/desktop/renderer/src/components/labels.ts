// Подписи состояний сессии — одни на весь UI (сайдбар, шапка, панель).
export const STATE_LABEL: Record<string, string> = {
  creating: 'создаётся',
  initializing: 'запускается',
  idle: 'готова',
  working: 'работает',
  waiting_permission: 'ждёт разрешения',
  waiting_input: 'ждёт ответа',
  interrupted: 'остановлена',
  error: 'ошибка',
  dead: 'остыла',
};

export function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'сейчас';
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.round(h / 24)} дн`;
}
