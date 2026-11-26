// Канал npm: версия — из реестра, обновление — помощником после выхода приложения.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newer, npmChannel, registryUrl } from './npm-channel.mjs';
import { AppUpdater } from './updater.mjs';

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('канал npm', () => {
  it('сравнение версий и адрес в реестре для scoped-имени', () => {
    expect(newer('0.2.14', '0.2.13')).toBe(true);
    expect(newer('0.3.0', '0.2.99')).toBe(true);
    expect(newer('0.2.13', '0.2.13')).toBe(false);
    expect(newer('0.2.9', '0.2.10')).toBe(false);
    expect(registryUrl('@revealyan/perimeter')).toBe('https://registry.npmjs.org/@revealyan%2Fperimeter/latest');
  });

  it('последняя версия — из реестра; обновление: помощник на системном Node с pid, режимом и версией, затем выход', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'npmch-'));
    dirs.push(dir);
    const calls = [];
    let quit = 0;
    const ch = npmChannel({
      spec: '@revealyan/perimeter', mode: 'global', quit: () => { quit++; }, dir,
      fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ version: '0.2.14' }) }; },
      spawnImpl: (cmd, args) => { calls.push([cmd, ...args]); return { unref() {} }; },
    });
    expect(await ch.latest()).toBe('0.2.14');
    const r = ch.install('0.2.14');
    const [cmd, script, pid, mode, spec, log] = calls[1];
    expect([cmd, pid, mode, spec, log]).toEqual(['node', String(process.pid), 'global', '@revealyan/perimeter@0.2.14', join(dir, 'npm-update.log')]);
    expect(readFileSync(script, 'utf8')).toContain("spawnSync('npm', ['i', '-g', spec]");
    expect(r.script).toBe(script);
    expect(quit).toBe(1);
    rmSync(script, { force: true });
  });

  it('AppUpdater в режиме npm: проверка по реестру → «есть vX» → обновить = помощник; та же версия — «последняя»', async () => {
    const states = [];
    const installed = [];
    const npm = { mode: 'npx', latest: async () => '0.2.14', install: (v) => installed.push(v) };
    const a = new AppUpdater({ updater: null, version: '0.2.13', portable: false, packaged: true, npm, onState: (s) => states.push(s) });
    expect(a.state.state).toBe('idle');
    await a.check();
    expect(a.state).toMatchObject({ state: 'available', version: '0.2.14', npm: true });
    expect(a.install()).toBe(true);
    expect(installed).toEqual(['0.2.14']);
    const b = new AppUpdater({ updater: null, version: '0.2.14', portable: false, packaged: true, npm, onState: () => undefined });
    await b.check();
    expect(b.state.state).toBe('latest');
  });
});
