// Колокольчик в строке статуса: счётчик непрочитанного, свежее — коротко строкой рядом (несколько секунд, не поверх
// чата), по клику — журнал с действиями. Всё, что раньше всплывало тостами, — здесь.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { notifications, type Note } from '../notifications';
import { envLabel } from '../connections';
import { ago } from './labels';
import { Icon } from './Icon';

/** Сколько секунд свежая запись видна строкой рядом с колокольчиком. */
const FLASH_MS = 6000;

export function NotificationBell() {
  const [, tick] = useState(0);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<Note | null>(null);
  const last = useRef<string | null>(notifications.list[0]?.id ?? null);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // журнал — порталом поверх окна у колокольчика: строка статуса режет всё, что выходит за неё
  const [at, setAt] = useState<{ right: number; bottom: number }>({ right: 12, bottom: 44 });

  useEffect(() => notifications.subscribe(() => {
    tick((t) => t + 1);
    const top = notifications.list[0];
    if (top && top.id !== last.current && !top.read) setFlash(top);
    last.current = top?.id ?? null;
  }), []);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);
  // открыли журнал — прочитано; клик мимо — закрыть
  useEffect(() => {
    if (!open) return;
    setFlash(null);
    const t = setTimeout(() => notifications.markAllRead(), 800);
    const r = box.current?.getBoundingClientRect();
    if (r) setAt({ right: Math.max(8, window.innerWidth - r.right - 8), bottom: window.innerHeight - r.top + 8 });
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const unread = notifications.unread;
  const worst = notifications.list.filter((n) => !n.read).reduce<Note['level'] | null>((w, n) => (n.level === 'err' || w === 'err' ? 'err' : n.level === 'warn' || w === 'warn' ? 'warn' : n.level), null);

  return (
    <div className="nb" ref={box}>
      {flash && !open && (
        <button type="button" className={`nb-flash lvl-${flash.level}`} onClick={() => setOpen(true)} data-tip="Открыть уведомления">
          {flash.env && <b>{envLabel(flash.env)}: </b>}{flash.title}
        </button>
      )}
      <button type="button" className={`icon-btn sm nb-btn ${unread ? `has lvl-${worst ?? 'info'}` : ''}`} onClick={() => setOpen(!open)} data-tip="Уведомления" aria-label={`Уведомления${unread ? `: непрочитанных ${unread}` : ''}`}>
        <Icon name="bell" size={14} />
        {unread > 0 && <span className="nb-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && createPortal(
        <div className="nb-panel" role="dialog" aria-label="Уведомления" ref={panel} style={{ right: at.right, bottom: at.bottom }}>
          <div className="nb-head">
            <b>Уведомления</b>
            <span className="spacer" />
            {notifications.list.length > 0 && <button type="button" className="link-btn" onClick={() => notifications.clear()}>очистить</button>}
          </div>
          {notifications.list.length === 0 && <p className="dim nb-empty">Пока ничего — сюда приходят обновления, обрывы связи, итоги переноса и прочее.</p>}
          <ul className="nb-list">
            {notifications.list.map((n) => (
              <li key={n.id} className={`nb-item lvl-${n.level} ${n.read ? '' : 'unread'}`}>
                <span className="nb-dot" aria-hidden />
                <div className="nb-body">
                  <div className="nb-title">{n.env && <span className="dim">{envLabel(n.env)} · </span>}{n.title}</div>
                  {n.text && <div className="dim nb-text">{n.text}</div>}
                  <div className="nb-foot">
                    <span className="dim">{ago(n.at)}</span>
                    {n.action && <button type="button" className="link-btn" onClick={() => { n.action!.run(); setOpen(false); }}>{n.action.label}</button>}
                  </div>
                </div>
                <button type="button" className="toast-x" aria-label="Убрать" onClick={() => notifications.remove(n.id)}>×</button>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
