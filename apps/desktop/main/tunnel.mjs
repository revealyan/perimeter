// Встроенный SSH-туннель (ssh2, без внешнего ssh.exe/autossh):
// локальный 127.0.0.1:localPort → через SSH → remote 127.0.0.1:remotePort на VPS.
// Подключений VPS может быть несколько (connections.mjs) — у каждого свой Tunnel.
// Старый конфиг ~/.perimeter-client/tunnel.json читается только для миграции в connections.json.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import ssh2 from 'ssh2';

const { Client } = ssh2;

/** Старый одиночный конфиг (до подключений): ~/.perimeter-client/tunnel.json; null — нет или битый. */
export function loadTunnelConfig(file = join(homedir(), '.perimeter-client', 'tunnel.json')) {
  if (!existsSync(file)) return null;
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    if (!cfg.host || !cfg.user) return null;
    return {
      host: cfg.host,
      port: cfg.port ?? 22,
      user: cfg.user,
      localPort: cfg.localPort ?? 8790,
      remoteHost: cfg.remoteHost ?? '127.0.0.1',
      remotePort: cfg.remotePort ?? 8790,
      ...(cfg.privateKey ? { privateKeyPath: cfg.privateKey } : {}),
    };
  } catch {
    return null;
  }
}

const WIN_OPENSSH_AGENT = '\\\\.\\pipe\\openssh-ssh-agent';

/**
 * Чем входить по ssh: явный ключ из подключения; иначе стандартные ключи ~/.ssh (id_ed25519, id_rsa, id_ecdsa —
 * все найденные, по очереди) и ssh-agent: SSH_AUTH_SOCK, на Windows — агент OpenSSH или (если ключей нет) pageant.
 * Секреты здесь не хранятся — только пути.
 */
export function authCandidates(cfg, { env = process.env, home = homedir(), exists = existsSync, platform = process.platform } = {}) {
  const keys = cfg.privateKeyPath
    ? [cfg.privateKeyPath]
    : ['id_ed25519', 'id_rsa', 'id_ecdsa'].map((n) => join(home, '.ssh', n)).filter((p) => exists(p));
  let agent = null;
  if (env.SSH_AUTH_SOCK) agent = env.SSH_AUTH_SOCK;
  else if (platform === 'win32') {
    if (exists(WIN_OPENSSH_AGENT)) agent = WIN_OPENSSH_AGENT;
    else if (keys.length === 0) agent = 'pageant';
  }
  return { keys, agent };
}

/** Список способов входа для ssh2 (authHandler) — ключи читаются здесь; ошибка, если входить нечем. */
export function buildAuth(cfg, opts) {
  const { keys, agent } = authCandidates(cfg, opts);
  const list = [];
  for (const k of keys) {
    let key;
    try { key = readFileSync(k); } catch {
      if (cfg.privateKeyPath) throw new Error(`нет ключа ${k}`);
      continue;
    }
    list.push({ type: 'publickey', username: cfg.user, key });
  }
  if (agent) list.push({ type: 'agent', username: cfg.user, agent });
  if (list.length === 0) throw new Error('нечем войти: укажите ключ или запустите ssh-agent');
  return list;
}

/** Ошибка ssh — по-русски, без технической шелухи. */
export function sshErrorText(err) {
  const code = err?.code;
  const msg = String(err?.message ?? err);
  if (err?.level === 'client-authentication') return 'ключ не подошёл — сервер не пустил (проверьте пользователя и ключ)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'хост не найден';
  if (code === 'ECONNREFUSED') return 'ssh-порт закрыт';
  if (code === 'ETIMEDOUT' || /timed out/i.test(msg)) return 'нет ответа — проверьте адрес и порт ssh';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'хост недоступен';
  return `ssh: ${msg.slice(0, 80)}`;
}

/**
 * Пробное подключение без сохранения: ssh-вход и проверка, что на remotePort VPS кто-то слушает (supervisor).
 * Резолвится { ok, message } — сообщение для формы «Добавить подключение».
 */
export function testConnection(cfg, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let auth;
    try { auth = buildAuth(cfg); } catch (e) { resolve({ ok: false, message: e.message }); return; }
    const conn = new Client();
    let done = false;
    const finish = (ok, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* уже закрыто */ }
      resolve({ ok, message });
    };
    const timer = setTimeout(() => finish(false, `нет ответа за ${Math.round(timeoutMs / 1000)} с — проверьте адрес и порт ssh`), timeoutMs);
    conn.on('ready', () => {
      conn.forwardOut('127.0.0.1', 0, cfg.remoteHost ?? '127.0.0.1', cfg.remotePort, (err, stream) => {
        if (err) { finish(false, `ssh ✓, но на порту ${cfg.remotePort} никто не слушает — supervisor на VPS запущен?`); return; }
        stream.on('error', () => undefined);
        stream.end();
        finish(true, `ssh ✓, supervisor отвечает на порту ${cfg.remotePort}`);
      });
    });
    conn.on('error', (err) => finish(false, sshErrorText(err)));
    try {
      conn.connect({ host: cfg.host, port: cfg.port ?? 22, username: cfg.user, authHandler: auth, readyTimeout: timeoutMs });
    } catch (e) {
      finish(false, sshErrorText(e));
    }
  });
}

