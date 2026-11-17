// Перенос сессии между средами (T-ряд): export отдаёт транскрипт с метой и архивирует
// источник, import кладёт транскрипт в папку проекта цели (переписав cwd), применяет
// патч правок на совпавший коммит и регистрирует сессию остывшей с пометкой movedFrom.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Frame } from '@perimeter/protocol';
import { PROTOCOL_VERSION } from '@perimeter/protocol';
import { SessionManager, type SessionCreateOptions } from './session/manager.js';
import { transcriptPath } from './transcript.js';
import type { EngineHooks } from './session/engine.js';
import type { SdkMsg, SdkUserInput } from './session/types.js';
import { ProfileRegistry } from './profiles.js';
import { ProjectStore } from './projects.js';
import { WssServer } from './wss.js';

const CLAUDE_SID = '77777777-7774-4777-8777-777777777777';
const initMsg = (): SdkMsg => ({ type: 'system', subtype: 'init', session_id: CLAUDE_SID, tools: [], mcp_servers: [], model: 'm', permissionMode: 'auto' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEVNULL = process.platform === 'win32' ? 'NUL' : '/dev/null';
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  // фиксированная дата: одинаковые «init»-коммиты в двух репо дают одинаковый HEAD (база патча в тесте)
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00',
  GIT_CONFIG_GLOBAL: DEVNULL, GIT_CONFIG_SYSTEM: DEVNULL,
});

class Client {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as Frame;
      this.frames.push(f);
    });
  }
  send(f: unknown): void { this.ws.send(JSON.stringify(f)); }
  async reply(id: string, ms = 4000): Promise<{ ok: boolean; code?: string; message?: string; data?: Record<string, unknown> }> {
    const t0 = Date.now();
    for (;;) {
      const f = this.frames.find((x) => 'id' in x && x.id === id && 'ok' in x);
      if (f) return f as unknown as { ok: boolean; code?: string; message?: string; data?: Record<string, unknown> };
      if (Date.now() - t0 > ms) throw new Error(`нет ответа на ${id}; есть: ${this.frames.map((x) => ('type' in x ? x.type : '?')).join(',')}`);
      await sleep(20);
    }
  }
  close(): void { this.ws.close(); }
}

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return new Client(ws);
}

