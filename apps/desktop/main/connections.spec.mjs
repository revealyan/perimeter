// Подключения VPS: миграция tunnel.json → connections.json, выбор локального порта, проверка ввода,
// способы входа ssh, менеджер (туннели включённых, перезапуск при смене адреса, удаление) — на фейковом туннеле.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectionManager, RESERVED_PORTS, fromTunnelConfig, loadConnections, newConnectionId, normalizeConnection,
  pickLocalPort, statusText, tunnelConfigOf, validateInput,
} from './connections.mjs';
import { authCandidates, buildAuth, sshErrorText } from './tunnel.mjs';

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cc-conn-')); dirs.push(d); return d; };

describe('миграция и чтение connections.json', () => {
  it('нет connections.json, есть tunnel.json — подключение «vps» на 8790, файл записан, tunnel.json цел', () => {
    const d = tmp();
    writeFileSync(join(d, 'tunnel.json'), JSON.stringify({ host: '198.51.100.32', port: 22, user: 'root', localPort: 8790, remoteHost: '127.0.0.1', remotePort: 8790 }));
    const r = loadConnections(d);
    expect(r.migrated).toBe(true);
    expect(r.list).toEqual([{ id: 'vps', name: 'VPS', host: '198.51.100.32', port: 22, user: 'root', remotePort: 8790, localPort: 8790, enabled: true }]);
    expect(JSON.parse(readFileSync(join(d, 'connections.json'), 'utf8')).connections[0].id).toBe('vps');
    expect(existsSync(join(d, 'tunnel.json'))).toBe(true);
    // второй запуск — уже из connections.json
    expect(loadConnections(d).migrated).toBe(false);
  });
  it('ключ из tunnel.json переезжает путём; ничего нет — пусто', () => {
    expect(fromTunnelConfig({ host: 'h', user: 'u', port: 2222, localPort: 8790, remotePort: 8790, privateKeyPath: 'C:\\k\\id' })).toMatchObject({ port: 2222, privateKey: 'C:\\k\\id' });
    expect(loadConnections(tmp()).list).toEqual([]);
  });
  it('битый connections.json не затирается: пусто + ошибка', () => {
    const d = tmp();
    writeFileSync(join(d, 'connections.json'), '{не json');
    const r = loadConnections(d);
    expect(r.list).toEqual([]);
    expect(r.error).toContain('connections.json');
    expect(readFileSync(join(d, 'connections.json'), 'utf8')).toBe('{не json');
  });
  it('мусорные записи и дубли id отбрасываются, умолчания подставляются', () => {
    const d = tmp();
    writeFileSync(join(d, 'connections.json'), JSON.stringify({ version: 1, connections: [
      { id: 'a', host: 'h1', user: 'u', localPort: 8800 },
      { id: 'a', host: 'h2', user: 'u', localPort: 8801 },
      { id: 'b', host: '', user: 'u', localPort: 8802 },
      'мусор',
    ] }));
    expect(loadConnections(d).list).toEqual([{ id: 'a', name: 'h1', host: 'h1', port: 22, user: 'u', remotePort: 8790, localPort: 8800, enabled: true }]);
  });
});

describe('чистые функции', () => {
  it('порт: с 8800, мимо занятых подключениями, зарезервированных и чужих', async () => {
    const busy = new Set([8801]);
    expect(await pickLocalPort(new Set([8800]), async (p) => !busy.has(p))).toBe(8802);
    expect(await pickLocalPort(new Set(), async () => true, 8790, 8792)).toBe(8792); // 8790/8791 — зарезервированы
    expect(RESERVED_PORTS).toContain(8791);
    await expect(pickLocalPort(new Set(), async () => false, 8800, 8801)).rejects.toThrow('нет свободного');
  });
  it('id новых — c-xxxxxx без совпадений', () => {
    const id = newConnectionId(new Set(['c-000000']));
    expect(id).toMatch(/^c-[0-9a-f]{6}$/);
  });
  it('статус туннеля для UI', () => {
    expect(statusText('up', true)).toBe('подключён');
    expect(statusText('connecting', true)).toBe('подключаюсь…');
    expect(statusText('обрыв: хост не найден', true)).toBe('нет связи: обрыв: хост не найден');
    expect(statusText('up', false)).toBe('выключен');
  });
  it('проверка ввода по-русски', () => {
    expect(() => validateInput({ name: 'x', host: '', user: 'u' })).toThrow('адрес VPS');
    expect(() => validateInput({ name: 'x', host: 'h', user: '' })).toThrow('пользователя');
    expect(() => validateInput({ name: 'x', host: 'h', user: 'u', port: 70000 })).toThrow('порт ssh');
    expect(validateInput({ name: ' Мой VPS ', host: ' h ', user: 'u', port: '2222' })).toEqual({ name: 'Мой VPS', host: 'h', user: 'u', port: 2222 });
    expect(validateInput({ enabled: false }, true)).toEqual({ enabled: false });
  });
  it('подключение → туннель', () => {
    const c = normalizeConnection({ id: 'a', host: 'h', user: 'u', localPort: 8800, privateKey: '/k' });
    expect(tunnelConfigOf(c)).toEqual({ host: 'h', port: 22, user: 'u', localPort: 8800, remoteHost: '127.0.0.1', remotePort: 8790, privateKeyPath: '/k' });
  });
});

