// Вход на новый сервер «без лишних движений» (docs/design/onboarding.md): хостер выдаёт IP и пароль root — приложение
// входит паролем ОДИН раз, кладёт на сервер свой ключ (ed25519, создаётся здесь, в ~/.perimeter-client/keys) и дальше
// ходит только им. Пароль нигде не сохраняется: живёт в памяти этого вызова и уходит только в ssh-рукопожатие.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { sshErrorText } from './tunnel.mjs';

const { Client, utils } = ssh2;

/** Папка ключей приложения. */
export const keysDir = (home = homedir()) => join(home, '.perimeter-client', 'keys');

/** Имя файла ключа для хоста: латиница/цифры/точки — без сюрпризов в путях. */
export function keyFileName(host, user) {
  const safe = `${user}@${host}`.toLowerCase().replace(/[^a-z0-9.@_-]+/g, '-').replace(/@/g, '_at_');
  return `perimeter-${safe}`;
}

/** Публичный ключ OpenSSH одной строкой: тип, base64 и комментарий без пробелов и кавычек. */
const PUB_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9._@:-]+)?$/;

/** Ключ приложения для подключения: есть — читаем, нет — создаём (права 600). */
export function ensureAppKey(file, comment = `perimeter@${hostname().replace(/[^A-Za-z0-9._-]/g, '-') || 'client'}`) {
  const pubFile = `${file}.pub`;
  if (existsSync(file) && existsSync(pubFile)) {
    return { privateKeyPath: file, publicKey: readFileSync(pubFile, 'utf8').trim() };
  }
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pair = utils.generateKeyPairSync('ed25519', { comment });
  writeFileSync(file, pair.private, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows — права через ACL профиля */ }
  writeFileSync(pubFile, `${pair.public.trim()}\n`, { mode: 0o644 });
  return { privateKeyPath: file, publicKey: pair.public.trim() };
}

/**
 * Команда на сервере: дописать ключ в authorized_keys, если его там нет. Права как требует sshd (StrictModes):
 * ~/.ssh — 700, authorized_keys — 600; файл без перевода строки в конце — сначала перевод строки (иначе ключ
 * склеится с последней строкой и не заработает).
 */
export function authorizeCommand(publicKey) {
  if (!PUB_RE.test(publicKey)) throw new Error('публичный ключ не той формы');
  const f = '"$HOME/.ssh/authorized_keys"';
  return [
    'umask 077',
    'mkdir -p "$HOME/.ssh"',
    `touch ${f}`,
    'chmod 700 "$HOME/.ssh"',
    `chmod 600 ${f}`,
    `if [ -s ${f} ] && [ -n "$(tail -c 1 ${f})" ]; then echo >> ${f}; fi`,
    `grep -qxF '${publicKey}' ${f} || printf '%s\\n' '${publicKey}' >> ${f}`,
    `grep -qxF '${publicKey}' ${f} && echo PERIMETER_KEY_OK`,
  ].join(' && ');
}

function connect(cfg, auth, timeoutMs, setup = () => {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    setup(conn);
    const timer = setTimeout(() => { try { conn.end(); } catch { /* */ } reject(new Error(`нет ответа за ${Math.round(timeoutMs / 1000)} с — проверьте адрес и порт ssh`)); }, timeoutMs);
    conn.once('ready', () => { clearTimeout(timer); resolve(conn); });
    // level 'client-authentication' — сервер не принял способ входа (пароль/ключ); текст — общий разбор ssh-ошибок
    conn.once('error', (err) => { clearTimeout(timer); reject(Object.assign(new Error(sshErrorText(err)), { level: err.level })); });
    try {
      conn.connect({ host: cfg.host, port: cfg.port ?? 22, username: cfg.user, readyTimeout: timeoutMs, ...auth });
    } catch (e) {
      clearTimeout(timer);
      reject(new Error(sshErrorText(e)));
    }
  });
}

function execOut(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) { reject(err); return; }
      let out = '';
      let errOut = '';
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { errOut += d; });
      stream.on('close', (code) => resolve({ code: code ?? 0, out, err: errOut }));
    });
  });
}

/**
 * Пароль → ключ приложения на сервере. Шаги: свой ключ (создать при первом разе) → вход паролем (и keyboard-interactive
 * с тем же паролем — так спрашивают многие sshd) → дописать ключ → закрыть → проверочный вход уже ключом.
 * Возвращает путь ключа для подключения. Пароль не пишется никуда.
 */
export async function installKeyWithPassword({ host, port, user, password, keyFile, timeoutMs = 20_000 }) {
  if (!password) throw new Error('пароль пустой');
  const file = keyFile ?? join(keysDir(), keyFileName(host, user));
  const { privateKeyPath, publicKey } = ensureAppKey(file);
  const cfg = { host, port, user };
  let conn;
  try {
    conn = await connect(cfg, {
      password,
      tryKeyboard: true,
      authHandler: ['password', 'keyboard-interactive'],
    }, timeoutMs, (c) => {
      // многие sshd спрашивают пароль через keyboard-interactive — отвечаем тем же паролем
      c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => password)));
    });
  } catch (e) {
    throw new Error(e.level === 'client-authentication'
      ? 'пароль не подошёл (или вход по паролю на сервере выключен — тогда «Мой ssh-ключ уже на сервере»)'
      : e.message);
  }
  try {
    const r = await execOut(conn, authorizeCommand(publicKey));
    if (!r.out.includes('PERIMETER_KEY_OK')) throw new Error(`ключ не записался на сервере${r.err ? `: ${r.err.trim().slice(0, 200)}` : ''}`);
  } finally {
    conn.end();
  }
  // проверка: тот же сервер пускает по ключу (иначе — честная ошибка сейчас, а не странный туннель потом)
  const check = await connect(cfg, { privateKey: readFileSync(privateKeyPath) }, timeoutMs).catch((e) => {
    throw new Error(`ключ записан, но вход по нему не прошёл: ${e.message} (sshd может требовать другие права на домашней папке)`);
  });
  check.end();
  return { privateKeyPath, publicKey };
}
