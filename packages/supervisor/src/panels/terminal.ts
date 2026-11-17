// Терминалы панели: живут в supervisor'е, а не в сокете (переживают реконнект клиента).
// Реестр termId → { сессия, процесс, scrollback (кольцо ~200 КБ), подписчики-сокеты }.
//
// Бэкенды (по убыванию качества):
//   1. node-pty (optionalDependency, грузится динамически) — настоящий pty, mode 'pty';
//   2. Linux без node-pty: `script -qfc "<shell>" /dev/null` (util-linux даёт настоящий pty) — mode 'pty',
//      размер окна задаётся через `stty -F /dev/pts/N` снаружи;
//   3. пайпы — mode 'pipe': Windows — powershell `-Command -` с подставным приглашением, Linux — `<shell> -i`.
//      Pty нет, поэтому supervisor сам эмулирует «канонический режим» терминала: эхо набора,
//      Backspace/^U/^C/^D, отдаёт шеллу целые строки. Клиенту не нужно ничего особенного (локальное эхо НЕ делать).
//
// Поток вывода (event:term.output/exit) адресный: только подписанным сокетам, seq 0, без sessionId,
// мимо ринг-буфера сессии. Вывод склеивается пачками (flushMs / flushBytes).

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PROTOCOL_VERSION } from '@perimeter/protocol';
import { PanelError } from './errors.js';
import { resolveInRoot } from './paths.js';

export type TermMode = 'pty' | 'pipe';
export type TermBackendPref = 'auto' | 'pty' | 'pipe';

/** Подписчик потока терминала (обычно — сокет клиента): получает готовый JSON-кадр. */
export interface TermSubscriber {
  /** kind: 'output' можно пропустить при перегрузе (догон — attach), 'exit' — нельзя */
  send(raw: string, kind: 'output' | 'exit'): void;
}

export interface TermInfo {
  termId: string;
  shell: string;
  /** папка терминала относительно корня сессии ('' — корень) */
  cwd: string;
  mode: TermMode;
  alive: boolean;
  exitCode?: number | null;
}

export interface TerminalManagerOptions {
  /** предпочтение бэкенда; по умолчанию env PERIMETER_TERM_MODE или 'auto' */
  backend?: TermBackendPref;
  /** гасить терминал без подписчиков через столько мс (по умолчанию 30 мин) */
  idleMs?: number;
  /** размер scrollback в символах (по умолчанию ~200 КБ) */
  scrollbackChars?: number;
  /** склейка вывода: не чаще раза в flushMs … */
  flushMs?: number;
  /** … или сразу, если накопилось flushBytes символов */
  flushBytes?: number;
  /** предел одновременно открытых терминалов */
  maxTerms?: number;
}

// ─── scrollback ──────────────────────────────────────────────────────────────

/** Кольцо текста: хранит последние cap символов (старое отрезается с головы). */
export class TextRing {
  private chunks: string[] = [];
  private len = 0;
  constructor(readonly cap: number) {}

  push(s: string): void {
    if (!s) return;
    this.chunks.push(s);
    this.len += s.length;
    while (this.len > this.cap && this.chunks.length > 0) {
      const over = this.len - this.cap;
      const first = this.chunks[0]!;
      if (first.length <= over) {
        this.chunks.shift();
        this.len -= first.length;
      } else {
        let cut = over;
        // не начинаем с «половинки» суррогатной пары
        const c = first.charCodeAt(cut);
        if (c >= 0xdc00 && c <= 0xdfff) cut += 1;
        this.chunks[0] = first.slice(cut);
        this.len -= cut;
      }
    }
  }

  get length(): number { return this.len; }

  toString(): string {
    const s = this.chunks.join('');
    this.chunks = s ? [s] : []; // заодно уплотняем
    return s;
  }
}

// ─── эмуляция канонического режима для pipe ──────────────────────────────────

export interface DisciplineResult {
  /** что показать в терминале (эхо набора) */
  echo: string;
  /** готовые строки для шелла (без перевода строки) */
  lines: string[];
  /** нажат ^C */
  interrupt: boolean;
  /** ^D на пустой строке — конец ввода */
  eof: boolean;
}

