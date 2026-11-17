// Мелкие общие кусочки интерфейса BD2: подсказки с клавишей, выпадающие меню,
// многострочный текст (первая строка + «+N строк» / целиком с номерами), метка проекта.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { lineSummary, moreLines } from '../lib/multiline';
import { projectColor } from '../lib/sessionGroups';

// ─── подсказки ──────────────────────────────────────────────────────────────

/**
 * Один слой подсказок на всё приложение: любой элемент с data-tip (и data-key — клавиша)
 * получает тёмную плашку после короткой задержки. Неактивные кнопки помечаются aria-disabled,
 * а не disabled — иначе браузер не шлёт им события мыши и подсказка не появится.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; key?: string; x: number; y: number; below: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      current = null;
      setTip(null);
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      timer = setTimeout(() => {
        if (!current?.isConnected) return;
        const r = current.getBoundingClientRect();
        const below = r.bottom + 40 < window.innerHeight;
        const key = current.dataset['key'];
        setTip({ text: current.dataset['tip'] ?? '', ...(key ? { key } : {}), x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
      }, 380);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);
  // не даём плашке вылезти за край окна
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const left = Math.min(Math.max(8, tip.x - w / 2), window.innerWidth - w - 8);
    el.style.left = `${left}px`;
  }, [tip]);
  if (!tip || tip.text === '') return null;
  return (
    <div ref={boxRef} className={`tooltip ${tip.below ? 'below' : 'above'}`} style={{ top: tip.y }} role="tooltip">
      <span>{tip.text}</span>
      {tip.key && <kbd>{tip.key}</kbd>}
    </div>
  );
}

// ─── выпадающие меню ────────────────────────────────────────────────────────

/** Открыто/закрыто + закрытие кликом мимо и Esc. ref — на обёртку (кнопка + меню). */
export function usePopover<T extends HTMLElement = HTMLDivElement>(): { open: boolean; setOpen: (v: boolean) => void; ref: React.RefObject<T | null> } {
  const [open, setOpen] = useState(false);
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  return { open, setOpen, ref };
}

// ─── многострочный текст ────────────────────────────────────────────────────

/** Текст целиком моноширинно: перенос длинных строк, номера строк — если строк больше трёх. */
export function FullText({ text, prefix, className }: { text: string; prefix?: string; className?: string }) {
  const s = lineSummary(text);
  return (
    <div className={`fulltext ${s.numbered ? 'numbered' : ''} ${className ?? ''}`}>
      {s.lines.map((l, i) => (
        <div key={i} className="fulltext-line">
          {s.numbered ? <span className="fulltext-no">{i + 1}</span> : prefix && i === 0 ? <span className="fulltext-no">{prefix}</span> : prefix ? <span className="fulltext-no" /> : null}
          <span className="fulltext-text">{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Однострочный показ: первая строка + метка «+N строк»; клик по метке (или Enter на ней) — весь текст.
 * В сайдбаре и шагах ленты; запрос разрешения всегда показывает текст целиком (FullText).
 */
export function MultiLine({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const s = lineSummary(text);
  return (
    <>
      <span className={`ml-first ${className ?? ''}`} title={s.extra ? undefined : text}>{s.first}</span>
      {s.extra > 0 && (
        <button
          className={`ml-more ${open ? 'on' : ''}`}
          aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          data-tip={open ? 'Свернуть' : 'Показать целиком'}
        >{moreLines(s.extra)}</button>
      )}
      {open && <FullText text={text} className="ml-full" />}
    </>
  );
}

// ─── метка проекта ──────────────────────────────────────────────────────────

export function ProjectTag({ name, extra }: { name?: string | undefined; extra?: ReactNode }) {
  return (
    <span className="ptag">
      <span className={`ptag-sq ${name ? '' : 'none'}`} style={name ? { background: projectColor(name) } : undefined} />
      <span className="ptag-name">{name ?? 'без проекта'}</span>
      {extra}
    </span>
  );
}

/** Esc закрывает диалог (модальные окна настроек, синка, нового проекта). */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);
}
