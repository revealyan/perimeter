// Терминалы панели: режим pipe end-to-end (open → input → output → close → exit), адресность потока,
// attach со scrollback, гашение простаивающих, склейка вывода; pty — если на машине есть node-pty/script.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventSchema } from '@perimeter/protocol';
import { PanelError } from './errors.js';
import { LineDiscipline, loadNodePty, psLine, TerminalManager, TextRing, type TermSubscriber } from './terminal.js';

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER_SID = '22222222-2222-4222-8222-222222222222';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 15_000, what = 'условие'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`не дождались: ${what}`);
    await sleep(25);
  }
}

type F = { type: string; termId?: string; data?: string; code?: number | null; seq?: number; sessionId?: string };

class Sink implements TermSubscriber {
  frames: F[] = [];
  send(raw: string): void {
    const f = JSON.parse(raw) as F;
    // каждый кадр терминала обязан проходить общую схему событий
    EventSchema.parse(f);
    this.frames.push(f);
  }
  out(termId?: string): string {
    return this.frames.filter((f) => f.type === 'event:term.output' && (!termId || f.termId === termId)).map((f) => f.data).join('');
  }
  exit(termId: string): F | undefined {
    return this.frames.find((f) => f.type === 'event:term.exit' && f.termId === termId);
  }
}

/** «hi» отдельной строкой — вывод команды, а не эхо набора «echo hi». */
const HI_LINE = /(^|\n)hi\r?\n/;

/** Дождаться, пока шелл договорит стартовое приглашение (вывод есть и 200 мс тишины; не дольше 5 с). */
async function ready(s: Sink): Promise<void> {
  const deadline = Date.now() + 5000;
  let last = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const n = s.frames.length;
    if (n !== last) { last = n; quietSince = Date.now(); }
    if (n > 0 && Date.now() - quietSince >= 200) return;
    await sleep(25);
  }
}

const tmps: string[] = [];
const managers: TerminalManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stopAll();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-term-'));
  tmps.push(d);
  return d;
}
function mgr(opts: ConstructorParameters<typeof TerminalManager>[0] = {}): TerminalManager {
  const m = new TerminalManager({ backend: 'pipe', ...opts });
  managers.push(m);
  return m;
}
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (err) { return err instanceof PanelError ? err.code : String(err); }
  return undefined;
};

