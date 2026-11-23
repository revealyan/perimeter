// Пароль → ключ приложения на сервере: настоящий ssh-сервер (ssh2.Server) в процессе, команды — настоящим sh
// во временном HOME. Проверяем, что ключ ложится в authorized_keys без дублей и с правами sshd, что вход потом идёт
// ключом, что работает keyboard-interactive, и что неверный пароль — понятная ошибка.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeCommand, ensureAppKey, installKeyWithPassword, keyFileName } from './ssh-keys.mjs';

const { Server, utils } = ssh2;
const dirs = [];
const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pm-sshk-')); dirs.push(d); return d; };

/** Сервер: пароль secret у root (или только keyboard-interactive), ключи — из authorized_keys временного HOME. */
async function sshServer({ home, kbdOnly = false }) {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const authorized = () => {
    const f = join(home, '.ssh', 'authorized_keys');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => utils.parseKey(l)).filter((k) => !(k instanceof Error));
  };
  const srv = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'root') return ctx.reject();
      if (ctx.method === 'password' && !kbdOnly) return ctx.password === 'secret' ? ctx.accept() : ctx.reject();
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => (answers[0] === 'secret' ? ctx.accept() : ctx.reject()));
      }
      if (ctx.method === 'publickey') {
        const ok = authorized().some((k) => {
          const a = k.getPublicSSH();
          return ctx.key.algo === k.type && a.length === ctx.key.data.length && timingSafeEqual(a, ctx.key.data)
            && (!ctx.signature || k.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true);
        });
        return ok ? ctx.accept() : ctx.reject();
      }
      return ctx.reject(kbdOnly ? ['keyboard-interactive', 'publickey'] : ['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('exec', (acc, _rej, info) => {
          const stream = acc();
          const p = spawn('sh', ['-c', info.command], { env: { HOME: home, PATH: process.env.PATH } });
          p.stdout.pipe(stream);
          p.stderr.pipe(stream.stderr);
          p.on('close', (code) => { stream.exit(code ?? 0); stream.end(); });
        });
      });
    });
    client.on('error', () => undefined);
  });
  servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv.address().port;
}

describe('ключ приложения', () => {
  it('создаётся один раз (права 600), повторно — тот же; имя файла безопасное', () => {
    const f = join(tmp(), 'keys', 'k1');
    const a = ensureAppKey(f, 'perimeter@test');
    expect(a.publicKey).toMatch(/^ssh-ed25519 \S+ perimeter@test$/);
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(ensureAppKey(f).publicKey).toBe(a.publicKey);
    expect(keyFileName('185.119.17.115', 'root')).toBe('perimeter-root_at_185.119.17.115');
    expect(keyFileName('My Host!', 'yan')).toBe('perimeter-yan_at_my-host-');
  });

  it('команда отказывается от ключа не той формы (никаких кавычек в шелл)', () => {
    expect(() => authorizeCommand("ssh-ed25519 AAAA' ; rm -rf ~ ; '")).toThrow(/не той формы/);
  });
});

describe('пароль → ключ на сервере', () => {
  it('ключ ложится в authorized_keys (700/600), вход потом — ключом; повтор не дублирует', async () => {
    const home = tmp();
    const port = await sshServer({ home });
    const keyFile = join(tmp(), 'key');
    const r = await installKeyWithPassword({ host: '127.0.0.1', port, user: 'root', password: 'secret', keyFile });
    expect(r.privateKeyPath).toBe(keyFile);
    const ak = join(home, '.ssh', 'authorized_keys');
    expect(readFileSync(ak, 'utf8')).toBe(`${r.publicKey}\n`);
    // права — у POSIX-сервера (sshd StrictModes); на Windows (CI) их нет — «сервер» здесь эмулируется
    if (process.platform !== 'win32') {
      expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700);
      expect(statSync(ak).mode & 0o777).toBe(0o600);
    }
    await installKeyWithPassword({ host: '127.0.0.1', port, user: 'root', password: 'secret', keyFile });
    expect(readFileSync(ak, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  }, 30_000);

  it('чужие ключи на месте; файл без перевода строки в конце — ключ не склеивается', async () => {
    const home = tmp();
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const other = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAQ+MhqB9Y/lFBgk6jw/Joa98/tR9Z2Y1bYuYtcdaQFY perimeter-velohost';
    writeFileSync(join(home, '.ssh', 'authorized_keys'), other); // без \n
    const port = await sshServer({ home });
    const r = await installKeyWithPassword({ host: '127.0.0.1', port, user: 'root', password: 'secret', keyFile: join(tmp(), 'key') });
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${other}\n${r.publicKey}\n`);
  }, 30_000);

  it('сервер спрашивает пароль через keyboard-interactive — тоже входим', async () => {
    const home = tmp();
    const port = await sshServer({ home, kbdOnly: true });
    const r = await installKeyWithPassword({ host: '127.0.0.1', port, user: 'root', password: 'secret', keyFile: join(tmp(), 'key') });
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toContain(r.publicKey);
  }, 30_000);

  it('неверный пароль — понятная ошибка, на сервере ничего не появилось', async () => {
    const home = tmp();
    const port = await sshServer({ home });
    await expect(installKeyWithPassword({ host: '127.0.0.1', port, user: 'root', password: 'wrong', keyFile: join(tmp(), 'key') }))
      .rejects.toThrow(/пароль не подошёл/);
    expect(existsSync(join(home, '.ssh', 'authorized_keys'))).toBe(false);
  }, 30_000);
});
