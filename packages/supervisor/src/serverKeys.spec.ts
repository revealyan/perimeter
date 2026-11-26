// «С сервера»: открытые ключи пользователя службы, создание, проверка входа в GitHub (ssh — подставной runner).
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkGithub, createKey, fingerprintOf, GITHUB_HOST_KEYS, identityFiles, listKeys, parseGithubAuth, parsePub, type Runner } from './serverKeys.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const home = () => { const d = mkdtempSync(join(tmpdir(), 'keys-')); dirs.push(d); return d; };
const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

describe('ключи сервера', () => {
  it('отпечаток как у ssh-keygen -l (ключ хоста GitHub — опубликованный отпечаток)', () => {
    expect(fingerprintOf(ED)).toBe('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
    expect(parsePub(`ssh-ed25519 ${ED} yan@velohost`)).toEqual({ type: 'ssh-ed25519', blob: ED, comment: 'yan@velohost' });
    expect(parsePub('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeNull();
    expect(identityFiles('user yan\nidentityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ed25519\n', '/home/yan')).toEqual(['/home/yan/.ssh/id_rsa', '/home/yan/.ssh/id_ed25519']);
  });

  it('список: только .pub с ключом; метка «для GitHub» — у того, что ssh возьмёт, и только с приватной частью', async () => {
    const h = home();
    mkdirSync(join(h, '.ssh'));
    writeFileSync(join(h, '.ssh', 'id_ed25519.pub'), `ssh-ed25519 ${ED} perimeter@srv\n`);
    writeFileSync(join(h, '.ssh', 'id_ed25519'), 'PRIVATE');
    writeFileSync(join(h, '.ssh', 'deploy.pub'), `ssh-ed25519 ${ED} deploy\n`);
    writeFileSync(join(h, '.ssh', 'junk.pub'), 'не ключ\n');
    const run: Runner = async () => ({ code: 0, stdout: `identityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/deploy\n`, stderr: '' });
    const keys = await listKeys(h, run);
    expect(keys.map((k) => [k.file, k.github, k.hasPrivate, k.comment])).toEqual([['id_ed25519', true, true, 'perimeter@srv'], ['deploy', false, false, 'deploy']]);
    expect(keys[0]!.publicKey).toBe(`ssh-ed25519 ${ED} perimeter@srv`);
    expect(JSON.stringify(keys)).not.toContain('PRIVATE');
  });

  it('создание: id_ed25519, если его нет, иначе id_ed25519_perimeter; без пароля, с комментарием perimeter@хост', async () => {
    const h = home();
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ssh-keygen') {
        const f = args[args.indexOf('-f') + 1]!;
        writeFileSync(f, 'PRIVATE');
        writeFileSync(`${f}.pub`, `ssh-ed25519 ${ED} ${args[args.indexOf('-C') + 1]}\n`);
      }
      return { code: 0, stdout: 'identityfile ~/.ssh/id_ed25519\n', stderr: '' };
    };
    const k = await createKey(h, run, 'srv');
    expect(k).toMatchObject({ file: 'id_ed25519', comment: 'perimeter@srv', github: true });
    expect(calls[0]).toEqual(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'perimeter@srv', '-f', join(h, '.ssh', 'id_ed25519')]);
    const k2 = await createKey(h, run, 'srv');
    expect(k2.file).toBe('id_ed25519_perimeter');
  });

  it('GitHub: приветствие → логин; нет ключа в GitHub / чужой ключ хоста / нет сети — понятные причины', () => {
    expect(parseGithubAuth("Hi revealyan! You've successfully authenticated, but GitHub does not provide shell access.")).toMatchObject({ ok: true, login: 'revealyan' });
    expect(parseGithubAuth('git@github.com: Permission denied (publickey).').message).toMatch(/не знает этот ключ/);
    expect(parseGithubAuth('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.').message).toMatch(/known_hosts/);
    expect(parseGithubAuth('ssh: Could not resolve hostname github.com').message).toMatch(/нет связи/);
  });

  it('проверка: github.com нет в known_hosts — дописываем опубликованные ключи (не вслепую), ssh строго по ним', async () => {
    const h = home();
    mkdirSync(join(h, '.ssh'));
    writeFileSync(join(h, '.ssh', 'known_hosts'), 'example.com ssh-ed25519 AAAA');
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ssh-keygen') return { code: 1, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: "Hi revealyan! You've successfully authenticated, but GitHub does not provide shell access." };
    };
    const r = await checkGithub(h, run);
    expect(r).toMatchObject({ ok: true, login: 'revealyan', hostKeysAdded: true });
    const kh = readFileSync(join(h, '.ssh', 'known_hosts'), 'utf8');
    expect(kh).toBe(`example.com ssh-ed25519 AAAA\n${GITHUB_HOST_KEYS.join('\n')}\n`);
    expect(calls.at(-1)).toContain('StrictHostKeyChecking=yes');
    // уже есть — не трогаем
    const run2: Runner = async (cmd) => (cmd === 'ssh-keygen' ? { code: 0, stdout: '# Host github.com found', stderr: '' } : { code: 255, stdout: '', stderr: 'git@github.com: Permission denied (publickey).' });
    const r2 = await checkGithub(h, run2);
    expect(r2).toMatchObject({ ok: false, hostKeysAdded: false });
    expect(readFileSync(join(h, '.ssh', 'known_hosts'), 'utf8')).toBe(kh);
  });
});