describe('терминал: режим pipe', () => {
  it('open → input `echo hi` → в output есть hi → close → exit; кадры seq 0 без sessionId', async () => {
    const root = tmp();
    mkdirSync(join(root, 'sub'));
    const m = mgr();
    const a = new Sink();
    const t = await m.open({ sessionId: SID, root, cwd: 'sub', cols: 80, rows: 24, subscriber: a });
    expect(t).toMatchObject({ mode: 'pipe', cwd: 'sub' });
    expect(t.shell).toMatch(process.platform === 'win32' ? /powershell/i : /sh$/);
    expect(m.list(SID)).toEqual([{ termId: t.termId, shell: t.shell, cwd: 'sub', mode: 'pipe', alive: true }]);
    expect(m.list(OTHER_SID)).toEqual([]);

    await ready(a); // человек печатает после приглашения — иначе «hi» встанет за приглашением, а не с начала строки
    m.input(t.termId, 'echo hi\r', SID);
    await until(() => HI_LINE.test(a.out(t.termId)), 20_000, 'hi в выводе');
    // эхо набора делает supervisor (дисциплина линии), шелл сам не эхоит
    expect(a.out(t.termId)).toContain('echo hi\r\n');

    m.close(t.termId, SID);
    expect(m.list(SID)).toEqual([]); // закрываемый уже не виден
    await until(() => a.exit(t.termId) !== undefined, 10_000, 'event:term.exit');
    for (const f of a.frames) {
      expect(f.seq).toBe(0);
      expect(f.sessionId).toBeUndefined();
    }
    await until(() => m.size === 0, 5000, 'запись удалена');
  }, 40_000);

  it('адресность: второй подписчик без attach ничего не получает; attach отдаёт scrollback, дальше — оба', async () => {
    const root = tmp();
    const m = mgr();
    const a = new Sink();
    const b = new Sink();
    const t = await m.open({ sessionId: SID, root, cols: 80, rows: 24, subscriber: a });
    await ready(a);
    m.input(t.termId, 'echo hi\r');
    await until(() => HI_LINE.test(a.out()), 20_000, 'hi у открывшего');
    await sleep(100);
    expect(b.frames).toEqual([]);

    const att = m.attach(t.termId, b, SID);
    expect(att).toMatchObject({ termId: t.termId, mode: 'pipe', alive: true, cwd: '' });
    expect(att.scrollback).toMatch(HI_LINE);
    expect(att.scrollback).toBe(a.out()); // scrollback = всё, что видел открывший (хвост не теряется и не дублируется)

    m.input(t.termId, 'echo bye\r');
    await until(() => /(^|\n)bye\r?\n/.test(b.out()) && /(^|\n)bye\r?\n/.test(a.out()), 20_000, 'bye у обоих');
    expect(b.out()).not.toMatch(HI_LINE); // старое b получил только через scrollback
  }, 40_000);

  it('отписка: терминал живёт без подписчиков, простаивающий дольше idleMs — гасится', async () => {
    const root = tmp();
    const m = mgr({ idleMs: 300 });
    const a = new Sink();
    const t = await m.open({ sessionId: SID, root, cols: 80, rows: 24, subscriber: a });
    m.unsubscribe(a);
    expect(m.list(SID)).toHaveLength(1); // сразу не гасим
    await until(() => m.list(SID).length === 0, 5000, 'гашение по простою');
    await until(() => m.size === 0, 8000, 'процесс умер');
    expect(a.exit(t.termId)).toBeUndefined(); // отписанному кадры не шлются
  }, 30_000);

  it('attach отменяет гашение; закрытие сессии гасит её терминалы', async () => {
    const root = tmp();
    const m = mgr({ idleMs: 400 });
    const a = new Sink();
    const t1 = await m.open({ sessionId: SID, root, cols: 80, rows: 24, subscriber: a });
    const t2 = await m.open({ sessionId: OTHER_SID, root, cols: 80, rows: 24, subscriber: a });
    m.unsubscribe(a);
    m.attach(t1.termId, a);
    m.attach(t2.termId, a);
    await sleep(700);
    expect(m.list(SID)).toHaveLength(1);
    expect(m.closeSession(SID)).toBe(1);
    expect(m.list(SID)).toHaveLength(0);
    expect(m.list(OTHER_SID)).toHaveLength(1);
    await until(() => a.exit(t1.termId) !== undefined, 10_000, 'exit t1');
  }, 30_000);

  it('шелл вышел сам: exit приходит, терминал виден как alive:false, attach отдаёт хвост, close убирает', async () => {
    const root = tmp();
    const m = mgr();
    const a = new Sink();
    const t = await m.open({ sessionId: SID, root, cols: 80, rows: 24, subscriber: a });
    await ready(a);
    m.input(t.termId, 'echo hi\r');
    await until(() => HI_LINE.test(a.out()), 20_000, 'hi');
    m.input(t.termId, 'exit 3\r');
    await until(() => a.exit(t.termId) !== undefined, 10_000, 'exit');
    expect(a.exit(t.termId)!.code).toBe(3);
    expect(m.list(SID)).toEqual([expect.objectContaining({ termId: t.termId, alive: false, exitCode: 3 })]);
    expect(codeOf(() => m.input(t.termId, 'x'))).toBe('TERM_EXITED');
    const b = new Sink();
    expect(m.attach(t.termId, b).scrollback).toMatch(HI_LINE);
    m.close(t.termId);
    expect(m.size).toBe(0);
  }, 40_000);

  it('склейка вывода: 60 нажатий подряд — одна-две пачки, а не кадр на символ', async () => {
    const root = tmp();
    const m = mgr({ flushMs: 30 });
    const a = new Sink();
    const t = await m.open({ sessionId: SID, root, cols: 80, rows: 24, subscriber: a });
    await ready(a);
    const before = a.frames.length;
    for (let i = 0; i < 60; i++) m.input(t.termId, 'x');
    await sleep(150);
    const echo = a.frames.slice(before).filter((f) => f.type === 'event:term.output');
    expect(echo.map((f) => f.data).join('')).toBe('x'.repeat(60));
    expect(echo.length).toBeLessThanOrEqual(2);
  }, 40_000);

  it('ошибки: чужая сессия в шапке и неизвестный termId — TERM_NOT_FOUND; cwd вне корня/не папка', async () => {
    const root = tmp();
    writeFileSync(join(root, 'f.txt'), 'x');
    const m = mgr();
    const a = new Sink();
    const t = await m.open({ sessionId: SID, root, cols: 80, rows: 24, subscriber: a });
    expect(codeOf(() => m.input(t.termId, 'x', OTHER_SID))).toBe('TERM_NOT_FOUND');
    expect(codeOf(() => m.attach('нет-такого', a))).toBe('TERM_NOT_FOUND');
    await expect(m.open({ sessionId: SID, root, cwd: '..', cols: 80, rows: 24, subscriber: a })).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    await expect(m.open({ sessionId: SID, root, cwd: 'f.txt', cols: 80, rows: 24, subscriber: a })).rejects.toMatchObject({ code: 'NOT_A_DIR' });
  }, 30_000);
});

