// Установщик supervisor'а по ssh (АДР 004): разбор статуса, план, итог; установка и откат — на поддельном ssh2-клиенте
// (что уходит на сервер, построчный ход, защита от двух установок разом).
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerInstaller, parseStatus, planOf, resultMessage, serviceUserArg, shq } from './server-install.mjs';

const FILES = ['supervisor.mjs', 'package.json', 'package-lock.json', 'manifest.json', 'server.env', 'perimeter-server.sh', 'start.sh'];
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeBundle(version = '0.1.0-aaaaaaaa') {
  const dir = mkdtempSync(join(tmpdir(), 'cc-inst-'));
  dirs.push(dir);
  for (const f of FILES) writeFileSync(join(dir, f), f === 'perimeter-server.sh' ? '#!/bin/sh\necho скрипт\n' : f);
  return { version, dir };
}

/** Поддельный ssh2-клиент: ответы на exec по правилам, запись sftp-загрузок. */
function fakeClient(rules) {
  const c = { execs: [], puts: [], ended: false };
  c.exec = (cmd, cb) => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.end = (stdin) => {
      c.execs.push({ cmd, stdin });
      const rule = rules.find((r) => r.match.test(cmd)) ?? { out: '', code: 0 };
      setTimeout(() => {
        if (rule.out) stream.emit('data', Buffer.from(rule.out));
        if (rule.err) stream.stderr.emit('data', Buffer.from(rule.err));
        stream.emit('close', rule.code ?? 0);
      }, rule.delay ?? 0);
    };
    cb(undefined, stream);
  };
  c.sftp = (cb) => cb(undefined, {
    fastPut: (local, remote, done) => { c.puts.push({ local, remote }); done(); },
    end: () => undefined,
  });
  c.end = () => { c.ended = true; };
  return c;
}

const conn = { id: 'c-1', host: 'h', port: 22, user: 'root', remotePort: 8790, serviceUser: 'yan' };

describe('разбор статуса и план', () => {
  const text = 'mode=system\nssh_user=root\nsvc_user=yan\nsvc_home=/home/yan\narch=x86_64\nsystemd=yes\nunit=yes\nunit_user=yan\nunit_managed=yes\nactive=active\ncurrent=0.1.0-aaaaaaaa\nprevious=0.1.0-bbbbbbbb\nrunning=0.1.0-aaaaaaaa\nbusy=2\n';
  it('строки ключ=значение → статус', () => {
    expect(parseStatus(text)).toEqual({
      mode: 'system', sshUser: 'root', serviceUser: 'yan', serviceHome: '/home/yan', arch: 'x86_64', systemd: true, unit: true,
      unitUser: 'yan', managed: true, active: 'active', current: '0.1.0-aaaaaaaa', previous: '0.1.0-bbbbbbbb', running: '0.1.0-aaaaaaaa', busy: 2,
      packagesMissing: [], pkgManager: 'none',
    });
    expect(parseStatus('mode=user\nlinger=no\nbusy=\n')).toMatchObject({ mode: 'user', linger: 'no', busy: 0, managed: false });
  });
  it('план: служба из исходников — установить; другая версия — обновить; та же — ок; та же, но молчит — перезапуск', () => {
    expect(planOf(parseStatus('unit=yes\nunit_managed=no\nrunning=0.1.0'), 'v1')).toBe('install');
    expect(planOf(parseStatus('unit=no'), 'v1')).toBe('install');
    expect(planOf(parseStatus('unit_managed=yes\ncurrent=v0\nrunning=v0'), 'v1')).toBe('update');
    expect(planOf(parseStatus('unit_managed=yes\ncurrent=v1\nrunning=v1'), 'v1')).toBe('ok');
    expect(planOf(parseStatus('unit_managed=yes\ncurrent=v1\nrunning='), 'v1')).toBe('restart');
  });
  it('итог — строка «ОШИБКА:» при неудаче, иначе последняя непустая', () => {
    expect(resultMessage(['ставлю…', 'ОШИБКА: npm ci не прошёл', ''], false)).toBe('npm ci не прошёл');
    expect(resultMessage(['ставлю…', 'готово: supervisor v1 отвечает', ''], true)).toBe('готово: supervisor v1 отвечает');
    expect(resultMessage([], true)).toBe('готово');
  });
  it('пользователь службы: под root — из подключения, иначе — сам ssh-пользователь; кавычки sh', () => {
    expect(serviceUserArg({ user: 'root', serviceUser: 'yan' })).toBe('yan');
    expect(serviceUserArg({ user: 'root' })).toBe('');
    expect(serviceUserArg({ user: 'dev', serviceUser: 'yan' })).toBe('dev');
    expect(shq("a'b c")).toBe(`'a'\\''b c'`);
  });
});

