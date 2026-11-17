// Терминалы панели: экземпляры xterm живут вне React — переживают переключение вкладок панели,
// сессий и закрытие панели (вывод продолжает копиться). Поток адресуется по termId (onTerm хранилища);
// после реконнекта и при первом показе сессии — term.list + term.attach (scrollback заменяет экран).
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { EnvId, SupervisorClient, TermEvent } from './supervisor';
import { panelErrorText, type TermInfo, type TermMode } from './lib/panelData';

/** Палитра BD2: фон кода #111318, текст #e4e7ee, акцент #7c8cff, статусы ok/err/warn/info. */
const THEME: ITheme = {
  background: '#111318',
  foreground: '#e4e7ee',
  cursor: '#e4e7ee',
  cursorAccent: '#111318',
  selectionBackground: 'rgba(124, 140, 255, 0.32)',
  scrollbarSliderBackground: 'rgba(58, 63, 75, 0.7)',
  scrollbarSliderHoverBackground: 'rgba(134, 141, 160, 0.5)',
  black: '#1f222a', red: '#ec7a80', green: '#6cc28a', yellow: '#e3b25e',
  blue: '#7c8cff', magenta: '#c792ea', cyan: '#5fb3d6', white: '#a7adbb',
  brightBlack: '#868da0', brightRed: '#f29ca1', brightGreen: '#8fd6a6', brightYellow: '#f0c987',
  brightBlue: '#aab4ff', brightMagenta: '#dcb2f2', brightCyan: '#8ccbe6', brightWhite: '#e4e7ee',
};

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;

export interface TermEntry {
  /** стабильный ключ (termId появляется только после ответа сервера) */
  key: string;
  termId: string | null;
  shell: string;
  cwd: string;
  mode: TermMode;
  alive: boolean;
  exitCode: number | null;
  /** почему недоступен (сервер перезапускался и т. п.) */
  note?: string;
  xterm: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
  unsub: (() => void) | null;
  size: { cols: number; rows: number };
  resizeTimer: ReturnType<typeof setTimeout> | null;
  offlineWarned: boolean;
}

export interface SessionTerms {
  sid: string;
  env: EnvId;
  terms: TermEntry[];
  active: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** ошибка открытия нового терминала (не роняет уже открытые) */
  openError: string | null;
  /** эпоха соединения, в которой синхронизировались (после реконнекта — заново) */
  epoch: number;
  syncing: boolean;
  /** автооткрытие первого терминала уже пробовали (или пользователь закрыл все) */
  autoDone: boolean;
}

const activeKey = (sid: string) => `perimeter:term-active:${sid}`;

export class TermManager {
  private sessions = new Map<string, SessionTerms>();
  private epoch = 0;
  private seq = 0;

  constructor(private client: SupervisorClient) {
    client.onConnect(() => {
      this.epoch++;
      for (const s of this.sessions.values()) {
        if (s.env === client.environment && s.status !== 'idle') void this.sync(s.sid);
      }
    });
  }

  private changed(): void {
    this.client.notify();
  }

  get(sid: string): SessionTerms {
    const k = `${this.client.environment}|${sid}`;
    let s = this.sessions.get(k);
    if (!s) {
      s = { sid, env: this.client.environment, terms: [], active: null, status: 'idle', error: null, openError: null, epoch: -1, syncing: false, autoDone: false };
      this.sessions.set(k, s);
    }
    return s;
  }

  /** Сколько живых терминалов у сессии (бейдж вкладки). */
  count(sid: string): number {
    return this.sessions.get(`${this.client.environment}|${sid}`)?.terms.filter((t) => t.alive).length ?? 0;
  }

  activeEntry(s: SessionTerms): TermEntry | undefined {
    return s.terms.find((t) => t.key === s.active) ?? s.terms[0];
  }