describe('терминал: pty (если на машине есть node-pty или util-linux script)', async () => {
  const ptyAvailable = (await loadNodePty()) !== null || process.platform === 'linux';
  it.skipIf(!ptyAvailable)('open в auto → mode pty, ввод/вывод, resize, close → exit', async () => {
    const root = tmp();
    const m = new TerminalManager({ backend: 'auto' });
    managers.push(m);
    const a = new Sink();
    const t = await m.open({ sessionId: SID, root, cols: 100, rows: 30, subscriber: a });
    expect(t.mode).toBe('pty');
    // маркер, которого нет в набранной строке (иначе эхо tty даст ложное срабатывание)
    const cmd = process.platform === 'win32' ? "echo ('pt'+'y-ok')\r" : "echo pt''y-ok\r";
    m.input(t.termId, cmd);
    await until(() => a.out().includes('pty-ok'), 20_000, 'pty-ok');
    m.resize(t.termId, 120, 40);
    m.close(t.termId);
    await until(() => a.exit(t.termId) !== undefined, 10_000, 'exit');
  }, 40_000);
});

describe('дисциплина линии (pipe)', () => {
  it('эхо, Backspace, Enter (\\r и \\r\\n — одно нажатие), стрелки глотаются', () => {
    const d = new LineDiscipline();
    expect(d.feed('ab\x7fc\r')).toEqual({ echo: 'ab\b \bc\r\n', lines: ['ac'], interrupt: false, eof: false });
    expect(d.feed('ls\x1b[A\x1bOB -la\r\n')).toMatchObject({ echo: 'ls -la\r\n', lines: ['ls -la'] });
    expect(d.feed('a\r\nb\n').lines).toEqual(['a', 'b']);
  });

  it('^C сбрасывает строку, ^U стирает её, ^D — EOF только на пустой строке, юникод стирается по символу', () => {
    const d = new LineDiscipline();
    expect(d.feed('sleep 9\x03')).toMatchObject({ echo: 'sleep 9^C\r\n', lines: [], interrupt: true });
    expect(d.feed('abc\x15')).toMatchObject({ echo: 'abc\b \b\b \b\b \b', lines: [] });
    expect(d.feed('x\x04').eof).toBe(false);
    expect(d.feed('\x7f\x04').eof).toBe(true);
    expect(d.feed('я😀\x7f\r').lines).toEqual(['я']);
  });
});

describe('scrollback и мелочи', () => {
  it('кольцо держит последние cap символов и не рвёт суррогатную пару', () => {
    const r = new TextRing(10);
    r.push('0123456789');
    r.push('abc');
    expect(r.toString()).toBe('3456789abc');
    const s = new TextRing(3);
    s.push('a😀b'); // 4 code units: a, \ud83d, \ude00, b
    expect(s.toString()).toBe('😀b');
  });

  it('powershell: не-ASCII строка уходит через base64 (кодировка stdin консоли не UTF-8)', () => {
    expect(psLine('dir')).toBe('dir');
    const l = psLine('echo привет');
    expect(l).toMatch(/^Invoke-Expression \(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('/);
    const b64 = /'([^']+)'/.exec(l)![1]!;
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('echo привет');
  });
});
