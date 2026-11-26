// Центр уведомлений (владелец 2026-11-26: «уведомления вылезают поверх чата — сместить, а в идеале в отдельную
// вкладку, чтобы потом посмотреть; туда всё: обновление пришло, связь с VPS оборвалась и прочее»).
// Журнал: новые сверху, повтор по ключу — заменяет (статус одного процесса не плодит строк), непрочитанные — счётчиком
// у колокольчика в строке статуса. Хранится между запусками (без действий: кнопки живут только в этом запуске).

export type NoteLevel = 'info' | 'ok' | 'warn' | 'err';

export interface Note {
  id: string;
  at: number;
  level: NoteLevel;
  title: string;
  text?: string;
  /** среда (подпись); нет — про приложение целиком */
  env?: string;
  /** одинаковый ключ — заменяет прежнюю запись (ход одного процесса: обновление сервера, связь) */
  key?: string;
  read: boolean;
  /** действие (только в этом запуске — функции не сохраняются) */
  action?: { label: string; run: () => void };
}

export const NOTES_KEY = 'perimeter:notifications';
export const NOTES_MAX = 200;

type Listener = () => void;

export class NotificationStore {
  list: Note[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;

  constructor(private readonly ls: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    try {
      const raw = JSON.parse(this.ls?.getItem(NOTES_KEY) ?? '[]') as Note[];
      if (Array.isArray(raw)) this.list = raw.slice(0, NOTES_MAX);
    } catch { /* битый — с нуля */ }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get unread(): number {
    return this.list.filter((n) => !n.read).length;
  }

  /** Добавить; с тем же key — заменить прежнюю (и снова непрочитанная). Возвращает запись. */
  push(n: Omit<Note, 'id' | 'at' | 'read'> & { at?: number }): Note {
    const note: Note = { ...n, id: `n${Date.now().toString(36)}-${(this.seq++).toString(36)}`, at: n.at ?? Date.now(), read: false };
    this.list = [note, ...this.list.filter((x) => !(n.key !== undefined && x.key === n.key))].slice(0, NOTES_MAX);
    this.changed();
    return note;
  }

  markAllRead(): void {
    if (this.unread === 0) return;
    this.list = this.list.map((n) => (n.read ? n : { ...n, read: true }));
    this.changed();
  }

  remove(id: string): void {
    this.list = this.list.filter((n) => n.id !== id);
    this.changed();
  }

  clear(): void {
    this.list = [];
    this.changed();
  }

  private changed(): void {
    try { this.ls?.setItem(NOTES_KEY, JSON.stringify(this.list.map(({ action: _a, ...rest }) => rest))); } catch { /* нет места — живём в памяти */ }
    for (const fn of this.listeners) fn();
  }
}

export const notifications = new NotificationStore();
