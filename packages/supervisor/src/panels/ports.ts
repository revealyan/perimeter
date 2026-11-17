// Панель портов: слушающие TCP-порты машины supervisor'а (для превью dev-сервера через туннель).
// Linux — `ss -ltnpH` (если ss нет — /proc/net/tcp{,6} без имён процессов);
// Windows — `netstat -ano` (TCP и TCPv6: Vite по умолчанию слушает [::1]) + имена из `tasklist`.
// Отдаём только адреса, достижимые через loopback-туннель: 127.0.0.0/8, ::1 и «все интерфейсы».
// Разбор — чистые функции (тесты на реальных образцах вывода обеих ОС).

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { PanelError } from './errors.js';

export interface ListenPort {
  port: number;
  /** адрес прослушивания: '0.0.0.0', '::', '127.0.0.1', '::1' … (без скобок и %iface) */
  host: string;
  process?: string;
  pid?: number;
}

/** Нормализация адреса: снять [скобки] и %интерфейс; '*' (ss: двойной стек) → '0.0.0.0'. */
export function normalizeHost(raw: string): string {
  let h = raw.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const pct = h.indexOf('%');
  if (pct >= 0) h = h.slice(0, pct);
  if (h === '*') return '0.0.0.0';
  return h.toLowerCase();
}

/** Достижим ли адрес через loopback-туннель (loopback или «все интерфейсы»). */
export function isTunnelReachable(host: string): boolean {
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^::ffff:127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return false;
}

/** Разделить 'host:port' (host может быть [v6], v6 без скобок у старого ss, '*'). */
function splitHostPort(s: string): { host: string; port: number } | null {
  const i = s.lastIndexOf(':');
  if (i <= 0) return null;
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: normalizeHost(s.slice(0, i)), port };
}

function hostRank(h: string): number {
  if (h === '0.0.0.0') return 0;
  if (h === '::') return 1;
  if (h === '127.0.0.1') return 2;
  if (h === '::1') return 3;
  return 4;
}