  private createEntry(s: SessionTerms, info: TermInfo | null): TermEntry {
    const mode: TermMode = info?.mode ?? 'pty';
    const xterm = new Terminal({
      theme: THEME,
      fontFamily: "'Roboto Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.45,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      convertEol: mode === 'pipe',
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const host = document.createElement('div');
    host.className = 'term-host';
    const e: TermEntry = {
      key: `k${++this.seq}`,
      termId: info?.termId ?? null,
      shell: info?.shell ?? '',
      cwd: info?.cwd ?? '',
      mode,
      alive: info ? info.alive : true,
      exitCode: null,
      xterm, fit, host,
      opened: false,
      unsub: null,
      size: { cols: 80, rows: 24 },
      resizeTimer: null,
      offlineWarned: false,
    };
    xterm.onData((d) => this.input(s, e, d));
    // копирование как в Windows Terminal: Ctrl+C при выделении — копировать, Ctrl+Shift+C/V — копировать/вставить
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !(ev.ctrlKey || ev.metaKey)) return true;
      if (ev.code === 'KeyC' && (ev.shiftKey || xterm.hasSelection())) {
        if (xterm.hasSelection()) void navigator.clipboard?.writeText(xterm.getSelection());
        return false;
      }
      if (ev.code === 'KeyV' && ev.shiftKey) {
        void navigator.clipboard?.readText().then((t) => { if (t) xterm.paste(t); });
        return false;
      }
      return true;
    });
    if (e.termId) this.subscribe(e);
    return e;
  }

  private subscribe(e: TermEntry): void {
    if (e.unsub || !e.termId) return;
    e.unsub = this.client.onTerm(e.termId, (ev: TermEvent) => {
      if (ev.type === 'output') e.xterm.write(ev.data);
      else {
        e.alive = false;
        e.exitCode = ev.code;
        e.xterm.write(`\r\n${DIM(`[процесс завершён${ev.code !== null ? ` · код ${ev.code}` : ''}]`)}\r\n`);
        this.changed();
      }
    });
  }

  /** Ввод как есть в обоих режимах: в pipe эхо и правку строки эмулирует supervisor (локальное эхо задвоило бы). */
  private input(s: SessionTerms, e: TermEntry, data: string): void {
    if (!e.termId || !e.alive || !data) return;
    this.client.termInput(s.sid, e.termId, data).then(() => { e.offlineWarned = false; }, (err: unknown) => {
      if (e.offlineWarned) return;
      e.offlineWarned = true;
      e.xterm.write(`\r\n${DIM(`[ввод не доставлен: ${panelErrorText(err)}]`)}\r\n`);
    });
  }

  /** Список и подключение к открытым терминалам сессии (первый показ, реконнект). */
  async sync(sid: string): Promise<void> {
    const s = this.get(sid);
    if (s.syncing) return;
    s.syncing = true;
    if (s.status !== 'ready') s.status = 'loading';
    this.changed();
    const epoch = this.epoch;
    try {
      const list = await this.client.termList(sid);
      const seen = new Set<string>();
      for (const info of list) {
        seen.add(info.termId);
        let e = s.terms.find((t) => t.termId === info.termId);
        const fresh = !e;
        if (!e) {
          e = this.createEntry(s, info);
          s.terms.push(e);
        }
        e.shell = info.shell || e.shell;
        e.cwd = info.cwd || e.cwd;
        if (e.mode !== info.mode) {
          e.mode = info.mode;
          e.xterm.options.convertEol = info.mode === 'pipe';
        }
        if (!info.alive && !fresh) { e.alive = false; continue; }
        try {
          const a = await this.client.termAttach(sid, info.termId);
          e.alive = a.alive && info.alive;
          e.note = undefined;
          // scrollback — полный экран на момент подключения: пропуски при обрыве восстановлены
          e.xterm.reset();
          if (a.scrollback) e.xterm.write(a.scrollback);
          if (!e.alive) e.xterm.write(`\r\n${DIM('[процесс завершён]')}\r\n`);
          if (e.alive && e.opened) this.sendResize(s, e, true);
        } catch (err) {
          e.alive = false;
          e.note = panelErrorText(err);
        }
      }
      for (const e of s.terms) {
        if (e.termId && !seen.has(e.termId) && e.alive) {
          e.alive = false;
          e.note = 'терминала больше нет на сервере';
          e.xterm.write(`\r\n${DIM('[терминал недоступен — supervisor перезапускался?]')}\r\n`);
        }
      }
      const saved = localStorage.getItem(activeKey(sid));
      if (!s.terms.some((t) => t.key === s.active)) s.active = s.terms.find((t) => t.termId === saved)?.key ?? s.terms[0]?.key ?? null;
      s.status = 'ready';
      s.error = null;
      s.epoch = epoch;
    } catch (err) {
      s.status = s.terms.length > 0 ? 'ready' : 'error';
      s.error = panelErrorText(err);
    } finally {
      s.syncing = false;
      this.changed();
    }
  }

  /** Показ вкладки: синхронизировать (если ещё не в этой эпохе) и открыть первый терминал, если пусто. */
  async ensure(sid: string): Promise<void> {
    const s = this.get(sid);
    if (s.status === 'error' && !s.syncing) return; // ждём «Повторить»
    if (s.epoch !== this.epoch || s.status === 'idle') await this.sync(sid);
    // автооткрытие — один раз на сессию (флаг в localStorage): иначе каждый взгляд на вкладку
    // после перезапуска или гашения простаивающих терминалов плодил бы оболочки на сервере
    const flag = `perimeter:term-auto:${sid}`;
    if (s.status === 'ready' && s.terms.length === 0 && !s.autoDone && !localStorage.getItem(flag)) {
      s.autoDone = true;
      localStorage.setItem(flag, '1');
      await this.open(sid);
    }
  }

  /** Новый терминал: сначала монтируем xterm (размер — из fit), потом term.open с cols/rows. */
  async open(sid: string, initCommand?: string): Promise<void> {
    const s = this.get(sid);
    const e = this.createEntry(s, null);
    s.terms.push(e);
    s.active = e.key;
    s.openError = null;
    this.changed();
    // ждём, пока вкладка вставит xterm в DOM и подгонит размер
    await new Promise((r) => setTimeout(r, 60));
    try {
      const info = await this.client.termOpen(sid, e.size.cols, e.size.rows);
      e.termId = info.termId;
      e.shell = info.shell;
      e.cwd = info.cwd;
      e.mode = info.mode;
      e.alive = true;
      e.xterm.options.convertEol = info.mode === 'pipe';
      this.subscribe(e);
      localStorage.setItem(activeKey(sid), info.termId);
      // за время ответа размер мог поменяться
      this.sendResize(s, e, false);
      // пресет («claude в терминале»): дать шеллу подняться и выполнить команду в новой вкладке
      if (initCommand !== undefined && initCommand !== '') {
        setTimeout(() => {
          if (e.termId && e.alive) void this.client.termInput(sid, e.termId, `${initCommand}\r`).catch(() => undefined);
        }, 500);
      }
    } catch (err) {
      s.openError = panelErrorText(err);
      this.dispose(e);
      s.terms = s.terms.filter((t) => t !== e);
      if (s.active === e.key) s.active = s.terms[s.terms.length - 1]?.key ?? null;
    }
    this.changed();
  }

  select(sid: string, key: string): void {
    const s = this.get(sid);
    s.active = key;
    const e = s.terms.find((t) => t.key === key);
    if (e?.termId) localStorage.setItem(activeKey(sid), e.termId);
    this.changed();
  }

  close(sid: string, key: string): void {
    const s = this.get(sid);
    const k = s.terms.findIndex((t) => t.key === key);
    const e = s.terms[k];
    if (!e) return;
    if (e.termId && e.alive) void this.client.termClose(sid, e.termId).catch(() => undefined);
    this.dispose(e);
    s.terms.splice(k, 1);
    if (s.active === key) s.active = (s.terms[k] ?? s.terms[k - 1])?.key ?? null;
    if (s.terms.length === 0) s.autoDone = true; // закрыл все сам — не открываем заново
    this.changed();
  }

  retry(sid: string): void {
    const s = this.get(sid);
    s.status = 'idle';
    s.error = null;
    s.openError = null;
    void this.ensure(sid);
  }

  private dispose(e: TermEntry): void {
    e.unsub?.();
    e.unsub = null;
    if (e.resizeTimer) clearTimeout(e.resizeTimer);
    e.xterm.dispose();
    e.host.remove();
  }

  /** Вставить xterm активного терминала в контейнер вкладки и подогнать размер. */
  mount(sid: string, container: HTMLElement | null): void {
    if (!container) return;
    const s = this.get(sid);
    const e = this.activeEntry(s);
    if (!e) {
      container.replaceChildren();
      return;
    }
    if (e.host.parentElement !== container) container.replaceChildren(e.host);
    if (!e.opened) {
      e.xterm.open(e.host);
      e.opened = true;
    }
    this.fit(sid);
  }

  /** Подогнать активный терминал под контейнер; изменился размер — сообщить серверу (с задержкой). */
  fit(sid: string): void {
    const e = this.activeEntry(this.get(sid));
    if (!e?.opened || !e.host.isConnected || e.host.clientWidth === 0) return;
    try { e.fit.fit(); } catch { return; }
    this.sendResize(this.get(sid), e, false);
  }

  focus(sid: string): void {
    this.activeEntry(this.get(sid))?.xterm.focus();
  }

  private sendResize(s: SessionTerms, e: TermEntry, force: boolean): void {
    const cols = e.xterm.cols;
    const rows = e.xterm.rows;
    if (!force && cols === e.size.cols && rows === e.size.rows) return;
    e.size = { cols, rows };
    if (!e.termId || !e.alive) return;
    if (e.resizeTimer) clearTimeout(e.resizeTimer);
    e.resizeTimer = setTimeout(() => {
      e.resizeTimer = null;
      if (e.termId && e.alive) void this.client.termResize(s.sid, e.termId, e.size.cols, e.size.rows).catch(() => undefined);
    }, 120);
  }
}

const managers = new WeakMap<SupervisorClient, TermManager>();

export function termManager(client: SupervisorClient): TermManager {
  let m = managers.get(client);
  if (!m) {
    m = new TermManager(client);
    managers.set(client, m);
  }
  return m;
}