/**
 * Минимальная «линейная дисциплина» (как у tty в cooked-режиме): копит строку, делает эхо,
 * Backspace/^U правят строку, Enter отдаёт её шеллу, ^C сбрасывает, ^D на пустой строке — EOF.
 * Escape-последовательности (стрелки и т. п.) глотаются — истории/редактирования курсором нет.
 */
export class LineDiscipline {
  private line = '';
  private esc: 0 | 1 | 2 = 0; // 0 — обычный ввод; 1 — после ESC; 2 — внутри CSI/SS3
  private lastCR = false;

  feed(data: string): DisciplineResult {
    let echo = '';
    const lines: string[] = [];
    let interrupt = false;
    let eof = false;
    for (const ch of data) {
      if (this.esc === 1) { this.esc = ch === '[' || ch === 'O' ? 2 : 0; continue; }
      if (this.esc === 2) { if (ch >= '@' && ch <= '~') this.esc = 0; continue; }
      if (ch === '\n' && this.lastCR) { this.lastCR = false; continue; } // \r\n — одно нажатие
      this.lastCR = ch === '\r';
      switch (ch) {
        case '\x1b': this.esc = 1; break;
        case '\r':
        case '\n':
          echo += '\r\n';
          lines.push(this.line);
          this.line = '';
          break;
        case '\x7f':
        case '\b':
          if (this.line) {
            const cps = [...this.line];
            cps.pop();
            this.line = cps.join('');
            echo += '\b \b';
          }
          break;
        case '\x03':
          echo += '^C\r\n';
          this.line = '';
          interrupt = true;
          break;
        case '\x04':
          if (!this.line) eof = true;
          break;
        case '\x15':
          echo += '\b \b'.repeat([...this.line].length);
          this.line = '';
          break;
        case '\t':
          this.line += ' ';
          echo += ' ';
          break;
        default:
          if (ch < ' ') break; // прочие управляющие — игнор
          this.line += ch;
          echo += ch;
      }
    }
    return { echo, lines, interrupt, eof };
  }
}

// ─── процессы ────────────────────────────────────────────────────────────────

export interface TermProc {
  readonly pid: number | undefined;
  readonly mode: TermMode;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** убить дерево процессов */
  kill(): void;
  /** только pipe: ^C и ^D */
  interrupt?(): void;
  endInput?(): void;
  /** только pipe: как отдать шеллу набранную строку */
  sendLine?(line: string): void;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

type OnData = (s: string) => void;
type OnExit = (code: number | null) => void;

/** Минимальный интерфейс node-pty, который мы используем (сам модуль — optional). */
interface PtyLike {
  pid: number;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
}
interface PtyModule {
  spawn(file: string, args: string[], opts: { name?: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyLike;
}

let ptyLoad: Promise<PtyModule | null> | null = null;

/** Ленивая загрузка node-pty; если модуля нет/не собран — null (терминал уйдёт в фолбэк, демон не падает). */
export function loadNodePty(): Promise<PtyModule | null> {
  ptyLoad ??= (async () => {
    try {
      const spec = 'node-pty'; // через переменную: TS не требует типов модуля, бандлер не тянет его
      const m = (await import(/* @vite-ignore */ spec)) as { spawn?: unknown; default?: { spawn?: unknown } };
      const mod = typeof m.spawn === 'function' ? m : m.default;
      if (mod && typeof mod.spawn === 'function') return mod as PtyModule;
      console.warn('[term] node-pty загрузился без spawn — работаем без него');
      return null;
    } catch (err) {
      console.warn(`[term] node-pty недоступен (${String(err).slice(0, 200)}) — фолбэк без нативного pty`);
      return null;
    }
  })();
  return ptyLoad;
}

/** Найти исполняемый файл в PATH (только POSIX — для `script`). */
function findInPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '/usr/bin:/bin').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { if (statSync(p).isFile()) return p; } catch { /* нет — дальше */ }
  }
  return null;
}

const SHELLS_WITH_LOGIN = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish']);

/** Оболочка терминала: Linux — $SHELL или bash/sh (логин-шелл: PATH из профиля), Windows — powershell. */
export function resolveShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  const fromEnv = env.SHELL && path.isAbsolute(env.SHELL) && existsSync(env.SHELL) ? env.SHELL : null;
  const file = fromEnv ?? (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  return { file, args: SHELLS_WITH_LOGIN.has(path.basename(file)) ? ['-l'] : [] };
}

