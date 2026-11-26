// Поле ввода — отдельным блоком (владелец: «строкой-терминалом пользоваться неудобно»). Два вида на выбор в настройках:
// · «карточка» (C1, как в Claude Code): своя рамка и отступы, растёт по тексту; Enter — отправить, Shift+Enter — перенос;
// · «панель с ручкой» (C3): своя панель под лентой, высоту тянут за ручку; Enter — перенос, Ctrl+Enter — отправить.
// Общее: выбор аккаунта·модели и режима в панели поля, черновик на сессию сохраняется сам, Esc — стоп хода,
// картинки — вставить, перетащить или прикрепить.
import {
  useEffect, useLayoutEffect, useRef, useState,
  type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode,
} from 'react';
import { Icon } from './Icon';
import { afterPaint, onComposerInsert } from '../composeBus';
import { insertAt } from '../lib/fileTree';
import { hasImageData, splitImageFiles } from '../lib/pasteImages';
import {
  COMPOSER_HEIGHT_KEY, PANEL_HEIGHT, clampPanelHeight, enterAction, loadDraft, parsePanelHeight, saveDraft, type ComposerStyle,
} from '../lib/composerModel';

interface PendingImage { name: string; dataUrl: string }

/** Карточка растёт до стольких строк, дальше — прокрутка внутри. */
const CARD_MAX_ROWS = 10;

