// Докачка движка локальной среды: поток в файл с прогрессом, сверка integrity, зависшая загрузка — ошибка
// (а не вечное «докачиваю…»), повтор, уже поставленные пакеты при повторе не качаются заново.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadTo, ensureLocalServer } from './local-server.mjs';

const dirs = [];
const servers = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pm-ls-')); dirs.push(d); return d; };

/** tgz как у npm: всё внутри папки package/. */
async function makeTgz(name, files) {
  const root = tmp();
  mkdirSync(join(root, 'package'), { recursive: true });
  writeFileSync(join(root, 'package', 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(root, 'package', f), body);
  const file = join(root, `${name.replace(/\W/g, '_')}.tgz`);
  await create({ gzip: true, file, cwd: root }, ['package']);
  const buf = readFileSync(file);
  return { buf, integrity: `sha512-${createHash('sha512').update(buf).digest('base64')}` };
}

/** Сервер пакетов: path → буфер; hits — сколько раз просили; stallOnce — первый запрос пути зависает после заголовков. */
async function registry(routes, { stallOnce = new Set() } = {}) {
  const hits = {};
  const srv = createServer((req, res) => {
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    const buf = routes[req.url];
    if (!buf) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-length': String(buf.length) });
    if (stallOnce.has(req.url) && hits[req.url] === 1) { res.write(buf.subarray(0, 10)); return; } // и тишина
    res.end(buf);
  });
  servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, hits };
}

function bundle(base, pkgs, version = '0.1.0-test') {
  const dir = tmp();
  const packages = { '': { name: 'perimeter-local', version } };
  for (const p of pkgs) packages[`node_modules/${p.name}`] = { version: '1.0.0', resolved: `${base}/${p.path}`, integrity: p.integrity, optional: true };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(join(dir, 'supervisor.mjs'), '');
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
  return dir;
}

describe('downloadTo', () => {
  it('пишет файл потоком, отдаёт sha512 и прогресс до полного размера', async () => {
    const body = Buffer.alloc(3 * 1048576 + 7, 7);
    const { base } = await registry({ '/x.tgz': body });
    const file = join(tmp(), 'x.tgz');
    const seen = [];
    const sum = await downloadTo(`${base}/x.tgz`, file, { onProgress: (got, size) => seen.push([got, size]) });
    expect(sum).toBe(createHash('sha512').update(body).digest('base64'));
    expect(readFileSync(file).length).toBe(body.length);
    expect(seen.at(-1)).toEqual([body.length, body.length]);
    expect(seen.length).toBeGreaterThan(2); // промежуточные мегабайты видны
  });

  it('зависшая загрузка — понятная ошибка по таймауту, а не вечное ожидание', async () => {
    const { base } = await registry({ '/x.tgz': Buffer.alloc(1000, 1) }, { stallOnce: new Set(['/x.tgz']) });
    await expect(downloadTo(`${base}/x.tgz`, join(tmp(), 'x.tgz'), { stallMs: 150 })).rejects.toThrow(/загрузка встала/);
  });

  it('HTTP-ошибка — с кодом', async () => {
    const { base } = await registry({});
    await expect(downloadTo(`${base}/nope.tgz`, join(tmp(), 'x.tgz'))).rejects.toThrow(/HTTP 404/);
  });
});

describe('ensureLocalServer', () => {
  it('ставит пакеты, показывает мегабайты и распаковку, второй раз — ничего не качает', async () => {
    const a = await makeTgz('node-pty', { 'a.txt': 'A' });
    const b = await makeTgz('@anthropic-ai/claude-agent-sdk-win32-x64', { 'claude.exe': 'B' });
    const { base, hits } = await registry({ '/a.tgz': a.buf, '/b.tgz': b.buf });
    const bundleDir = bundle(base, [
      { name: 'node-pty', path: 'a.tgz', integrity: a.integrity },
      { name: '@anthropic-ai/claude-agent-sdk-win32-x64', path: 'b.tgz', integrity: b.integrity },
    ]);
    const installRoot = tmp();
    const status = [];
    const r = await ensureLocalServer({ bundleDir, installRoot, onStatus: (s) => status.push(s) });
    expect(readFileSync(join(r.dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'), 'utf8')).toBe('B');
    expect(status.some((s) => /2\/2 · claude-agent-sdk-win32-x64 · .* МБ/.test(s))).toBe(true);
    expect(status.some((s) => /распаковываю/.test(s))).toBe(true);
    await ensureLocalServer({ bundleDir, installRoot });
    expect(hits).toEqual({ '/a.tgz': 1, '/b.tgz': 1 });
  });

  it('зависание посреди — повтор той же загрузки; готовый пакет не перекачивается', async () => {
    const a = await makeTgz('node-pty', { 'a.txt': 'A' });
    const b = await makeTgz('big', { 'b.txt': 'B' });
    const { base, hits } = await registry({ '/a.tgz': a.buf, '/b.tgz': b.buf }, { stallOnce: new Set(['/b.tgz']) });
    const bundleDir = bundle(base, [
      { name: 'node-pty', path: 'a.tgz', integrity: a.integrity },
      { name: 'big', path: 'b.tgz', integrity: b.integrity },
    ]);
    const status = [];
    const r = await ensureLocalServer({ bundleDir, installRoot: tmp(), stallMs: 150, onStatus: (s) => status.push(s) });
    expect(existsSync(join(r.dir, 'node_modules', 'big', 'b.txt'))).toBe(true);
    expect(hits).toEqual({ '/a.tgz': 1, '/b.tgz': 2 });
    expect(status.some((s) => /сбой: .*встала.*ещё раз/.test(s))).toBe(true);
    expect(status.some((s) => /попытка 2/.test(s))).toBe(true);
  }, 15_000);

  it('после неудачной установки повтор не качает заново уже поставленные пакеты', async () => {
    const a = await makeTgz('node-pty', { 'a.txt': 'A' });
    const b = await makeTgz('big', { 'b.txt': 'B' });
    const routes = { '/a.tgz': a.buf };
    const { base, hits } = await registry(routes);
    const bundleDir = bundle(base, [
      { name: 'node-pty', path: 'a.tgz', integrity: a.integrity },
      { name: 'big', path: 'b.tgz', integrity: b.integrity },
    ]);
    const installRoot = tmp();
    await expect(ensureLocalServer({ bundleDir, installRoot })).rejects.toThrow(/не скачался big: HTTP 404/);
    routes['/b.tgz'] = b.buf; // registry «починился»
    await ensureLocalServer({ bundleDir, installRoot });
    expect(hits['/a.tgz']).toBe(1);
  }, 15_000);

  it('битая контрольная сумма — ошибка, пакет не помечается готовым', async () => {
    const a = await makeTgz('node-pty', { 'a.txt': 'A' });
    const { base } = await registry({ '/a.tgz': a.buf });
    const bundleDir = bundle(base, [{ name: 'node-pty', path: 'a.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }]);
    const installRoot = tmp();
    await expect(ensureLocalServer({ bundleDir, installRoot })).rejects.toThrow(/контрольная сумма/);
    expect(existsSync(join(installRoot, '0.1.0-test', '.installed'))).toBe(false);
  }, 15_000);
});