/** Окружение терминала: env supervisor'а + цветной xterm. */
function termEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'perimeter';
  return env;
}

/** Убить дерево процессов: Windows — taskkill /T /F; POSIX — сигнал группе (-pid). */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGHUP', done?: () => void): void {
  if (!pid) { done?.(); return; }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done?.());
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* уже мёртв */ }
  }
  done?.();
}

/** Общая обвязка дочернего процесса на пайпах: декодирование, выход строго один раз. */
function wireChild(child: ChildProcessWithoutNullStreams, onData: OnData, onExit: OnExit, transform: (s: string) => string): void {
  const decOut = new StringDecoder('utf8');
  const decErr = new StringDecoder('utf8');
  child.stdout.on('data', (b: Buffer) => { const s = decOut.write(b); if (s) onData(transform(s)); });
  child.stderr.on('data', (b: Buffer) => { const s = decErr.write(b); if (s) onData(transform(s)); });
  child.stdin.on('error', () => undefined); // EPIPE после смерти шелла
  let exited = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    onExit(code);
  };
  child.on('error', (err) => {
    onData(`\r\n[терминал: ${String(err.message)}]\r\n`);
    finish(null);
  });
  child.on('exit', (code, signal) => {
    // ждём, пока пайпы дочитаются ('close'), но не вечно: фоновые внуки могут держать их открытыми
    const c = signal ? null : code;
    const t = setTimeout(() => finish(c), 300);
    child.once('close', () => { clearTimeout(t); finish(c); });
  });
}

function spawnChild(file: string, args: string[], spec: SpawnSpec, env: Record<string, string>): ChildProcessWithoutNullStreams {
  const child = spawn(file, args, {
    cwd: spec.cwd, env, stdio: 'pipe', windowsHide: true,
    detached: process.platform !== 'win32', // POSIX: своя группа процессов → kill(-pid) гасит дерево
  });
  if (child.pid === undefined) {
    child.once('error', () => undefined);
    throw new Error(`не удалось запустить ${file}`);
  }
  return child;
}