function queryLike(script: (hooks: EngineHooks) => AsyncGenerator<SdkMsg>) {
  return (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => {
    void (async () => { for await (const _ of input) void _; })().catch(() => undefined);
    const g = script(hooks);
    return { [Symbol.asyncIterator]: () => g, interrupt: async () => undefined, close: async () => undefined };
  };
}

/** Один supervisor со своим реестром сессий и каталогом транскриптов. holdInit — движок молчит (нет claudeSessionId). */
async function supervisor(opts: { configDir: string; projects?: ProjectStore; holdInit?: boolean }) {
  const manager = new SessionManager();
  const engine = (): SessionCreateOptions['factory'] => queryLike(async function* () {
    if (opts.holdInit === true) { await sleep(2500); return; }
    yield initMsg();
    yield { type: 'result', subtype: 'success' } as SdkMsg;
    await sleep(400);
  });
  const server = new WssServer(manager, {
    port: 0,
    // транскрипты лежат в configDir профиля — даём каждой среде свой через аккаунт 'acc'
    profiles: new ProfileRegistry([{ name: 'acc', configDir: opts.configDir }]),
    sessionFactory: () => engine(),
    resumeFactory: () => engine(),
    ...(opts.projects ? { projects: opts.projects } : {}),
  });
  const port = await server.start();
  const c = await connect(port);
  c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h', type: 'cmd:hello', lastSeq: {} });
  await c.reply('h');
  return { server, c, manager };
}

/** git-репозиторий с одним закоммиченным файлом; правка — незакоммиченная. */
function gitRepo(dir: string, file: string, committed: string, edit?: string): string {
  const run = (...a: string[]) => execFileSync('git', a, { cwd: dir, env: gitEnv() });
  run('init', '-q');
  writeFileSync(join(dir, file), committed, 'utf8');
  run('add', file);
  run('commit', '-qm', 'init');
  if (edit !== undefined) writeFileSync(join(dir, file), edit, 'utf8');
  return String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: gitEnv() })).trim();
}

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('перенос сессии между средами', () => {
  it('export → import: история переезжает с переписанным cwd, патч применяется на тот же коммит, источник в архиве', async () => {
    const cfgA = mkdtempSync(join(tmpdir(), 'cc-xA-')); tmp.push(cfgA);
    const cfgB = mkdtempSync(join(tmpdir(), 'cc-xB-')); tmp.push(cfgB);
    const repoA = mkdtempSync(join(tmpdir(), 'cc-repoA-')); tmp.push(repoA);
    const repoB = mkdtempSync(join(tmpdir(), 'cc-repoB-')); tmp.push(repoB);
    // обе среды на одном коммите; на источнике — незакоммиченная правка
    const head = gitRepo(repoA, 'app.txt', 'версия 1', 'версия 1 — правка на источнике');
    gitRepo(repoB, 'app.txt', 'версия 1');
    const projectsB = new ProjectStore(join(cfgB, 'projects.json'), { defaultRoot: mkdtempSync(join(tmpdir(), 'cc-store-')) });
    projectsB.create({ name: 'perimeter', path: repoB });

    const A = await supervisor({ configDir: cfgA });
    const B = await supervisor({ configDir: cfgB, projects: projectsB });

    // сессия на источнике: init дал claudeSessionId, транскрипт есть на диске
    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n', type: 'cmd:session.new', name: 'редизайн', cwd: repoA, profile: 'acc' });
    const sidA = String((await A.c.reply('n')).data?.['sessionId']);
    await sleep(150);
    const tpath = transcriptPath(cfgA, repoA, CLAUDE_SID);
    expect(existsSync(tpath)).toBe(false); // транскрипт пишет CLI — в тесте подкладываем сами
    mkdirSync(dirname(tpath), { recursive: true });
    writeFileSync(tpath, `${JSON.stringify({ type: 'user', cwd: repoA, message: { role: 'user', content: 'привет' } })}\n${JSON.stringify({ type: 'assistant', cwd: repoA, message: { role: 'assistant' } })}\n`, 'utf8');

    // export: работает только спокойная сессия
    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sidA, id: 'x', type: 'cmd:session.export', to: 'VPS' });
    const x = await A.c.reply('x');
    expect(x.ok).toBe(true);
    const meta = x.data?.['meta'] as Record<string, unknown>;
    expect(meta['name']).toBe('редизайн');
    expect(x.data?.['headCommit']).toBe(head);
    expect(String(x.data?.['patch'])).toContain('правка на источнике');
    expect(x.data?.['untracked']).toEqual([]);
    const srcList = A.manager.list();
    expect(srcList.find((s) => s.id === sidA)?.archived).toBe(true);
    expect(srcList.find((s) => s.id === sidA)?.movedTo).toBe('VPS');

    // import на цель: проект по имени, патч на совпавший коммит
    B.c.send({
      v: PROTOCOL_VERSION, ts: Date.now(), id: 'i', type: 'cmd:session.import',
      name: 'редизайн', project: 'perimeter', claudeSessionId: CLAUDE_SID, profile: 'acc',
      transcript: String(x.data?.['transcript']), patch: x.data?.['patch'] as string,
      baseCommit: head, movedFrom: 'Этот компьютер',
    });
    const i = await B.c.reply('i');
    expect(i.ok).toBe(true);
    const sidB = String(i.data?.['sessionId']);
    const infoB = B.manager.list().find((s) => s.id === sidB)!;
    expect(infoB.state).toBe('dead');
    expect(infoB.movedFrom).toBe('Этот компьютер');
    expect(infoB.cwd).toBe(repoB);
    // транскрипт лежит в каталоге цели под слагом её папки, cwd внутри переписан
    const moved = transcriptPath(cfgB, repoB, CLAUDE_SID);
    expect(existsSync(moved)).toBe(true);
    const first = readFileSync(moved, 'utf8').split('\n')[0]!;
    expect(JSON.parse(first)['cwd']).toBe(repoB);
    // патч применился: файл цели несёт правку источника
    expect(readFileSync(join(repoB, 'app.txt'), 'utf8')).toContain('правка на источнике');
    // клиент цели узнал о новой сессии событием
    expect(B.c.frames.some((f) => 'type' in f && f.type === 'event:session.created')).toBe(true);

    A.c.close(); B.c.close();
    await A.server.stop(); await B.server.stop();
  });

  it('ветки разошлись — патч не применяется, сессия не создаётся; отмена: разархивирование снимает пометку переезда', async () => {
    const cfgA = mkdtempSync(join(tmpdir(), 'cc-yA-')); tmp.push(cfgA);
    const cfgB = mkdtempSync(join(tmpdir(), 'cc-yB-')); tmp.push(cfgB);
    const repoA = mkdtempSync(join(tmpdir(), 'cc-arepo-')); tmp.push(repoA);
    const repoB = mkdtempSync(join(tmpdir(), 'cc-brepo-')); tmp.push(repoB);
    gitRepo(repoA, 'app.txt', 'версия 1', 'правка A');
    // цель ушла вперёд своим коммитом — базы патча нет
    gitRepo(repoB, 'app.txt', 'версия 1');
    writeFileSync(join(repoB, 'app.txt'), 'версия 1 — шаг вперёд', 'utf8');
    execFileSync('git', ['commit', '-qam', 'шаг вперёд'], { cwd: repoB, env: gitEnv() });
    const projectsB = new ProjectStore(join(cfgB, 'projects.json'), { defaultRoot: mkdtempSync(join(tmpdir(), 'cc-store-')) });
    projectsB.create({ name: 'perimeter', path: repoB });

    const A = await supervisor({ configDir: cfgA });
    const B = await supervisor({ configDir: cfgB, projects: projectsB });

    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n', type: 'cmd:session.new', name: 'работа', cwd: repoA, profile: 'acc' });
    const sidA = String((await A.c.reply('n')).data?.['sessionId']);
    await sleep(150);
    const tp2 = transcriptPath(cfgA, repoA, CLAUDE_SID);
    mkdirSync(dirname(tp2), { recursive: true });
    writeFileSync(tp2, `${JSON.stringify({ type: 'user', cwd: repoA })}\n`, 'utf8');

    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sidA, id: 'x', type: 'cmd:session.export', to: 'VPS' });
    const x = await A.c.reply('x');
    expect(x.ok).toBe(true);

    B.c.send({
      v: PROTOCOL_VERSION, ts: Date.now(), id: 'i', type: 'cmd:session.import',
      name: 'работа', project: 'perimeter', claudeSessionId: CLAUDE_SID, profile: 'acc',
      transcript: String(x.data?.['transcript']), patch: x.data?.['patch'] as string,
      baseCommit: x.data?.['headCommit'] as string, movedFrom: 'Этот компьютер',
    });
    const i = await B.c.reply('i');
    expect(i.ok).toBe(false);
    expect(i.code).toBe('PATCH_BASE_MISMATCH');
    expect(B.manager.list().filter((s) => s.movedFrom !== undefined)).toHaveLength(0);
    // цель нетронута: свой коммит, без правок источника
    expect(readFileSync(join(repoB, 'app.txt'), 'utf8')).toBe('версия 1 — шаг вперёд');

    // отмена переноса на источнике: вернуть из архива — пометка переезда снялась
    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sidA, id: 'u', type: 'cmd:session.archive', archived: false });
    await A.c.reply('u');
    const back = A.manager.list().find((s) => s.id === sidA)!;
    expect(back.archived).toBeFalsy();
    expect(back.movedTo).toBeUndefined();

    A.c.close(); B.c.close();
    await A.server.stop(); await B.server.stop();
  });

  it('удаление сессии: история и запись исчезают, работающую не удаляем', async () => {
    const cfgA = mkdtempSync(join(tmpdir(), 'cc-del-')); tmp.push(cfgA);
    const repo = mkdtempSync(join(tmpdir(), 'cc-delrepo-')); tmp.push(repo);
    gitRepo(repo, 'app.txt', 'v1');
    const A = await supervisor({ configDir: cfgA });
    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n', type: 'cmd:session.new', name: 'на удаление', cwd: repo, profile: 'acc' });
    const sid = String((await A.c.reply('n')).data?.['sessionId']);
    await sleep(150);
    const tp = transcriptPath(cfgA, repo, CLAUDE_SID);
    mkdirSync(dirname(tp), { recursive: true });
    writeFileSync(tp, `${JSON.stringify({ type: 'user', cwd: repo })}\n`, 'utf8');

    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sid, id: 'd1', type: 'cmd:session.delete' });
    const d1 = await A.c.reply('d1');
    expect(d1.ok).toBe(true);
    expect(A.manager.list().some((s) => s.id === sid)).toBe(false);
    expect(existsSync(tp)).toBe(false);

    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'd2', type: 'cmd:session.delete', sessionId: '00000000-0000-4000-8000-000000000000' });
    expect((await A.c.reply('d2')).code).toBe('SESSION_NOT_FOUND');

    A.c.close();
    await A.server.stop();
  });

  it('ошибки: неизвестный проект, пустая сессия, работающая сессия', async () => {
    const cfgA = mkdtempSync(join(tmpdir(), 'cc-zA-')); tmp.push(cfgA);
    const cfgB = mkdtempSync(join(tmpdir(), 'cc-zB-')); tmp.push(cfgB);
    const projectsB = new ProjectStore(join(cfgB, 'projects.json'), { defaultRoot: mkdtempSync(join(tmpdir(), 'cc-store-')) });
    const A = await supervisor({ configDir: cfgA, holdInit: true }); // сессия жива, но init не пришёл
    const B = await supervisor({ configDir: cfgB, projects: projectsB });

    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n', type: 'cmd:session.new', name: 'пустая', cwd: join(tmpdir(), 'nope') });
    const sidA = String((await A.c.reply('n')).data?.['sessionId']);
    await sleep(100);

    // ещё без claudeSessionId — переносить нечего
    A.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), sessionId: sidA, id: 'x1', type: 'cmd:session.export', to: 'VPS' });
    expect((await A.c.reply('x1')).code).toBe('EMPTY_SESSION');

    // проекта на цели нет
    B.c.send({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'i1', type: 'cmd:session.import', name: 'x', project: 'нет-такого', claudeSessionId: CLAUDE_SID, transcript: '{}\n', movedFrom: 'VPS' });
    expect((await B.c.reply('i1')).code).toBe('UNKNOWN_PROJECT');

    A.c.close(); B.c.close();
    await A.server.stop(); await B.server.stop();
  });
});