/** Фильтр по достижимости + без дублей (один порт — одна запись, лучший адрес) + сортировка по порту. */
export function dedupePorts(list: ListenPort[]): ListenPort[] {
  const byPort = new Map<number, ListenPort>();
  for (const p of list) {
    if (!isTunnelReachable(p.host)) continue;
    const cur = byPort.get(p.port);
    if (!cur) { byPort.set(p.port, { ...p }); continue; }
    const better = hostRank(p.host) < hostRank(cur.host);
    const next: ListenPort = better ? { ...p } : cur;
    // имя процесса берём из любой записи порта, если у выбранной его нет
    if (next.process === undefined) {
      const donor = better ? cur : p;
      if (donor.process !== undefined) next.process = donor.process;
      if (donor.pid !== undefined && next.pid === undefined) next.pid = donor.pid;
    }
    byPort.set(p.port, next);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/**
 * Разбор `ss -ltnp[H]`: State Recv-Q Send-Q Local:Port Peer:Port [users:(("name",pid=N,fd=M),...)].
 * Заголовок (если без -H) и мусорные строки пропускаются. Без root у чужих процессов users нет.
 */
export function parseSs(out: string): ListenPort[] {
  const res: ListenPort[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const tok = t.split(/\s+/);
    if (tok[0] === 'State' || tok[0] === 'Netid') continue;
    // с -t -l первая колонка — LISTEN; у старых версий формат тот же
    const local = tok[0] === 'LISTEN' ? tok[3] : tok.find((x) => /:(\d+)$/.test(x));
    if (!local) continue;
    const hp = splitHostPort(local);
    if (!hp) continue;
    const users = /users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(t);
    res.push({
      port: hp.port, host: hp.host,
      ...(users ? { process: users[1]!, pid: Number(users[2]) } : {}),
    });
  }
  return dedupePorts(res);
}

/**
 * Разбор `netstat -ano` (Windows): Proto Local Foreign State PID. Берём только TCP в LISTENING.
 * Состояние на локализованной Windows может быть переведено — признак прослушивания дублируем
 * по «пустому» удалённому адресу (0.0.0.0:0 / [::]:0).
 */
export function parseNetstat(out: string, names?: Map<number, string>): ListenPort[] {
  const res: ListenPort[] = [];
  for (const line of out.split(/\r?\n/)) {
    const tok = line.trim().split(/\s+/);
    if (tok.length < 5 || tok[0]!.toUpperCase() !== 'TCP') continue;
    const [, local, foreign, state, pidRaw] = tok as [string, string, string, string, string];
    const listening = state.toUpperCase() === 'LISTENING' || foreign === '0.0.0.0:0' || foreign === '[::]:0';
    if (!listening) continue;
    const hp = splitHostPort(local);
    if (!hp) continue;
    const pid = Number(pidRaw);
    const name = Number.isInteger(pid) ? names?.get(pid) : undefined;
    res.push({
      port: hp.port, host: hp.host,
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
      ...(name !== undefined ? { process: name } : {}),
    });
  }
  return dedupePorts(res);
}

/** Разбор `tasklist /FO CSV /NH`: "имя","pid",… → pid → имя. */
export function parseTasklist(out: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of out.split(/\r?\n/)) {
    const r = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (r) m.set(Number(r[2]), r[1]!);
  }
  return m;
}

/** Адрес из /proc/net/tcp{,6}: слова по 32 бита в порядке хоста (little-endian). */
function procAddr(hex: string): string {
  const bytes: number[] = [];
  for (let w = 0; w < hex.length; w += 8) {
    const word = hex.slice(w, w + 8);
    for (let b = 6; b >= 0; b -= 2) bytes.push(parseInt(word.slice(b, b + 2), 16));
  }
  if (bytes.length === 4) return bytes.join('.');
  // IPv6: v4-mapped — в точечной форме, остальное — со сжатием самой длинной серии нулей
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${bytes.slice(12).join('.')}`;
  }
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hexg = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hexg.join(':');
  return `${hexg.slice(0, bestStart).join(':')}::${hexg.slice(bestStart + bestLen).join(':')}`;
}

/** Разбор /proc/net/tcp и /proc/net/tcp6: состояние 0A = LISTEN. Имён процессов нет. */
export function parseProcNetTcp(out: string): ListenPort[] {
  const res: ListenPort[] = [];
  for (const line of out.split(/\r?\n/)) {
    const tok = line.trim().split(/\s+/);
    if (tok.length < 4 || !/^\d+:$/.test(tok[0]!)) continue;
    if (tok[3] !== '0A') continue;
    const [addr, portHex] = tok[1]!.split(':');
    if (!addr || !portHex) continue;
    const port = parseInt(portHex, 16);
    if (!port) continue;
    res.push({ port, host: normalizeHost(procAddr(addr)) });
  }
  return dedupePorts(res);
}

function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** Слушающие порты этой машины (только достижимые через туннель). */
export async function listPorts(platform: NodeJS.Platform = process.platform): Promise<ListenPort[]> {
  if (platform === 'win32') {
    const [ns, tl] = await Promise.allSettled([run('netstat', ['-ano']), run('tasklist', ['/FO', 'CSV', '/NH'])]);
    if (ns.status === 'rejected') throw new PanelError('PORTS_FAILED', `netstat: ${String(ns.reason).slice(0, 300)}`);
    return parseNetstat(ns.value, tl.status === 'fulfilled' ? parseTasklist(tl.value) : undefined);
  }
  if (platform === 'linux') {
    try {
      return parseSs(await run('ss', ['-ltnpH']));
    } catch {
      // нет ss (минимальный образ) — читаем ядро напрямую
      const parts = await Promise.allSettled([readFile('/proc/net/tcp', 'utf8'), readFile('/proc/net/tcp6', 'utf8')]);
      const text = parts.map((p) => (p.status === 'fulfilled' ? p.value : '')).join('\n');
      if (!text.trim()) throw new PanelError('PORTS_FAILED', 'нет ни ss, ни /proc/net/tcp');
      return parseProcNetTcp(text);
    }
  }
  throw new PanelError('NOT_SUPPORTED', `список портов не реализован для ${platform}`);
}