describe('вход по ssh: ключи и агент', () => {
  const home = '/home/me';
  const existing = new Set(['/home/me/.ssh/id_rsa', '/home/me/.ssh/id_ed25519']);
  const exists = (p) => existing.has(p.replace(/\\/g, '/'));
  it('явный ключ — только он; без пути — все стандартные найденные', () => {
    expect(authCandidates({ privateKeyPath: '/k' }, { env: {}, home, exists, platform: 'linux' })).toEqual({ keys: ['/k'], agent: null });
    const r = authCandidates({}, { env: {}, home, exists, platform: 'linux' });
    expect(r.keys.map((k) => k.replace(/\\/g, '/'))).toEqual(['/home/me/.ssh/id_ed25519', '/home/me/.ssh/id_rsa']);
  });
  it('агент: SSH_AUTH_SOCK; на Windows — OpenSSH-агент, pageant — только если ключей нет', () => {
    expect(authCandidates({}, { env: { SSH_AUTH_SOCK: '/tmp/a.sock' }, home, exists, platform: 'linux' }).agent).toBe('/tmp/a.sock');
    expect(authCandidates({}, { env: {}, home, exists: (p) => p === '\\\\.\\pipe\\openssh-ssh-agent', platform: 'win32' }).agent).toBe('\\\\.\\pipe\\openssh-ssh-agent');
    expect(authCandidates({}, { env: {}, home, exists, platform: 'win32' }).agent).toBeNull();
    expect(authCandidates({}, { env: {}, home, exists: () => false, platform: 'win32' }).agent).toBe('pageant');
  });
  it('нечем войти и нет явного ключа — понятные ошибки', () => {
    expect(() => buildAuth({ user: 'u' }, { env: {}, home, exists: () => false, platform: 'linux' })).toThrow('нечем войти');
    expect(() => buildAuth({ user: 'u', privateKeyPath: join(tmpdir(), 'нет-такого-ключа') }, { env: {}, platform: 'linux' })).toThrow('нет ключа');
  });
  it('ошибки ssh по-русски', () => {
    expect(sshErrorText({ level: 'client-authentication', message: 'All configured authentication methods failed' })).toContain('ключ не подошёл');
    expect(sshErrorText({ code: 'ENOTFOUND', message: 'x' })).toBe('хост не найден');
    expect(sshErrorText({ code: 'ECONNREFUSED', message: 'x' })).toBe('ssh-порт закрыт');
  });
});

/** Фейковый туннель: запоминает конфиг, умеет статус и пробросы. */
class FakeTunnel {
  static all = [];
  constructor(cfg, onStatus, onForwards) {
    this.cfg = cfg; this.onStatus = onStatus; this.onForwards = onForwards;
    this.started = false; this.stopped = false; this.fw = new Map();
    FakeTunnel.all.push(this);
  }
  start() { this.started = true; this.onStatus('connecting'); }
  stop() { this.stopped = true; this.onStatus('down'); }
  async forwardPort(p) { const url = `http://127.0.0.1:${p}`; this.fw.set(p, url); this.onForwards(); return url; }
  unforwardPort(p) { const had = this.fw.delete(p); if (had) this.onForwards(); return had; }
  listForwards() { return [...this.fw.entries()].map(([remotePort, url]) => ({ remotePort, localPort: remotePort, url })); }
}

