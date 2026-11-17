// Хранилище проектов (P1–P3): корень среды, превью и создание проекта (пусто / git / готовая папка), обзор, mkdir.
// git — настоящий, на временных репозиториях (file://); клон «с токеном» в URL проверяет, что токен не утекает.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Frame } from '@perimeter/protocol';
import { PROTOCOL_VERSION } from '@perimeter/protocol';
import { SessionManager } from './session/manager.js';
import { ProjectStore } from './projects.js';
import { WssServer } from './wss.js';
import { maskUrl, normalizeRemote, planFor, sameRemote, validGitUrl } from './storage.js';

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cc-storage-')); dirs.push(d); return d; };
const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe', windowsHide: true }).toString().trim();

type R = { ok: boolean; code?: string; message?: string; data?: Record<string, unknown> };

class C {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) { ws.on('message', (d) => this.frames.push(JSON.parse(String(d)) as Frame)); }
  send(f: Record<string, unknown>): void { this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...f })); }
  async reply(id: string, ms = 20_000): Promise<R> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = this.frames.find((x) => 'ok' in x && x.id === id);
      if (f) return f as unknown as R;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`нет ответа на ${id}`);
  }
  async cmd(f: Record<string, unknown>, ms?: number): Promise<R> {
    const id = `c${Math.random().toString(36).slice(2)}`;
    this.send({ id, ...f });
    return this.reply(id, ms);
  }
}

