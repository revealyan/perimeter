// Подключения VPS (как в Happy): «Этот компьютер» есть всегда (локальный supervisor), а VPS — подключаемые,
// их может быть несколько. Конфиг — ~/.perimeter-client/connections.json (атомарная запись, без секретов: только путь к ключу).
// Каждое включённое подключение держит свой ssh-туннель: 127.0.0.1:localPort → VPS 127.0.0.1:remotePort (supervisor).
// Миграция: нет connections.json, но есть старый tunnel.json — подключение { id: 'vps', localPort 8790 }
// (id и порт сохраняются: на них завязаны ключи localStorage рендерера).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { loadTunnelConfig } from './tunnel.mjs';

export const clientDir = () => join(homedir(), '.perimeter-client');

/** Разовая миграция при переименовании codecode → perimeter: конфиги клиента переезжают целиком. */
export function migrateClientDir() {
  try {
    const from = join(homedir(), '.codecode-client');
    const to = clientDir();
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  } catch { /* не вышло — начнём с пустого конфига */ }
}

/** Порты, которые новым подключениям не раздаём: supervisor VPS/локальный, демо-стенд, vite. */
export const RESERVED_PORTS = [8790, 8791, 8795, 8796, 5173, 5174];
const FIRST_PORT = 8800;
const LAST_PORT = 8999;

const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Запись из файла → подключение; мусор — null (файл правят руками). */
export function normalizeConnection(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = str(raw.id);
  const host = str(raw.host);
  const user = str(raw.user);
  const localPort = Number(raw.localPort);
  if (!id || !host || !user || !isPort(localPort)) return null;
  const port = isPort(Number(raw.port)) ? Number(raw.port) : 22;
  const remotePort = isPort(Number(raw.remotePort)) ? Number(raw.remotePort) : 8790;
  const privateKey = str(raw.privateKey);
  const remoteHost = str(raw.remoteHost);
  const serviceUser = str(raw.serviceUser);
  return {
    id,
    name: str(raw.name) || host,
    host,
    port,
    user,
    ...(privateKey ? { privateKey } : {}),
    ...(remoteHost && remoteHost !== '127.0.0.1' ? { remoteHost } : {}),
    remotePort,
    localPort,
    enabled: raw.enabled !== false,
    // под кем работает supervisor, когда ssh — под root (установщик, АДР 004); иначе — сам ssh-пользователь
    ...(serviceUser ? { serviceUser } : {}),
  };
}

/** Старый tunnel.json (форма loadTunnelConfig) → подключение 'vps' на том же локальном порту. */
export function fromTunnelConfig(cfg) {
  if (!cfg) return null;
  return normalizeConnection({
    id: 'vps',
    name: 'VPS',
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    privateKey: cfg.privateKeyPath,
    remoteHost: cfg.remoteHost,
    remotePort: cfg.remotePort,
    localPort: cfg.localPort ?? 8790,
    enabled: true,
  });
}

/** Атомарная запись: временный файл + переименование. */
export function saveConnections(dir, list) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'connections.json');
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, connections: list }, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Подключения из connections.json; нет файла — миграция из tunnel.json (с записью connections.json).
 * Битый connections.json не затираем: работаем без подключений, ошибка — в error.
 */
export function loadConnections(dir) {
  const file = join(dir, 'connections.json');
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const arr = Array.isArray(raw?.connections) ? raw.connections : [];
      const seen = new Set();
      const list = [];
      for (const r of arr) {
        const c = normalizeConnection(r);
        if (!c || seen.has(c.id)) continue;
        seen.add(c.id);
        list.push(c);
      }
      return { list, migrated: false };
    } catch (e) {
      return { list: [], migrated: false, error: `connections.json не читается: ${String(e.message).slice(0, 80)}` };
    }
  }
  const legacy = fromTunnelConfig(loadTunnelConfig(join(dir, 'tunnel.json')));
  if (!legacy) return { list: [], migrated: false };
  saveConnections(dir, [legacy]);
  return { list: [legacy], migrated: true };
}

