// «Окружение»: что стоит, какой версии, чего нет и на что влияет; на сервере — какая возможность установщика
// это ставит, на своём компьютере — инструкция (не наши пакеты — молча не ставим).
import { describe, expect, it } from 'vitest';
import { probeEnv, type Runner } from './envProbe.js';

const out = (stdout: string, stderr = '') => ({ code: 0, stdout, stderr });
const miss = { code: null, stdout: '', stderr: 'ENOENT' };

function runner(table: Record<string, ReturnType<typeof out> | typeof miss>): Runner {
  return async (cmd, args) => {
    const key = `${cmd.split(/[\\/]/).pop()} ${args.join(' ')}`.replace(/^claude(\.exe)? /, 'claude ');
    for (const [k, v] of Object.entries(table)) if (key.startsWith(k)) return v;
    return miss;
  };
}

describe('окружение среды', () => {
  it('Linux-сервер: всё есть, кроме демона docker и Xvfb — warn с подробностью и возможностью установщика', async () => {
    const p = await probeEnv({
      platform: 'linux',
      run: runner({ 'claude --version': out('2.1.319 (Claude Code)'), 'git --version': out('git version 2.47.3'), 'ssh -V': { code: 0, stdout: '', stderr: 'OpenSSH_10.0p2 Debian-7, OpenSSL 3.5.4' }, 'python3 --version': out('Python 3.13.5'), 'gcc --version': out('gcc (Debian 14.2.0-19) 14.2.0'), 'make --version': out('GNU Make 4.4.1'), 'docker --version': out('Docker version 29.9.3, build x'), 'chromium --version': out('Chromium 156.0.8078.1') }),
      chromium: () => '/usr/bin/chromium', has: () => null, pty: async () => ({}), dockerHost: () => null, live: { count: 2, max: 7 },
    });
    const by = (id: string) => p.tools.find((t) => t.id === id)!;
    expect(by('claude')).toMatchObject({ status: 'ok', version: '2.1.319' });
    expect(by('git')).toMatchObject({ status: 'ok', version: '2.47.3', feature: 'git' });
    expect(by('ssh')).toMatchObject({ status: 'ok', version: '10.0' });
    expect(by('build')).toMatchObject({ status: 'ok', version: 'gcc 14.2.0' });
    expect(by('browser')).toMatchObject({ status: 'warn', version: '156.0.8078', feature: 'browser' });
    expect(by('browser').detail).toMatch(/нет Xvfb/);
    expect(by('docker')).toMatchObject({ status: 'warn', feature: 'docker', detail: 'клиент есть, демон не отвечает' });
    expect(p.live).toEqual({ count: 2, max: 7 });
  });

  it('rootless docker отвечает — ok с пометкой; нет git — missing и на что влияет', async () => {
    const p = await probeEnv({
      platform: 'linux',
      run: runner({ 'docker --version': out('Docker version 26.1.5'), 'docker info': out('26.1.5|["name=seccomp","name=rootless"]') }),
      chromium: () => null, has: () => '/usr/bin/Xvfb', pty: async () => null, dockerHost: () => 'unix:///run/user/1000/docker.sock',
    });
    const by = (id: string) => p.tools.find((t) => t.id === id)!;
    expect(by('docker')).toMatchObject({ status: 'ok', detail: 'rootless — под пользователем службы, без прав root' });
    expect(by('git')).toMatchObject({ status: 'missing', feature: 'git' });
    expect(by('git').affects).toMatch(/клона проектов/);
    expect(by('terminal')).toMatchObject({ status: 'warn', feature: 'terminal' });
    expect(by('browser')).toMatchObject({ status: 'missing', feature: 'browser' });
  });

  it('свой компьютер на Windows: без возможностей установщика — инструкции; сборки (gcc) не требуем', async () => {
    const p = await probeEnv({ platform: 'win32', run: runner({ 'git --version': out('git version 2.51.0.windows.1') }), chromium: () => 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', has: () => null, pty: async () => ({}), dockerHost: () => null });
    expect(p.tools.some((t) => t.feature !== undefined)).toBe(false);
    expect(p.tools.find((t) => t.id === 'build')).toBeUndefined();
    expect(p.tools.find((t) => t.id === 'docker')).toMatchObject({ status: 'missing' });
    expect(p.tools.find((t) => t.id === 'docker')!.hint).toMatch(/Docker Desktop/);
    expect(p.tools.find((t) => t.id === 'python')!.hint).toMatch(/python\.org/);
    expect(p.tools.find((t) => t.id === 'browser')).toMatchObject({ status: 'ok' });
  });
});