async function setup() {
  const base = tmp();
  const root = join(base, 'projects');
  const file = join(base, 'projects.json');
  const projects = new ProjectStore(file, { defaultRoot: root });
  const server = new WssServer(new SessionManager(), { port: 0, projects, sessionFactory: () => { throw new Error('не нужно'); } });
  const port = await server.start();
  stops.push(() => server.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((ok, bad) => { ws.once('open', ok); ws.once('error', bad); });
  stops.push(async () => { ws.close(); });
  const c = new C(ws);
  c.send({ id: 'h', type: 'cmd:hello', lastSeq: {} });
  await c.reply('h');
  return { c, base, root, file };
}

/** Пустой «удалённый» репозиторий + адрес file:// для клона. */
function bareRepo(base: string, name = 'remote.git'): string {
  const p = join(base, name);
  git('init', '--bare', '-q', p);
  return pathToFileURL(p).href;
}

describe('адреса репозиториев', () => {
  it('https, ssh, scp-вид — один репозиторий; .git, слэш и учётные данные не мешают', () => {
    expect(normalizeRemote('https://github.com/o/r.git')).toBe('github.com/o/r');
    expect(sameRemote('git@github.com:o/r.git', 'https://GitHub.com/o/r/')).toBe(true);
    expect(sameRemote('ssh://git@github.com:22/o/r', 'https://user:tok@github.com/o/r.git')).toBe(true);
    expect(sameRemote('https://github.com/o/r', 'https://github.com/o/other')).toBe(false);
  });
  it('проверка адреса: без опций git и пробелов', () => {
    for (const ok of ['https://github.com/o/r.git', 'ssh://git@h/o/r', 'git@github.com:o/r.git', 'file:///C:/x/r.git']) expect(validGitUrl(ok)).toBe(true);
    for (const bad of ['-uploadpack=x', 'github.com/o/r', 'https://h/o r', '']) expect(validGitUrl(bad)).toBe(false);
  });
  it('токен в URL маскируется', () => {
    expect(maskUrl('fatal: https://yan:ghp_secret@github.com/o/r.git нет')).toBe('fatal: https://***@github.com/o/r.git нет');
  });
  it('план по источнику', () => {
    const none = { exists: false, isDir: false, empty: true };
    const dir = { exists: true, isDir: true, empty: false };
    expect(planFor('empty', none).plan).toBe('create');
    expect(planFor('empty', dir).plan).toBe('connect');
    expect(planFor('existing', none).plan).toBe('missing');
    expect(planFor('existing', dir).plan).toBe('connect');
    expect(planFor('git', none, 'https://h/o/r').plan).toBe('clone');
    expect(planFor('git', { ...dir, empty: true }, 'https://h/o/r').plan).toBe('clone');
    expect(planFor('git', dir, 'https://h/o/r')).toMatchObject({ plan: 'conflict' });
    expect(planFor('git', { ...dir, git: { origin: 'git@h:o/r.git', branch: 'main', head: 'abc', changed: 0 } }, 'https://h/o/r')).toMatchObject({ plan: 'connect', sameOrigin: true });
    expect(planFor('git', { ...dir, git: { origin: 'https://h/o/x', branch: 'main', head: 'abc', changed: 0 } }, 'https://h/o/r')).toMatchObject({ plan: 'conflict', sameOrigin: false });
    expect(planFor('empty', { exists: true, isDir: false, empty: false }).plan).toBe('conflict');
  });
});

describe('хранилище: корень среды', () => {
  it('hello отдаёт корень; storage.set создаёт папку и запоминает её до рестарта; относительный путь — ошибка', async () => {
    const { c, root, base, file } = await setup();
    const hello = c.frames.find((f) => 'type' in f && f.type === 'event:hello') as unknown as { storage: { root: string; exists: boolean } };
    expect(hello.storage).toMatchObject({ root, exists: false });

    expect((await c.cmd({ type: 'cmd:storage.set', root: 'projects' })).code).toBe('STORAGE_PATH');
    const next = join(base, 'другое', 'хранилище');
    const r = await c.cmd({ type: 'cmd:storage.set', root: next });
    expect(r.ok).toBe(true);
    expect(r.data!['storage']).toMatchObject({ root: next, exists: true });
    expect(existsSync(next)).toBe(true);
    expect(new ProjectStore(file, { defaultRoot: root }).root()).toBe(next);
  });
});

describe('новый проект: превью и создание', () => {
  it('пустой: create → папка создана; повтор с тем же именем — PROJECT_EXISTS; готовая папка — connect/missing', async () => {
    const { c, root, base } = await setup();
    const i1 = await c.cmd({ type: 'cmd:project.inspect', source: 'empty', slug: 'lending-studii' });
    expect(i1.data).toMatchObject({ path: join(root, 'lending-studii'), inStorage: true, exists: false, plan: 'create' });
    const c1 = await c.cmd({ type: 'cmd:project.create', name: 'лендинг студии', source: 'empty', slug: 'lending-studii' });
    expect(c1.data).toMatchObject({ action: 'created', path: join(root, 'lending-studii') });
    expect(existsSync(join(root, 'lending-studii'))).toBe(true);
    expect((await c.cmd({ type: 'cmd:project.create', name: ' Лендинг студии ', source: 'empty', slug: 'x' })).code).toBe('PROJECT_EXISTS');

    const outside = join(base, 'готовая');
    expect((await c.cmd({ type: 'cmd:project.inspect', source: 'existing', path: outside })).data).toMatchObject({ plan: 'missing', inStorage: false });
    expect((await c.cmd({ type: 'cmd:project.create', name: 'готовая', source: 'existing', path: outside })).code).toBe('PROJECT_PATH');
    mkdirSync(outside);
    const c2 = await c.cmd({ type: 'cmd:project.create', name: 'готовая', source: 'existing', path: outside });
    expect(c2.data).toMatchObject({ action: 'connected', path: outside });
    expect((await c.cmd({ type: 'cmd:project.inspect', source: 'empty', path: 'rel/path' })).code).toBe('PROJECT_PATH');
  });

  it('git: клон, подключение папки с тем же origin, конфликт с чужим, понятные ошибки', async () => {
    const { c, root, base } = await setup();
    const url = bareRepo(base);
    expect((await c.cmd({ type: 'cmd:project.inspect', source: 'git', slug: 'site', gitUrl: url })).data).toMatchObject({ plan: 'clone' });
    const c1 = await c.cmd({ type: 'cmd:project.create', name: 'сайт', source: 'git', slug: 'site', gitUrl: url }, 60_000);
    expect(c1.ok).toBe(true);
    expect(c1.data).toMatchObject({ action: 'cloned' });
    expect(existsSync(join(root, 'site', '.git'))).toBe(true);

    const same = await c.cmd({ type: 'cmd:project.inspect', source: 'git', slug: 'site', gitUrl: url.replace(/\.git$/, '') });
    expect(same.data).toMatchObject({ plan: 'connect', sameOrigin: true });
    expect((same.data!['git'] as { origin: string }).origin).toBe(url);
    const c2 = await c.cmd({ type: 'cmd:project.create', name: 'сайт-копия', source: 'git', slug: 'site', gitUrl: url });
    expect(c2.data).toMatchObject({ action: 'connected' });

    const other = bareRepo(base, 'other.git');
    const conf = await c.cmd({ type: 'cmd:project.inspect', source: 'git', slug: 'site', gitUrl: other });
    expect(conf.data).toMatchObject({ plan: 'conflict', sameOrigin: false });
    expect(String(conf.data!['reason'])).toContain('другой репозиторий');

    writeFileSync(join(root, 'notes.txt'), 'x');
    mkdirSync(join(root, 'busy'));
    writeFileSync(join(root, 'busy', 'a.txt'), 'x');
    expect((await c.cmd({ type: 'cmd:project.create', name: 'занято', source: 'git', slug: 'busy', gitUrl: url })).code).toBe('PROJECT_PATH');
    expect((await c.cmd({ type: 'cmd:project.create', name: 'опции', source: 'git', slug: 'o', gitUrl: '--upload-pack=touch' })).code).toBe('GIT_URL');
  });

  it('клон не удался — GIT_FAILED без токена из URL', async () => {
    const { c } = await setup();
    const r = await c.cmd({ type: 'cmd:project.create', name: 'нет', source: 'git', slug: 'nope', gitUrl: 'https://yan:ghp_supersecret@127.0.0.1:1/o/r.git' }, 60_000);
    expect(r.code).toBe('GIT_FAILED');
    expect(r.message).not.toContain('ghp_supersecret');
    expect(r.message).toContain('***@');
  });
});

describe('обзор проектов и пропавшая папка', () => {
  it('scan: есть ли папка, в хранилище ли, git; ничьи папки корня (без скрытых); mkdir возвращает папку', async () => {
    const { c, root, base } = await setup();
    const url = bareRepo(base);
    await c.cmd({ type: 'cmd:project.create', name: 'сайт', source: 'git', slug: 'site', gitUrl: url }, 60_000);
    const empty = await c.cmd({ type: 'cmd:project.create', name: 'пустой', source: 'empty', slug: 'empty-one' });
    const outside = join(base, 'вне');
    mkdirSync(outside);
    await c.cmd({ type: 'cmd:project.create', name: 'вне', source: 'existing', path: outside });
    for (const d of ['stray', '.hidden']) mkdirSync(join(root, d));

    const emptyId = (empty.data!['project'] as { id: string }).id;
    rmSync(join(root, 'empty-one'), { recursive: true, force: true });
    const s = await c.cmd({ type: 'cmd:project.scan' });
    const list = s.data!['projects'] as Array<{ name: string; exists: boolean; inStorage: boolean; git?: { origin: string | null } }>;
    expect(list.find((p) => p.name === 'сайт')).toMatchObject({ exists: true, inStorage: true, git: { origin: url } });
    expect(list.find((p) => p.name === 'пустой')).toMatchObject({ exists: false, inStorage: true });
    expect(list.find((p) => p.name === 'вне')).toMatchObject({ exists: true, inStorage: false });
    expect(list.find((p) => p.name === 'вне')!.git).toBeUndefined();
    expect(s.data!['orphans']).toEqual(['stray']);
    expect(s.data!['storage']).toMatchObject({ root, exists: true });

    const m = await c.cmd({ type: 'cmd:project.mkdir', projectId: emptyId });
    expect(m.ok).toBe(true);
    expect(existsSync(join(root, 'empty-one'))).toBe(true);
    expect((await c.cmd({ type: 'cmd:project.mkdir', projectId: 'нет' })).code).toBe('UNKNOWN_PROJECT');
  });
});