export function Composer({ variant, draftKey, tools, disabled, busy, hint, hold, autoFocus, placeholder: placeholderOverride, onSend, onStop, onInput }: {
  variant: ComposerStyle;
  /** ключ черновика (среда + сессия) */
  draftKey: string;
  /** выбор аккаунта·модели и режима — в панели поля */
  tools?: ReactNode;
  disabled: boolean;
  busy: boolean;
  /** подсказка над полем ввода (например, «сессия остыла») */
  hint?: string | undefined;
  /** отправку пока держим — почему (сессия просыпается, лента догружается); печатать можно */
  hold?: string | null | undefined;
  /** человек печатает — окно будит остывшую сессию заранее (троттлинг — у вызывающего) */
  onInput?: (() => void) | undefined;
  /** фокус в поле сразу (экран новой сессии) */
  autoFocus?: boolean;
  /** свой текст-подсказка в пустом поле */
  placeholder?: string;
  /** false (или промис с false) — отправка не удалась: текст остаётся в поле */
  onSend: (text: string, images?: string[]) => void | boolean | Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState(() => loadDraft(localStorage, draftKey));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  /** где стоял курсор, когда поле ушло из фокуса (клик по «Упомянуть» забирает фокус) */
  const caretRef = useRef<number | null>(null);

  // «@ Упомянуть» из панели «Файлы»: вставка туда, где был курсор (или в конец), фокус в поле
  useEffect(() => onComposerInsert((snippet) => {
    const el = areaRef.current;
    const cur = textRef.current;
    const pos = Math.min(caretRef.current ?? cur.length, cur.length);
    const r = insertAt(cur, pos, snippet);
    setText(r.text);
    caretRef.current = r.caret;
    afterPaint(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  }), []);

  // черновик: сохраняем через паузу в наборе; пустой — удаляется
  useEffect(() => {
    const t = setTimeout(() => setSavedAt(saveDraft(localStorage, draftKey, text) ? Date.now() : null), 400);
    return () => clearTimeout(t);
  }, [text, draftKey]);
  // ушли в другую сессию раньше паузы — последние буквы всё равно в черновике
  useEffect(() => () => { saveDraft(localStorage, draftKey, textRef.current); }, [draftKey]);

  // карточка растёт по тексту (до CARD_MAX_ROWS строк); в панели высоту задаёт ручка
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    if (variant === 'panel') {
      el.style.height = '';
      el.style.overflowY = '';
      return;
    }
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = 'auto';
    const max = lh * CARD_MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text, variant]);

  // ─── высота панели (ручка) ─────────────────────────────────────────────────
  const [height, setHeight] = useState(() => clampPanelHeight(parsePanelHeight(localStorage.getItem(COMPOSER_HEIGHT_KEY)), window.innerHeight));
  const drag = useRef<{ y: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (variant !== 'panel' || dragging) return;
    const t = setTimeout(() => localStorage.setItem(COMPOSER_HEIGHT_KEY, String(height)), 150);
    return () => clearTimeout(t);
  }, [height, dragging, variant]);
  useEffect(() => {
    const on = () => setHeight((h) => clampPanelHeight(h, window.innerHeight));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { y: e.clientY, h: height };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setHeight(clampPanelHeight(d.h + (d.y - e.clientY), window.innerHeight));
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onHandleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowUp') { e.preventDefault(); setHeight((h) => clampPanelHeight(h + step, window.innerHeight)); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHeight((h) => clampPanelHeight(h - step, window.innerHeight)); }
    if (e.key === 'Home') { e.preventDefault(); setHeight(clampPanelHeight(PANEL_HEIGHT.def, window.innerHeight)); }
  };

  // ─── картинки ─────────────────────────────────────────────────────────────
  // пустую картинку не прикрепляем — иначе агенту уходит «Image file is empty (0 bytes)», в ленте битое вложение
  const [imgNote, setImgNote] = useState<string | null>(null);
  const pushImage = (name: string, dataUrl: string) => {
    if (!hasImageData(dataUrl)) { setImgNote('картинка пустая — не прикрепил'); return; }
    setImgNote(null);
    setImages((prev) => [...prev, { name, dataUrl }]);
  };
  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const list = [...files];
    const { ok, empty } = splitImageFiles(list);
    for (const i of ok) {
      const f = list[i]!;
      const reader = new FileReader();
      reader.onload = () => pushImage(f.name, String(reader.result));
      reader.readAsDataURL(f);
    }
    if (ok.length === 0 && empty > 0) setImgNote('картинка пустая (0 байт) — не прикрепил');
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const list = [...files];
    const { ok, empty } = splitImageFiles(list);
    if (ok.length === 0 && empty === 0) return;
    e.preventDefault();
    if (ok.length > 0) { addFiles(ok.map((i) => list[i]!)); return; }
    // Windows отдал отложенный файл 0 байт (мессенджер, проводник) — берём битмап из буфера ОС напрямую
    void (async () => {
      const url = await window.perimeterIPC?.clipboardImage?.().catch(() => null);
      if (url && hasImageData(url)) pushImage('вставка.png', url);
      else setImgNote('картинка из буфера пустая — не прикрепил. Сохраните её файлом и перетащите сюда');
    })();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer?.files ?? null);
  };

  // ─── отправка ─────────────────────────────────────────────────────────────
  const [sending, setSending] = useState(false);
  const send = () => {
    const t = text.trim();
    if ((t === '' && images.length === 0) || disabled || sending || hold) return;
    const clear = () => {
      textRef.current = ''; // поле могли уже закрыть (новая сессия создана) — при закрытии черновик не должен вернуться
      setText('');
      setImages([]);
      setImgNote(null);
      saveDraft(localStorage, draftKey, '');
      setSavedAt(null);
    };
    const res = onSend(t, images.length > 0 ? images.map((i) => i.dataUrl) : undefined);
    if (res instanceof Promise) {
      setSending(true);
      void res.then((ok) => { if (ok) clear(); }, () => undefined).finally(() => setSending(false));
    } else if (res !== false) {
      clear();
    }
  };
  useEffect(() => { if (autoFocus) areaRef.current?.focus(); }, [autoFocus]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const act = enterAction(variant, { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing });
    if (act === 'send') {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      onStop();
    }
  };

  /** Клик по пустому месту карточки — фокус в текст (кнопки и меню не трогаем). */
  const focusArea = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, select, a, .picker, .img-chip')) return;
    areaRef.current?.focus();
  };

  const canSend = !disabled && !sending && !hold && (text.trim() !== '' || images.length > 0);
  const holdNote = hold ? <span className="composer-hold" role="status">{hold}</span> : null;
  const placeholder = placeholderOverride && !disabled ? placeholderOverride : disabled
    ? 'Нет связи с supervisor…'
    : busy ? 'Дописать по ходу — агент прочитает'
    : variant === 'panel' ? 'Опишите задачу — можно в несколько абзацев…' : 'Ответьте агенту или дайте новую задачу…';

  const attach = (
    <>
      <input
        ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
      />
      <button className="icon-btn" data-tip="Прикрепить картинку (или вставить / перетащить)" aria-label="Прикрепить картинку" onClick={() => fileRef.current?.click()}><Icon name="clip" /></button>
    </>
  );
  const stopBtn = busy && <button className="btn stop sm" onClick={onStop} data-tip="Остановить ход" data-key="Esc"><Icon name="stop" size={14} /> Стоп</button>;
  const imgNoteEl = imgNote && <div className="composer-hint">{imgNote}</div>;
  const chips = images.length > 0 && (
    <div className="img-chips">
      {images.map((img, i) => (
        <div key={i} className="img-chip" title={img.name}>
          <img src={img.dataUrl} alt={img.name} />
          <button className="img-chip-x" aria-label="Убрать картинку" onClick={() => setImages((p) => p.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
    </div>
  );
  const area = (
    <textarea
      ref={areaRef}
      value={text}
      placeholder={placeholder}
      onChange={(e) => { setText(e.target.value); onInput?.(); }}
      onKeyDown={onKey}
      onSelect={(e) => { caretRef.current = e.currentTarget.selectionStart; }}
      onPaste={onPaste}
      rows={1}
      disabled={disabled}
      aria-label="Сообщение агенту"
    />
  );
  const dropProps = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(true); },
    onDragLeave: () => setDragOver(false),
    onDrop,
  };

  if (variant === 'panel') {
    return (
      <div className="composer-wrap is-panel" style={{ height }}>
        <div
          className={`composer-handle ${dragging ? 'dragging' : ''}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Высота поля ввода"
          aria-valuenow={height}
          tabIndex={0}
          data-tip="Тянуть — высота поля · двойной клик — по умолчанию"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onDoubleClick={() => setHeight(clampPanelHeight(PANEL_HEIGHT.def, window.innerHeight))}
          onKeyDown={onHandleKey}
        >
          <span />
        </div>
        <div className={`composer is-panel ${dragOver ? 'dragover' : ''}`} {...dropProps} onClick={focusArea}>
          <div className="composer-bar">
            {attach}
            {tools}
            <span className="spacer" />
            {savedAt !== null && text.trim() !== '' && <span className="composer-saved"><Icon name="check" size={12} /> черновик сохранён</span>}
          </div>
          {hint && <div className="composer-hint">{hint}</div>}
          {imgNoteEl}
          {chips}
          {area}
          <div className="composer-bar">
            <span className="key-hints composer-keys">
              <kbd>Enter</kbd> новая строка <kbd>Ctrl+Enter</kbd> отправить{busy && <> <kbd>Esc</kbd> стоп</>}
            </span>
            <span className="spacer" />
            {stopBtn}
            {holdNote}
            <button className="btn primary composer-send-btn" onClick={send} disabled={!canSend} data-tip={hold ?? 'Отправить'} data-key="Ctrl Enter">
              <Icon name="arrowUp" size={14} /> Отправить
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="composer-wrap is-card">
      <div className={`composer is-card ${dragOver ? 'dragover' : ''}`} {...dropProps} onClick={focusArea}>
        {hint && <div className="composer-hint">{hint}</div>}
        {imgNoteEl}
        {chips}
        {area}
        <div className="composer-bar">
          {attach}
          {tools}
          <span className="spacer" />
          <span className="key-hints composer-keys">
            <kbd>Enter</kbd> отправить <span className="kh-extra"><kbd>Shift+Enter</kbd> перенос{busy && <> <kbd>Esc</kbd> стоп</>}</span>
          </span>
          {stopBtn}
          {holdNote}
          <button className={`composer-send ${canSend ? 'ready' : ''}`} onClick={send} aria-disabled={!canSend} data-tip={hold ?? 'Отправить'} data-key="Enter" aria-label="Отправить">
            <Icon name="arrowUp" />
          </button>
        </div>
      </div>
    </div>
  );
}