/** id нового подключения: 'c-' + 6 hex, без совпадений. */
export function newConnectionId(existing) {
  for (;;) {
    const id = `c-${randomBytes(3).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
}

/** Свободен ли локальный порт (пробный listen на 127.0.0.1). */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Свободный локальный порт для туннеля нового подключения: с 8800, мимо занятых подключениями и зарезервированных. */
export async function pickLocalPort(used, isFree = portIsFree, start = FIRST_PORT, end = LAST_PORT) {
  for (let p = start; p <= end; p++) {
    if (used.has(p) || RESERVED_PORTS.includes(p)) continue;
    if (await isFree(p)) return p;
  }
  throw new Error(`нет свободного локального порта в ${start}–${end}`);
}

/** Сырой статус туннеля → статус для UI. */
export function statusText(raw, enabled) {
  if (!enabled) return 'выключен';
  if (raw === 'up') return 'подключён';
  if (raw === 'connecting' || raw === undefined || raw === '') return 'подключаюсь…';
  if (raw === 'down') return 'выключен';
  return `нет связи: ${raw}`;
}

/** Проверка ввода формы; partial — для правки (только переданные поля). Ошибки — по-русски. */
export function validateInput(input, partial = false) {
  const out = {};
  const need = (k) => !partial || input[k] !== undefined;
  if (need('name')) out.name = str(input.name);
  if (need('host')) {
    out.host = str(input.host);
    if (!out.host) throw new Error('укажите адрес VPS');
    if (/\s/.test(out.host)) throw new Error('адрес VPS без пробелов');
  }
  if (need('user')) {
    out.user = str(input.user);
    if (!out.user) throw new Error('укажите пользователя ssh');
  }
  if (input.port !== undefined) {
    const p = Number(input.port);
    if (!isPort(p)) throw new Error('порт ssh — число от 1 до 65535');
    out.port = p;
  }
  if (input.remotePort !== undefined) {
    const p = Number(input.remotePort);
    if (!isPort(p)) throw new Error('порт supervisor — число от 1 до 65535');
    out.remotePort = p;
  }
  if (input.privateKey !== undefined) out.privateKey = str(input.privateKey);
  if (input.serviceUser !== undefined) {
    out.serviceUser = str(input.serviceUser);
    if (out.serviceUser === 'root') throw new Error('supervisor не запускается под root — укажите обычного пользователя');
    if (out.serviceUser && !/^[a-z_][a-z0-9_-]{0,31}$/.test(out.serviceUser)) throw new Error('пользователь службы — строчная латиница, цифры, _ и -');
  }
  if (input.enabled !== undefined) out.enabled = input.enabled !== false;
  return out;
}

/** Подключение → параметры Tunnel. */
export function tunnelConfigOf(c) {
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    localPort: c.localPort,
    remoteHost: c.remoteHost ?? '127.0.0.1',
    remotePort: c.remotePort,
    ...(c.privateKey ? { privateKeyPath: c.privateKey } : {}),
  };
}

/** Поля, смена которых требует пересоздать туннель. */
const TUNNEL_FIELDS = ['host', 'port', 'user', 'privateKey', 'remotePort', 'remoteHost', 'localPort'];

/**
 * Менеджер подключений: держит туннели включённых, сохраняет правки, сообщает об изменениях.
 * TunnelClass и dir подменяются в тестах.
 */
export class ConnectionManager {
  constructor({ dir = clientDir(), TunnelClass, onChange, onForwards, onError } = {}) {
    this.dir = dir;
    this.TunnelClass = TunnelClass;
    this.onChange = onChange;
    this.onForwards = onForwards;
    this.onError = onError;
    /** id → { conn, tunnel, raw } (порядок — порядок в файле) */
    this.entries = new Map();
  }

  start() {
    const { list, error } = loadConnections(this.dir);
    if (error) this.onError?.(error);
    for (const c of list) {
      const e = { conn: c, tunnel: null, raw: '' };
      this.entries.set(c.id, e);
      if (c.enabled) this.startTunnel(e);
    }
    this.emit();
  }

  startTunnel(e) {
    const id = e.conn.id;
    e.raw = 'connecting';
    // сравниваем с этим экземпляром: хвосты остановленного туннеля не портят статус нового
    const t = new this.TunnelClass(
      tunnelConfigOf(e.conn),
      (s) => {
        const cur = this.entries.get(id);
        if (!cur || cur.tunnel !== t) return;
        cur.raw = s;
        this.emit();
      },
      () => this.emitForwards(),
    );
    e.tunnel = t;
    t.start();
  }

  stopTunnel(e) {
    const t = e.tunnel;
    e.tunnel = null;
    e.raw = 'down';
    t?.stop();
  }

  info(e) {
    const c = e.conn;
    return {
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      user: c.user,
      ...(c.privateKey ? { privateKey: c.privateKey } : {}),
      remotePort: c.remotePort,
      ...(c.serviceUser ? { serviceUser: c.serviceUser } : {}),
      enabled: c.enabled,
      localPort: c.localPort,
      wsUrl: `ws://127.0.0.1:${c.localPort}`,
      status: statusText(e.raw, c.enabled),
    };
  }

  list() {
    return [...this.entries.values()].map((e) => this.info(e));
  }

  /** Подключение как в файле (для установщика supervisor'а); ошибка — нет такого. */
  config(id) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`подключения ${id} нет`);
    return e.conn;
  }

  /** Первое включённое подключение (совместимость: старые tunnel-status/tunnel-info, проброс без connId). */
  first() {
    return [...this.entries.values()].find((e) => e.conn.enabled) ?? [...this.entries.values()][0] ?? null;
  }

  save() {
    saveConnections(this.dir, [...this.entries.values()].map((e) => e.conn));
  }

  emit() {
    try { this.onChange?.(this.list()); } catch { /* окно могло закрыться */ }
  }

  emitForwards() {
    try { this.onForwards?.(this.forwards()); } catch { /* окно могло закрыться */ }
  }

  async add(input) {
    const v = validateInput(input);
    const ids = new Set(this.entries.keys());
    const used = new Set([...this.entries.values()].map((e) => e.conn.localPort));
    const id = newConnectionId(ids);
    const localPort = await pickLocalPort(used);
    const conn = normalizeConnection({
      id,
      name: v.name || v.host,
      host: v.host,
      port: v.port ?? 22,
      user: v.user,
      privateKey: v.privateKey,
      remotePort: v.remotePort ?? 8790,
      localPort,
      enabled: true,
      serviceUser: v.serviceUser,
    });
    const e = { conn, tunnel: null, raw: '' };
    this.entries.set(id, e);
    this.save();
    this.startTunnel(e);
    this.emit();
    return this.info(e);
  }

  async update(id, patch) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`подключения ${id} нет`);
    const v = validateInput(patch, true);
    const next = normalizeConnection({ ...e.conn, ...v, ...(v.privateKey === '' ? { privateKey: undefined } : {}), ...(v.serviceUser === '' ? { serviceUser: undefined } : {}) });
    if (!next) throw new Error('подключение после правки не прошло проверку');
    const tunnelChanged = TUNNEL_FIELDS.some((k) => next[k] !== e.conn[k]);
    const enabledChanged = next.enabled !== e.conn.enabled;
    e.conn = next;
    this.save();
    if (tunnelChanged || enabledChanged) {
      this.stopTunnel(e);
      if (next.enabled) this.startTunnel(e);
    }
    this.emit();
    return this.info(e);
  }

  remove(id) {
    const e = this.entries.get(id);
    if (!e) return false;
    this.stopTunnel(e);
    this.entries.delete(id);
    this.save();
    this.emit();
    this.emitForwards();
    return true;
  }

  pick(connId) {
    const e = connId ? this.entries.get(connId) : this.first();
    if (!e) throw new Error(connId ? `подключения ${connId} нет` : 'нет ни одного подключения VPS');
    if (!e.tunnel) throw new Error(`подключение «${e.conn.name}» выключено`);
    return e;
  }

  async forwardPort(remotePort, connId) {
    return this.pick(connId).tunnel.forwardPort(remotePort);
  }

  unforwardPort(remotePort, connId) {
    const e = connId ? this.entries.get(connId) : this.first();
    return e?.tunnel?.unforwardPort(remotePort) ?? false;
  }

  forwards() {
    const out = [];
    for (const e of this.entries.values()) {
      for (const f of e.tunnel?.listForwards() ?? []) out.push({ connId: e.conn.id, ...f });
    }
    return out;
  }

  stopAll() {
    for (const e of this.entries.values()) this.stopTunnel(e);
  }
}