describe('менеджер подключений', () => {
  const setup = (connections) => {
    const d = tmp();
    if (connections) writeFileSync(join(d, 'connections.json'), JSON.stringify({ version: 1, connections }));
    FakeTunnel.all = [];
    const events = [];
    const fwEvents = [];
    const m = new ConnectionManager({ dir: d, TunnelClass: FakeTunnel, onChange: (l) => events.push(l), onForwards: (l) => fwEvents.push(l) });
    m.start();
    return { d, m, events, fwEvents };
  };

  it('включённые поднимают туннель, выключенные — нет; статус доходит до списка', () => {
    const { m } = setup([
      { id: 'vps', name: 'VPS', host: 'h', user: 'u', localPort: 8790 },
      { id: 'c-1', name: 'второй', host: 'h2', user: 'u', localPort: 8800, enabled: false },
    ]);
    expect(FakeTunnel.all).toHaveLength(1);
    expect(m.list().map((c) => [c.id, c.status, c.wsUrl])).toEqual([['vps', 'подключаюсь…', 'ws://127.0.0.1:8790'], ['c-1', 'выключен', 'ws://127.0.0.1:8800']]);
    FakeTunnel.all[0].onStatus('up');
    expect(m.list()[0].status).toBe('подключён');
  });

  it('добавление: id c-…, порт с 8800, сохранено, туннель поднят', async () => {
    const { d, m, events } = setup([{ id: 'vps', name: 'VPS', host: 'h', user: 'u', localPort: 8790 }]);
    const c = await m.add({ name: 'Хетзнер', host: '1.2.3.4', user: 'root' });
    expect(c.id).toMatch(/^c-/);
    expect(c.localPort).toBeGreaterThanOrEqual(8800);
    expect(c.status).toBe('подключаюсь…');
    expect(FakeTunnel.all.at(-1).cfg).toMatchObject({ host: '1.2.3.4', localPort: c.localPort, remotePort: 8790 });
    const saved = JSON.parse(readFileSync(join(d, 'connections.json'), 'utf8')).connections;
    expect(saved.map((x) => x.id)).toEqual(['vps', c.id]);
    expect(events.at(-1).map((x) => x.id)).toEqual(['vps', c.id]);
  });

  it('правка имени — без перезапуска; смена адреса или выключение — туннель пересоздаётся/гаснет', async () => {
    const { m } = setup([{ id: 'vps', name: 'VPS', host: 'h', user: 'u', localPort: 8790 }]);
    const first = FakeTunnel.all[0];
    await m.update('vps', { name: 'Мой VPS' });
    expect(FakeTunnel.all).toHaveLength(1);
    expect(m.list()[0].name).toBe('Мой VPS');
    await m.update('vps', { host: 'h-new' });
    expect(first.stopped).toBe(true);
    expect(FakeTunnel.all).toHaveLength(2);
    // хвост статуса старого туннеля не портит новый
    first.onStatus('up');
    expect(m.list()[0].status).toBe('подключаюсь…');
    await m.update('vps', { enabled: false });
    expect(FakeTunnel.all[1].stopped).toBe(true);
    expect(m.list()[0].status).toBe('выключен');
    await expect(m.update('нет', { name: 'x' })).rejects.toThrow('нет');
  });

  it('пробросы: по connId или первому; выключенное — ошибка; удаление гасит туннель', async () => {
    const { m, fwEvents } = setup([
      { id: 'vps', name: 'VPS', host: 'h', user: 'u', localPort: 8790 },
      { id: 'c-2', name: 'второй', host: 'h2', user: 'u', localPort: 8801 },
    ]);
    expect(await m.forwardPort(3000)).toBe('http://127.0.0.1:3000');
    await m.forwardPort(5173, 'c-2');
    expect(m.forwards()).toEqual([
      { connId: 'vps', remotePort: 3000, localPort: 3000, url: 'http://127.0.0.1:3000' },
      { connId: 'c-2', remotePort: 5173, localPort: 5173, url: 'http://127.0.0.1:5173' },
    ]);
    expect(fwEvents.length).toBeGreaterThan(0);
    expect(m.unforwardPort(3000)).toBe(true);
    expect(m.unforwardPort(3000)).toBe(false);
    await m.update('c-2', { enabled: false });
    await expect(m.forwardPort(80, 'c-2')).rejects.toThrow('выключено');
    expect(m.remove('c-2')).toBe(true);
    expect(m.remove('c-2')).toBe(false);
    expect(m.list().map((c) => c.id)).toEqual(['vps']);
  });

  it("пользователь службы (установщик supervisor'а): хранится, root и мусор — отказ, пусто — убирает; туннель не трогает", async () => {
    const { d, m } = setup([{ id: 'vps', name: 'VPS', host: 'h', user: 'root', localPort: 8790 }]);
    expect(() => validateInput({ serviceUser: 'root' }, true)).toThrow('не запускается под root');
    expect(() => validateInput({ serviceUser: 'Ян Петров' }, true)).toThrow('пользователь службы');
    const before = FakeTunnel.all.length;
    expect((await m.update('vps', { serviceUser: 'yan' })).serviceUser).toBe('yan');
    expect(FakeTunnel.all.length).toBe(before);
    expect(m.config('vps')).toMatchObject({ user: 'root', serviceUser: 'yan' });
    expect(JSON.parse(readFileSync(join(d, 'connections.json'), 'utf8')).connections[0].serviceUser).toBe('yan');
    expect((await m.update('vps', { serviceUser: '' })).serviceUser).toBeUndefined();
    expect(() => m.config('нет')).toThrow('нет');
  });
});