describe('ServerInstaller на поддельном ssh', () => {
  it('статус: скрипт уходит через stdin, аргументы — пользователь и порт; соединение закрывается', async () => {
    const b = fakeBundle();
    const c = fakeClient([{ match: /status/, out: 'mode=system\nunit=yes\nunit_managed=yes\ncurrent=0.1.0-aaaaaaaa\nrunning=0.1.0-aaaaaaaa\nprevious=0.1.0-bbbbbbbb\n' }]);
    const inst = new ServerInstaller({ getBundle: async () => b, connect: async () => c });
    const st = await inst.status(conn);
    expect(st).toMatchObject({ ok: true, appVersion: b.version, plan: 'ok', previous: '0.1.0-bbbbbbbb', installing: false });
    expect(c.execs[0].cmd).toMatch(/sh -c .*cat >"\$f".* sh 'status' 'yan' '8790'$/);
    expect(c.execs[0].stdin).toContain('echo скрипт');
    expect(c.ended).toBe(true);
  });

  it('установка: временная папка, все файлы сборки по sftp, install с папкой/пользователем/портом, ход построчно', async () => {
    const b = fakeBundle('0.1.0-cccccccc');
    const c = fakeClient([
      { match: /^mktemp/, out: '/tmp/perimeter-install.AbC123\n' },
      { match: /perimeter-server\.sh' install/, out: 'Node уже есть\nготово: supervisor 0.1.0-cccccccc отвечает\n', err: 'npm warn что-то\n' },
    ]);
    const inst = new ServerInstaller({ getBundle: async () => b, connect: async () => c });
    const lines = [];
    const r = await inst.install(conn, (l) => lines.push(l));
    expect(r).toEqual({ ok: true, version: '0.1.0-cccccccc', message: 'готово: supervisor 0.1.0-cccccccc отвечает' });
    expect(c.puts.map((p) => p.remote)).toEqual(FILES.map((f) => `/tmp/perimeter-install.AbC123/${f}`));
    const cmd = c.execs[1].cmd;
    expect(cmd).toContain(`sh '/tmp/perimeter-install.AbC123/perimeter-server.sh' install '/tmp/perimeter-install.AbC123' 'yan' '8790'`);
    expect(cmd).toContain(`rm -rf '/tmp/perimeter-install.AbC123'`);
    expect(lines).toEqual(expect.arrayContaining(['сборка 0.1.0-cccccccc', 'Node уже есть', 'npm warn что-то']));
  });

  it('неудача на сервере — итог из «ОШИБКА:»; странная временная папка — ничего не грузим', async () => {
    const b = fakeBundle();
    const bad = fakeClient([{ match: /^mktemp/, out: '/tmp/perimeter-install.X\n' }, { match: /install/, out: 'ОШИБКА: supervisor не запускается под root — укажите обычного пользователя\n', code: 1 }]);
    const r1 = await new ServerInstaller({ getBundle: async () => b, connect: async () => bad }).install({ ...conn, serviceUser: '' });
    expect(r1).toMatchObject({ ok: false, message: 'supervisor не запускается под root — укажите обычного пользователя' });
    const odd = fakeClient([{ match: /^mktemp/, out: '/home/x\n' }]);
    const r2 = await new ServerInstaller({ getBundle: async () => b, connect: async () => odd }).install(conn);
    expect(r2.ok).toBe(false);
    expect(odd.puts).toEqual([]);
  });

  it('вторая установка на тот же сервер, пока идёт первая, — отказ; откат — rollback через stdin', async () => {
    const b = fakeBundle();
    const c = fakeClient([{ match: /^mktemp/, out: '/tmp/perimeter-install.Q\n' }, { match: /install/, out: 'готово\n', delay: 50 }, { match: /rollback/, out: 'готово: supervisor 0.1.0-bbbbbbbb отвечает\n' }]);
    const inst = new ServerInstaller({ getBundle: async () => b, connect: async () => c });
    const first = inst.install(conn);
    expect(await inst.install(conn)).toEqual({ ok: false, message: 'установка на этот сервер уже идёт' });
    expect((await inst.status(conn)).installing).toBe(true);
    expect((await first).ok).toBe(true);
    const r = await inst.rollback(conn);
    expect(r).toEqual({ ok: true, message: 'готово: supervisor 0.1.0-bbbbbbbb отвечает' });
    expect(c.execs.at(-1).cmd).toMatch(/sh 'rollback' 'yan' '8790'$/);
  });

  it('нет ssh — ошибка словами, не исключение', async () => {
    const inst = new ServerInstaller({ getBundle: async () => fakeBundle(), connect: async () => { throw new Error('ключ не подошёл — сервер не пустил'); } });
    expect(await inst.status(conn)).toEqual({ ok: false, message: 'ключ не подошёл — сервер не пустил' });
    expect(await inst.install(conn)).toEqual({ ok: false, message: 'ключ не подошёл — сервер не пустил' });
  });

  it('status разбирает недостающие пакеты; packages шлёт список скрипту', async () => {
    const st = parseStatus(['mode=system', 'packages_missing=git xvfb gcc', 'pkg_manager=apt'].join('\n'));
    expect(st.packagesMissing).toEqual(['git', 'xvfb', 'gcc']);
    expect(st.pkgManager).toBe('apt');
    const none = parseStatus('pkg_manager=none');
    expect(none.packagesMissing).toEqual([]);
    expect(none.pkgManager).toBe('none');

    const c2 = fakeClient([{ match: /packages/, out: 'ставлю пакеты: git xvfb\nготово: пакеты поставлены (git xvfb)\n' }]);
    const inst = new ServerInstaller({ getBundle: async () => fakeBundle(), connect: async () => c2 });
    const r = await inst.packages(conn, ['git', 'xvfb']);
    expect(r).toEqual({ ok: true, message: 'готово: пакеты поставлены (git xvfb)' });
    expect(c2.execs[0].cmd).toMatch(/sh 'packages' 'git' 'xvfb'$/);
  });
});
