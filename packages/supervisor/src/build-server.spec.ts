// Сборка supervisor'а для сервера (scripts/build-server.mjs, АДР 004): зависимости из lock-файла, версия по
// содержимому, файлы сборки; собранный бандл запускается и отвечает на cmd:hello своей версией.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Built { version: string; dir: string }
interface BuildModule {
  SERVER_FILES: string[];
  serverDeps(lock: unknown, names: string[]): { optionalDependencies: Record<string, string>; packages: Record<string, Record<string, unknown>> };
  buildServer(o: { outRoot: string; tag?: string }): Promise<Built>;
}

const scriptUrl = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'build-server.mjs')).href;
const serverDir = join(import.meta.dirname, '..', 'server');
let m: BuildModule;
let out: string;
let built: Built;

beforeAll(async () => {
  m = (await import(scriptUrl)) as BuildModule;
  out = mkdtempSync(join(tmpdir(), 'cc-build-'));
  built = await m.buildServer({ outRoot: out, tag: '' });
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('зависимости сервера из lock-файла', () => {
  const lock = {
    packages: {
      'node_modules/node-pty': { version: '1.1.0', resolved: 'https://r/node-pty.tgz', integrity: 'sha512-a', hasInstallScript: true, dependencies: { 'node-addon-api': '^7.1.0' } },
      'node_modules/node-addon-api': { version: '7.1.1', resolved: 'https://r/naa.tgz', integrity: 'sha512-b', dev: true },
      'packages/supervisor/node_modules/@x/cc-linux-x64': { version: '0.3.1', resolved: 'https://r/cc.tgz', integrity: 'sha512-c', os: ['linux'], cpu: ['x64'] },
    },
  };
  it('закреплённые версии, транзитивные тоже, всё необязательное; вложенный node_modules находится', () => {
    const d = m.serverDeps(lock, ['node-pty', '@x/cc-linux-x64']);
    expect(d.optionalDependencies).toEqual({ 'node-pty': '1.1.0', '@x/cc-linux-x64': '0.3.1' });
    expect(Object.keys(d.packages).sort()).toEqual(['node_modules/@x/cc-linux-x64', 'node_modules/node-addon-api', 'node_modules/node-pty']);
    expect(Object.values(d.packages).every((p) => p['optional'] === true)).toBe(true);
    expect(d.packages['node_modules/node-addon-api']).not.toHaveProperty('dev');
    expect(d.packages['node_modules/@x/cc-linux-x64']).toMatchObject({ integrity: 'sha512-c', os: ['linux'] });
  });
  it('нет пакета или integrity — ошибка, а не сборка без проверки', () => {
    expect(() => m.serverDeps(lock, ['нет-такого'])).toThrow(/нет-такого/);
    expect(() => m.serverDeps({ packages: { 'node_modules/a': { version: '1' } } }, ['a'])).toThrow(/integrity/);
  });
});

describe('сборка', () => {
  it('версия = версия пакета + хэш; повтор — та же; метка — другая', async () => {
    expect(built.version).toMatch(/^0\.1\.0-[0-9a-f]{8}$/);
    expect((await m.buildServer({ outRoot: out, tag: '' })).version).toBe(built.version);
    expect((await m.buildServer({ outRoot: out, tag: 'проверка отката' })).version).not.toBe(built.version);
  }, 60_000);

  it('файлы сборки: версия вшита в бандл и манифест, lock согласован с package.json, скрипты без CR', () => {
    const read = (f: string) => readFileSync(join(built.dir, f), 'utf8');
    for (const f of m.SERVER_FILES) expect(read(f).length).toBeGreaterThan(0);
    const code = read('supervisor.mjs');
    expect(code).toContain(built.version);
    expect(code).not.toContain('__PERIMETER_BUILD_ID_PLACEHOLDER__');
    expect(JSON.parse(read('manifest.json')).version).toBe(built.version);
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.packages[''].optionalDependencies).toEqual(pkg.optionalDependencies);
    expect(Object.keys(pkg.optionalDependencies)).toEqual(expect.arrayContaining(['node-pty', '@anthropic-ai/claude-agent-sdk-linux-x64']));
    for (const [k, v] of Object.entries(lock.packages as Record<string, { integrity?: string }>)) if (k) expect(v.integrity).toMatch(/^sha512-/);
    const env = read('server.env');
    expect(env).toContain(`VERSION=${built.version}`);
    expect(env).toMatch(/NODE_SHA256_X64=[0-9a-f]{64}/);
    for (const f of ['perimeter-server.sh', 'start.sh', 'server.env']) expect(read(f)).not.toContain('\r');
  });

  it('скрипт сервера синтаксически цел (sh -n)', () => {
    const r = spawnSync('sh', ['-n', join(serverDir, 'perimeter-server.sh')], { encoding: 'utf8' });
    if (r.error) return; // нет sh на машине — проверка на сервере
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('собранный бандл', () => {
  it('запускается без исходников и отвечает на cmd:hello версией сборки', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    });
    const home = mkdtempSync(join(tmpdir(), 'cc-bundle-home-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, USERPROFILE: home, PERIMETER_PORT: String(port), PERIMETER_HOST: '127.0.0.1',
      PERIMETER_STATE: join(home, 'state.json'), PERIMETER_POOL_SIZE: '0', CLAUDE_CONFIG_DIR: join(home, '.claude'),
    };
    for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[k];
    const child = spawn(process.execPath, [join(built.dir, 'supervisor.mjs')], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += String(d); });
    child.stderr.on('data', (d) => { log += String(d); });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`supervisor не поднялся: ${log}`)), 20_000);
        const check = () => { if (log.includes('ws://')) { clearTimeout(t); resolve(); } else setTimeout(check, 100); };
        check();
      });
      const version = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('open', () => ws.send(JSON.stringify({ v: 1, ts: Date.now(), id: 'h', type: 'cmd:hello', lastSeq: {} })));
        ws.on('message', (d) => {
          const f = JSON.parse(String(d)) as { type: string; server?: { version: string } };
          if (f.type === 'event:hello') { ws.close(); resolve(f.server!.version); }
        });
        ws.on('error', reject);
      });
      expect(version).toBe(built.version);
    } finally {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