export class Tunnel {
  /**
   * @param cfg { host, port, user, localPort, remoteHost, remotePort, privateKeyPath? }
   * @param onStatus сырой статус: 'connecting' | 'up' | 'down' | текст ошибки по-русски
   * @param onForwards список пробросов изменился
   */
  constructor(cfg, onStatus, onForwards) {
    this.cfg = cfg;
    this.onStatus = onStatus;
    this.onForwards = onForwards;
    this.conn = null;
    this.server = null;
    this.retryMs = 1000;
    this.stopped = false;
    /** ssh-соединение готово (между 'ready' и обрывом) */
    this.ready = false;
    /** динамические пробросы для превью: remotePort → { server, url, localPort } (переживают переподключение ssh) */
    this.forwards = new Map();
  }

  start() {
    this.setStatus('connecting');
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ready = false;
    this.server?.close();
    const hadForwards = this.forwards.size > 0;
    for (const f of this.forwards.values()) f.server.close();
    this.forwards.clear();
    this.conn?.end();
    this.setStatus('down');
    if (hadForwards) this.notifyForwards();
  }

  setStatus(s) {
    try { this.onStatus?.(s); } catch { /* UI мог ещё не подняться */ }
  }

  notifyForwards() {
    try { this.onForwards?.(); } catch { /* UI мог ещё не подняться */ }
  }

  connect() {
    if (this.stopped) return;
    let auth;
    try {
      auth = buildAuth(this.cfg);
    } catch (e) {
      // ключа нет — не долбим впустую; повторим реже (ключ могут положить или запустить агент)
      this.setStatus(e.message);
      this.retryMs = 15000;
      this.reconnect();
      return;
    }
    const conn = new Client();
    this.conn = conn;
    conn.on('ready', () => {
      this.retryMs = 1000;
      this.ready = true;
      this.serveLocal(conn);
    });
    conn.on('error', (err) => {
      this.ready = false;
      this.setStatus(`обрыв: ${sshErrorText(err)}`);
      this.reconnect();
    });
    conn.on('close', () => { this.ready = false; this.reconnect(); });
    conn.connect({
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.user,
      authHandler: auth,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      readyTimeout: 20000,
    });
  }

  reconnect() {
    if (this.stopped || this.retrying) return;
    this.retrying = true;
    this.server?.close();
    this.server = null;
    this.conn?.end();
    this.conn = null;
    // статус ошибки остаётся видимым до следующего успеха (иначе «нет ключа» мигнёт и сменится на «подключаюсь…»)
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 15000);
    setTimeout(() => {
      this.retrying = false;
      this.connect();
    }, delay);
  }

  serveLocal(conn) {
    const server = net.createServer((socket) => {
      conn.forwardOut('127.0.0.1', 0, this.cfg.remoteHost, this.cfg.remotePort, (err, stream) => {
        if (err) { socket.destroy(); return; }
        socket.pipe(stream).pipe(socket);
        const bye = () => { stream.destroy(); socket.destroy(); };
        socket.on('error', bye);
        stream.on('error', bye);
      });
    });
    server.on('error', (err) => {
      this.setStatus(`локальный порт ${this.cfg.localPort} занят: ${String(err.code)}`);
    });
    server.listen(this.cfg.localPort, '127.0.0.1', () => {
      this.server = server;
      this.setStatus('up');
    });
  }

  /**
   * Проброс порта VPS (как в VS Code Remote SSH): локальный сервер на 127.0.0.1 — тот же номер порта, если свободен,
   * иначе любой — и каждое соединение через текущий ssh-коннект на localhost:remotePort VPS (localhost, а не 127.0.0.1:
   * dev-сервер может слушать только ::1). Повторный вызов для того же порта отдаёт тот же адрес. Резолвится 'http://127.0.0.1:<local>'.
   */
  async forwardPort(remotePort) {
    const known = this.forwards.get(remotePort);
    if (known) return known.url;
    if (!this.ready || !this.conn) throw new Error('ssh-туннель не поднят — дождитесь подключения к VPS');
    const onSocket = (socket) => {
      const conn = this.conn;
      if (!conn || !this.ready) { socket.destroy(); return; }
      socket.on('error', () => socket.destroy());
      conn.forwardOut('127.0.0.1', 0, 'localhost', remotePort, (err, stream) => {
        if (err) { socket.destroy(); return; }
        socket.pipe(stream).pipe(socket);
        const bye = () => { stream.destroy(); socket.destroy(); };
        stream.on('error', bye);
        socket.on('close', bye);
      });
    };
    // каждая попытка — свой сервер: после EADDRINUSE старый не переиспользуем
    const listen = (port) => new Promise((resolve, reject) => {
      const s = net.createServer(onSocket);
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => {
        s.off('error', reject);
        s.on('error', () => undefined);
        resolve(s);
      });
    });
    // свой порт supervisor-туннеля не занимаем, даже если превью просит его
    const same = remotePort !== this.cfg.localPort ? await listen(remotePort).catch(() => null) : null;
    const server = same ?? await listen(0);
    const localPort = server.address().port;
    const url = `http://127.0.0.1:${localPort}`;
    // пока ждали listen, мог прийти второй запрос того же порта — отдаём первый
    const raced = this.forwards.get(remotePort);
    if (raced) { server.close(); return raced.url; }
    this.forwards.set(remotePort, { server, url, localPort });
    this.notifyForwards();
    return url;
  }

  /** Снять проброс; false — его не было. */
  unforwardPort(remotePort) {
    const f = this.forwards.get(remotePort);
    if (!f) return false;
    f.server.close();
    this.forwards.delete(remotePort);
    this.notifyForwards();
    return true;
  }

  /** Текущие пробросы. */
  listForwards() {
    return [...this.forwards.entries()].map(([remotePort, f]) => ({ remotePort, localPort: f.localPort, url: f.url }));
  }
}