function spawnNodePty(mod: PtyModule, spec: SpawnSpec, onData: OnData, onExit: OnExit): TermProc {
  const p = mod.spawn(spec.file, spec.args, { name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env });
  let exited = false;
  p.onData(onData);
  p.onExit(({ exitCode, signal }) => { exited = true; onExit(signal ? null : exitCode); });
  return {
    pid: p.pid,
    mode: 'pty',
    write: (d) => { if (!exited) p.write(d); },
    resize: (c, r) => { if (!exited) p.resize(c, r); },
    kill: () => {
      // дерево целиком (taskkill /T идёт по родителям — шелл должен быть ещё жив); conpty сам заметит
      // смерть шелла. p.kill() на Windows — только если выхода так и не случилось: его помощник
      // цепляется к консоли шелла и при уже мёртвом шелле падает с шумом в stderr
      killTree(p.pid, 'SIGHUP', () => {
        if (process.platform !== 'win32') return;
        setTimeout(() => {
          if (!exited) { try { p.kill(); } catch { /* уже закрыт */ } }
        }, 1000).unref();
      });
    },
  };
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Linux-фолбэк: настоящий pty от util-linux `script`; ресайз — `stty -F` на pts шелла. */
function spawnScript(scriptBin: string, spec: SpawnSpec, onData: OnData, onExit: OnExit): TermProc {
  const inner = [
    `export SHELL=${shQuote(spec.file)}`,
    `stty cols ${spec.cols} rows ${spec.rows} 2>/dev/null`,
    `exec ${[spec.file, ...spec.args].map(shQuote).join(' ')}`,
  ].join('; ');
  // script запускает команду через $SHELL -c — подсовываем /bin/sh, настоящий SHELL экспортируем внутри
  // без -e (код выхода шелла): у busybox-script этого флага нет, а -q/-f/-c есть везде
  const child = spawnChild(scriptBin, ['-qfc', inner, '/dev/null'], spec, { ...spec.env, SHELL: '/bin/sh' });
  wireChild(child, onData, onExit, (s) => s);
  let tty: string | null = null;
  const findTty = (): string | null => {
    if (tty) return tty;
    const pid = child.pid!;
    let kids: string[] = [];
    try {
      kids = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    } catch {
      // ядро без CONFIG_PROC_CHILDREN — ищем детей по ppid
      try {
        for (const d of readdirSync('/proc')) {
          if (!/^\d+$/.test(d)) continue;
          try {
            const st = readFileSync(`/proc/${d}/stat`, 'utf8');
            const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
            if (ppid === pid) kids.push(d);
          } catch { /* процесс исчез */ }
        }
      } catch { /* нет /proc */ }
    }
    for (const k of kids) {
      try {
        const l = readlinkSync(`/proc/${k}/fd/0`);
        if (l.startsWith('/dev/pts/')) { tty = l; return l; }
      } catch { /* нет доступа */ }
    }
    return null;
  };
  return {
    pid: child.pid,
    mode: 'pty',
    write: (d) => { if (child.stdin.writable) child.stdin.write(d); },
    resize: (c, r) => {
      const t = findTty();
      if (t) execFile('stty', ['-F', t, 'cols', String(c), 'rows', String(r)], () => undefined);
    },
    kill: () => killTree(child.pid, 'SIGHUP'),
  };
}

/** Приглашение для powershell в pipe-режиме (сам он в `-Command -` его не печатает). */
const PS_PROMPT = 'Write-Host -NoNewline ("PS " + $PWD.Path + "> ")';
const PS_INIT = "$ProgressPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; $OutputEncoding=[Text.Encoding]::UTF8";

/** Строка для powershell: не-ASCII передаём через base64 (кодировка stdin консоли — OEM, не UTF-8). */
export function psLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(line)) return line;
  const b64 = Buffer.from(line, 'utf8').toString('base64');
  return `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
}

/**
 * Приглашение для POSIX-шелла в pipe-режиме. `bash -i` без терминала сам эхоит набранную строку в stderr
 * (двойное эхо с нашей дисциплиной линии) и мешает приглашение с выводом — поэтому шелл запускаем
 * неинтерактивным, а приглашение печатаем сами после каждой строки (как для powershell).
 */
const SH_PROMPT = `printf '%s@%s:%s$ ' "\${USER:-$(id -un)}" "$(hostname -s 2>/dev/null || hostname)" "$(pwd | sed "s|^$HOME|~|")"`;
/** trap с обработчиком (не игнор): ^C убивает команду (у детей обработчик сбрасывается), а шелл живёт. */
const SH_INIT = `trap 'true' INT`;

/** Пайпы: без pty. Перевод строк \n → \r\n делаем сами (onlcr терминала). */
function spawnPipe(spec: SpawnSpec, onData: OnData, onExit: OnExit): TermProc {
  const win = process.platform === 'win32';
  const base = path.basename(spec.file);
  const isPs = /^(powershell|pwsh)(\.exe)?$/i.test(base);
  const isSh = !win && SHELLS_WITH_LOGIN.has(base) && base !== 'fish';
  const args = win && isPs
    ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-']
    : spec.args.filter((a) => a !== '-i');
  const child = spawnChild(spec.file, args, spec, spec.env);
  wireChild(child, onData, onExit, (s) => s.replace(/\r?\n/g, '\r\n'));
  const write = (s: string) => { if (child.stdin.writable) child.stdin.write(s); };
  if (isPs) write(`${PS_INIT}\n${PS_PROMPT}\n`);
  if (isSh) write(`${SH_INIT}\n${SH_PROMPT}\n`);
  return {
    pid: child.pid,
    mode: 'pipe',
    write,
    resize: () => undefined, // у пайпов нет размера окна
    kill: () => killTree(child.pid, 'SIGHUP'),
    sendLine: (line) => write(isPs ? `${psLine(line)}\n${PS_PROMPT}\n` : isSh ? `${line}\n${SH_PROMPT}\n` : `${line}\n`),
    interrupt: () => {
      if (win) {
        // прервать идущую команду без консоли нечем; хотя бы вернуть приглашение (покажется после команды)
        if (isPs) write(`${PS_PROMPT}\n`);
      } else if (child.pid) {
        // без job control дети шелла в его группе; интерактивный шелл сам SIGINT переживает
        try { process.kill(-child.pid, 'SIGINT'); } catch { /* мёртв */ }
      }
    },
    endInput: () => { if (child.stdin.writable) child.stdin.end(); },
  };
}

// ─── реестр ──────────────────────────────────────────────────────────────────

interface Term {
  id: string;
  sessionId: string;
  shell: string;
  cwd: string;
  mode: TermMode;
  proc: TermProc;
  discipline: LineDiscipline | null;
  scrollback: TextRing;
  subs: Set<TermSubscriber>;
  alive: boolean;
  exitCode: number | null;
  closing: boolean;
  pending: string[];
  pendingLen: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULTS = {
  // терминал без подписчиков гасится не сразу: в нём может жить dev-сервер, а UI просто закрыт.
  // 12 ч по умолчанию; PERIMETER_TERM_IDLE_MS переопределяет, 0 — не гасить никогда.
  idleMs: 12 * 60 * 60_000,
  scrollbackChars: 200 * 1024,
  flushMs: 20,
  flushBytes: 16 * 1024,
  maxTerms: 64,
};

/**
 * Запуск процесса с лучшим доступным терминалом: node-pty → util-linux script (Linux) → пайпы.
 * Общая для панели «Терминал» и входа в Claude Code (accounts.ts).
 */
export async function spawnProcAuto(backend: TermBackendPref, spec: SpawnSpec, onData: OnData, onExit: OnExit): Promise<TermProc> {
  if (backend !== 'pipe') {
    const mod = await loadNodePty();
    if (mod) {
      try {
        return spawnNodePty(mod, spec, onData, onExit);
      } catch (err) {
        console.warn(`[term] node-pty не смог запустить ${spec.file}: ${String(err).slice(0, 200)}`);
      }
    }
    if (process.platform === 'linux') {
      const scriptBin = findInPath('script');
      if (scriptBin) {
        try {
          return spawnScript(scriptBin, spec, onData, onExit);
        } catch (err) {
          console.warn(`[term] script не запустился: ${String(err).slice(0, 200)}`);
        }
      }
    }
    if (backend === 'pty') throw new PanelError('PTY_UNAVAILABLE', 'нет ни node-pty, ни util-linux script');
  }
  try {
    return spawnPipe(spec, onData, onExit);
  } catch (err) {
    throw new PanelError('TERM_SPAWN_FAILED', String(err).slice(0, 300));
  }
}

export class TerminalManager {
  private terms = new Map<string, Term>();
  private readonly backend: TermBackendPref;
  private readonly idleMs: number;
  private readonly scrollbackChars: number;
  private readonly flushMs: number;
  private readonly flushBytes: number;
  private readonly maxTerms: number;

  constructor(opts: TerminalManagerOptions = {}) {
    const envPref = process.env.PERIMETER_TERM_MODE;
    this.backend = opts.backend ?? (envPref === 'pty' || envPref === 'pipe' ? envPref : 'auto');
    const envIdle = Number(process.env.PERIMETER_TERM_IDLE_MS);
    this.idleMs = opts.idleMs ?? (Number.isFinite(envIdle) && process.env.PERIMETER_TERM_IDLE_MS !== '' && process.env.PERIMETER_TERM_IDLE_MS !== undefined ? envIdle : DEFAULTS.idleMs);
    this.scrollbackChars = opts.scrollbackChars ?? DEFAULTS.scrollbackChars;
    this.flushMs = opts.flushMs ?? DEFAULTS.flushMs;
    this.flushBytes = opts.flushBytes ?? DEFAULTS.flushBytes;
    this.maxTerms = opts.maxTerms ?? DEFAULTS.maxTerms;
  }

  /** Открыть терминал в папке сессии (cwd — подпапка корня) и подписать открывшего. */
  async open(p: { sessionId: string; root: string; cwd?: string; cols: number; rows: number; subscriber: TermSubscriber }): Promise<{ termId: string; mode: TermMode; shell: string; cwd: string }> {
    if (this.terms.size >= this.maxTerms) throw new PanelError('TOO_MANY_TERMS', `открыто уже ${this.terms.size} терминалов`);
    const r = await resolveInRoot(p.root, p.cwd ?? '');
    let isDir = false;
    try { isDir = statSync(r.abs).isDirectory(); } catch { /* исчезла */ }
    if (!isDir) throw new PanelError('NOT_A_DIR', `не папка: ${r.rel || '.'}`);

    const sh = resolveShell();
    const spec: SpawnSpec = { file: sh.file, args: sh.args, cwd: r.abs, cols: p.cols, rows: p.rows, env: termEnv() };
    const id = randomUUID();
    // процесс может заговорить (или умереть) до регистрации записи — копим это до неё
    let term: Term | null = null;
    const early: { data: string[]; exit: number | null | undefined } = { data: [], exit: undefined };
    const onData: OnData = (s) => { if (term) this.output(term, s); else early.data.push(s); };
    const onExit: OnExit = (code) => { if (term) this.exited(term, code); else early.exit = code; };

    const proc = await this.spawnProc(spec, onData, onExit);
    term = {
      id, sessionId: p.sessionId, shell: sh.file, cwd: r.rel, mode: proc.mode, proc,
      discipline: proc.mode === 'pipe' ? new LineDiscipline() : null,
      scrollback: new TextRing(this.scrollbackChars),
      subs: new Set([p.subscriber]),
      alive: true, exitCode: null, closing: false,
      pending: [], pendingLen: 0, flushTimer: null, idleTimer: null, killTimer: null,
    };
    this.terms.set(id, term);
    for (const s of early.data) this.output(term, s);
    if (early.exit !== undefined) this.exited(term, early.exit);
    return { termId: id, mode: term.mode, shell: term.shell, cwd: term.cwd };
  }

  /** Подписать сокет на уже открытый терминал; отдаёт scrollback (всё, что было до подписки). */
  attach(termId: string, subscriber: TermSubscriber, sessionId?: string): TermInfo & { scrollback: string } {
    const t = this.require(termId, sessionId);
    // хвост, ещё не разосланный старым подписчикам, — сперва в scrollback, иначе новый получит его дважды
    this.flush(t);
    t.subs.add(subscriber);
    this.disarmIdle(t);
    return { ...this.info(t), scrollback: t.scrollback.toString() };
  }

  /** Терминалы сессии (кроме закрываемых). */
  list(sessionId: string): TermInfo[] {
    return [...this.terms.values()].filter((t) => t.sessionId === sessionId && !t.closing).map((t) => this.info(t));
  }

  input(termId: string, data: string, sessionId?: string): void {
    const t = this.require(termId, sessionId);
    if (!t.alive) throw new PanelError('TERM_EXITED', 'процесс терминала уже завершился');
    if (!t.discipline) { t.proc.write(data); return; }
    const r = t.discipline.feed(data);
    if (r.echo) this.output(t, r.echo);
    for (const line of r.lines) t.proc.sendLine?.(line);
    if (r.interrupt) t.proc.interrupt?.();
    if (r.eof) t.proc.endInput?.();
  }

  resize(termId: string, cols: number, rows: number, sessionId?: string): void {
    const t = this.require(termId, sessionId);
    if (!t.alive) return;
    try { t.proc.resize(cols, rows); } catch { /* процесс на выходе */ }
  }

  /** Закрыть терминал: убить дерево процессов; запись уходит после выхода процесса. */
  close(termId: string, sessionId?: string): void {
    const t = this.require(termId, sessionId);
    this.closeTerm(t);
  }

  /** Сокет закрылся: отписать его от всех терминалов (терминалы живут дальше). */
  unsubscribe(subscriber: TermSubscriber): void {
    for (const t of this.terms.values()) {
      if (t.subs.delete(subscriber) && t.subs.size === 0) this.armIdle(t);
    }
  }

  /** Сессия остановлена/удалена — гасим её терминалы. */
  closeSession(sessionId: string): number {
    let n = 0;
    for (const t of [...this.terms.values()]) {
      if (t.sessionId === sessionId && !t.closing) { this.closeTerm(t); n++; }
    }
    return n;
  }

  /** Остановка supervisor'а: гасим всё и ждём выхода процессов (не дольше timeoutMs). */
  async stopAll(timeoutMs = 3000): Promise<void> {
    const all = [...this.terms.values()];
    for (const t of all) this.closeTerm(t);
    const deadline = Date.now() + timeoutMs;
    while (all.some((t) => t.alive) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const t of all) this.dispose(t);
  }

  get size(): number { return this.terms.size; }

  // ─── внутреннее ────────────────────────────────────────────────────────────

  private spawnProc(spec: SpawnSpec, onData: OnData, onExit: OnExit): Promise<TermProc> {
    return spawnProcAuto(this.backend, spec, onData, onExit);
  }

  private info(t: Term): TermInfo {
    return {
      termId: t.id, shell: t.shell, cwd: t.cwd, mode: t.mode, alive: t.alive,
      ...(t.alive ? {} : { exitCode: t.exitCode }),
    };
  }

  private require(termId: string, sessionId?: string): Term {
    const t = this.terms.get(termId);
    // чужая сессия в шапке — как будто терминала нет
    if (!t || t.closing || (sessionId !== undefined && t.sessionId !== sessionId)) {
      throw new PanelError('TERM_NOT_FOUND', `нет терминала ${termId}`);
    }
    return t;
  }

  private output(t: Term, s: string): void {
    if (!s) return;
    t.pending.push(s);
    t.pendingLen += s.length;
    if (t.pendingLen >= this.flushBytes) this.flush(t);
    else if (!t.flushTimer) t.flushTimer = setTimeout(() => { t.flushTimer = null; this.flush(t); }, this.flushMs);
  }

  private flush(t: Term): void {
    if (t.flushTimer) { clearTimeout(t.flushTimer); t.flushTimer = null; }
    if (t.pendingLen === 0) return;
    const data = t.pending.join('');
    t.pending = [];
    t.pendingLen = 0;
    t.scrollback.push(data);
    this.send(t, { type: 'event:term.output', termId: t.id, data });
  }

  private send(t: Term, body: { type: 'event:term.output'; termId: string; data: string } | { type: 'event:term.exit'; termId: string; code: number | null }): void {
    if (t.subs.size === 0) return;
    // seq 0 и без sessionId: поток терминала — вне нумерации и ринг-буфера сессии
    const raw = JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), seq: 0, ...body });
    const kind = body.type === 'event:term.exit' ? 'exit' : 'output';
    for (const s of t.subs) {
      try { s.send(raw, kind); } catch { /* сокет умирает — отпишется по close */ }
    }
  }

  private exited(t: Term, code: number | null): void {
    if (!t.alive) return;
    t.alive = false;
    t.exitCode = code;
    if (t.killTimer) { clearTimeout(t.killTimer); t.killTimer = null; }
    this.flush(t);
    this.send(t, { type: 'event:term.exit', termId: t.id, code: code !== null && Number.isInteger(code) ? code : null });
    if (t.closing) this.dispose(t);
    else if (t.subs.size === 0) this.armIdle(t);
  }

  private closeTerm(t: Term): void {
    if (t.closing) return;
    t.closing = true;
    if (!t.alive) { this.dispose(t); return; }
    try { t.proc.kill(); } catch { /* уже мёртв */ }
    // не умер по-хорошему — добиваем (POSIX: SIGKILL группе), а запись в любом случае убираем
    t.killTimer = setTimeout(() => {
      t.killTimer = null;
      if (!t.alive) return;
      if (process.platform !== 'win32') killTree(t.proc.pid, 'SIGKILL');
      setTimeout(() => this.exited(t, null), 1000).unref();
    }, 2000);
    t.killTimer.unref();
  }

  private dispose(t: Term): void {
    if (t.flushTimer) { clearTimeout(t.flushTimer); t.flushTimer = null; }
    this.disarmIdle(t);
    if (this.terms.get(t.id) === t) this.terms.delete(t.id);
  }

  private armIdle(t: Term): void {
    if (t.idleTimer || t.closing || this.idleMs <= 0) return;
    t.idleTimer = setTimeout(() => {
      t.idleTimer = null;
      if (t.subs.size === 0) this.closeTerm(t);
    }, this.idleMs);
    t.idleTimer.unref();
  }

  private disarmIdle(t: Term): void {
    if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null; }
  }
}
