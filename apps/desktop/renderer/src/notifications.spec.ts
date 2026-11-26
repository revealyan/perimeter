import { describe, expect, it } from 'vitest';
import { NOTES_KEY, NotificationStore } from './notifications';

const mem = () => { const m = new Map<string, string>(); return { m, ls: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } }; };

describe('центр уведомлений', () => {
  it('новые сверху; тот же ключ — заменяет и снова непрочитан; прочитать все; удалить', () => {
    const { ls } = mem();
    const s = new NotificationStore(ls);
    s.push({ level: 'info', title: 'сервер обновляется', key: 'srv:vps' });
    s.push({ level: 'err', title: 'команда упала' });
    s.markAllRead();
    s.push({ level: 'ok', title: 'сервер обновлён', key: 'srv:vps' });
    expect(s.list.map((n) => [n.title, n.read])).toEqual([['сервер обновлён', false], ['команда упала', true]]);
    expect(s.unread).toBe(1);
    s.remove(s.list[1]!.id);
    expect(s.list).toHaveLength(1);
  });

  it('переживает перезапуск (без кнопок — функции не сохраняются); не больше 200', () => {
    const { ls, m } = mem();
    const a = new NotificationStore(ls);
    a.push({ level: 'warn', title: 'связь оборвалась', env: 'vps', action: { label: 'повторить', run: () => undefined } });
    for (let i = 0; i < 250; i++) a.push({ level: 'info', title: `n${i}` });
    const b = new NotificationStore(ls);
    expect(b.list).toHaveLength(200);
    expect(b.list[0]!.title).toBe('n249');
    expect(JSON.parse(m.get(NOTES_KEY)!).every((n: { action?: unknown }) => n.action === undefined)).toBe(true);
  });
});
