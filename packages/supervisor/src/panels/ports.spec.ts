// Разбор слушающих портов на реальных образцах вывода: ss (новый и старый iproute2), netstat (Windows),
// /proc/net/tcp{,6}, tasklist. Только адреса, достижимые через loopback-туннель, без дублей.

import { describe, expect, it } from 'vitest';
import { dedupePorts, isTunnelReachable, normalizeHost, parseNetstat, parseProcNetTcp, parseSs, parseTasklist } from './ports.js';

// Ubuntu 24.04, iproute2 6.x: `ss -ltnpH` под root
const SS_NEW = `LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=713,fd=14))
LISTEN 0      4096      127.0.0.54:53         0.0.0.0:*    users:(("systemd-resolve",pid=713,fd=16))
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=1104,fd=3))
LISTEN 0      511        127.0.0.1:8790       0.0.0.0:*    users:(("node",pid=2412,fd=22))
LISTEN 0      511         10.0.0.5:9100       0.0.0.0:*    users:(("node_exporter",pid=777,fd=3))
LISTEN 0      128             [::]:22            [::]:*    users:(("sshd",pid=1104,fd=4))
LISTEN 0      511            [::1]:5173          [::]:*    users:(("node",pid=3021,fd=25))
LISTEN 0      511                *:3000             *:*    users:(("node",pid=3100,fd=19),("node",pid=3101,fd=19))
LISTEN 0      4096               *:8080             *:*
LISTEN 0      4096   [::ffff:127.0.0.1]:9000          *:*    users:(("java",pid=4000,fd=30))
`;

// CentOS 7, iproute 3.10: без -H (заголовок), IPv6 без скобок
const SS_OLD = `State      Recv-Q Send-Q Local Address:Port               Peer Address:Port
LISTEN     0      128          *:22                       *:*                   users:(("sshd",pid=1021,fd=3))
LISTEN     0      100    127.0.0.1:25                       *:*                   users:(("master",pid=1300,fd=13))
LISTEN     0      128         :::22                      :::*                   users:(("sshd",pid=1021,fd=4))
LISTEN     0      100        ::1:25                      :::*                   users:(("master",pid=1300,fd=14))
`;

// Windows 11, `netstat -ano` (снят на машине разработчика; пропущены строки UDP и часть системных)
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2084
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    0.0.0.0:5040           0.0.0.0:0              LISTENING       1648
  TCP    127.0.0.1:8795         0.0.0.0:0              LISTENING       51480
  TCP    127.0.0.1:8796         0.0.0.0:0              LISTENING       32016
  TCP    127.0.0.1:8795         127.0.0.1:61234        ESTABLISHED     51480
  TCP    172.20.10.3:139        0.0.0.0:0              LISTENING       4
  TCP    192.168.48.1:139       0.0.0.0:0              LISTENING       4
  TCP    [::]:135               [::]:0                 LISTENING       2084
  TCP    [::]:445               [::]:0                 LISTENING       4
  TCP    [::1]:5173             [::]:0                 LISTENING       39832
  TCP    [::1]:5174             [::]:0                 LISTENING       28424
  TCP    [::1]:5173             [::1]:61300            ESTABLISHED     39832
  UDP    0.0.0.0:5353           *:*                                    2860
  UDP    [::]:5353              *:*                                    2860
`;

// немецкая Windows: состояние переведено — признаём по «пустому» удалённому адресу
const NETSTAT_DE = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    127.0.0.1:3000         0.0.0.0:0              ABHÖREN          9001
  TCP    127.0.0.1:3000         127.0.0.1:50000        HERGESTELLT      9001
  TCP    [::]:8080              [::]:0                 ABHÖREN          9002
`;

const TASKLIST = `"System Idle Process","0","Services","0","8 K"
"System","4","Services","0","2,108 K"
"node.exe","39832","Console","1","120,000 K"
"node.exe","51480","Console","1","98,000 K"
"svchost.exe","2084","Services","0","13,000 K"
`;

const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000   991        0 21534 1 0000000000000000 100 0 0 10 5
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 23423 1 0000000000000000 100 0 0 10 0
   2: 0100007F:2256 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 31337 1 0000000000000000 100 0 0 10 0
   3: 0500000A:0016 0200000A:C350 01 00000000:00000000 02:000A7B40 00000000     0        0 41234 4 0000000000000000 20 4 30 10 -1
`;
const PROC_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 23425 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55555 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55556 1 0000000000000000 100 0 0 10 0
`;

describe('порты: разбор', () => {
  it('ss (новый): loopback и «все интерфейсы», процесс из users:(...), без внешних адресов и дублей', () => {
    expect(parseSs(SS_NEW)).toEqual([
      { port: 22, host: '0.0.0.0', process: 'sshd', pid: 1104 },
      { port: 53, host: '127.0.0.53', process: 'systemd-resolve', pid: 713 },
      { port: 3000, host: '0.0.0.0', process: 'node', pid: 3100 },
      { port: 5173, host: '::1', process: 'node', pid: 3021 },
      { port: 8080, host: '0.0.0.0' },
      { port: 8790, host: '127.0.0.1', process: 'node', pid: 2412 },
      { port: 9000, host: '::ffff:127.0.0.1', process: 'java', pid: 4000 },
    ]);
  });

  it('ss (старый, с заголовком, IPv6 без скобок)', () => {
    expect(parseSs(SS_OLD)).toEqual([
      { port: 22, host: '0.0.0.0', process: 'sshd', pid: 1021 },
      { port: 25, host: '127.0.0.1', process: 'master', pid: 1300 },
    ]);
  });

  it('netstat (Windows): только LISTENING TCP/TCPv6, [::1] виден, имена из tasklist, без дублей', () => {
    const names = parseTasklist(TASKLIST);
    expect(names.get(39832)).toBe('node.exe');
    expect(parseNetstat(NETSTAT, names)).toEqual([
      { port: 135, host: '0.0.0.0', pid: 2084, process: 'svchost.exe' },
      { port: 445, host: '0.0.0.0', pid: 4, process: 'System' },
      { port: 5040, host: '0.0.0.0', pid: 1648 },
      { port: 5173, host: '::1', pid: 39832, process: 'node.exe' },
      { port: 5174, host: '::1', pid: 28424 },
      { port: 8795, host: '127.0.0.1', pid: 51480, process: 'node.exe' },
      { port: 8796, host: '127.0.0.1', pid: 32016 },
    ]);
  });

  it('netstat без tasklist и на локализованной Windows', () => {
    expect(parseNetstat(NETSTAT_DE)).toEqual([
      { port: 3000, host: '127.0.0.1', pid: 9001 },
      { port: 8080, host: '::', pid: 9002 },
    ]);
  });

  it('/proc/net/tcp{,6} (фолбэк без ss): только LISTEN, адреса в порядке хоста', () => {
    expect(parseProcNetTcp(`${PROC_TCP}\n${PROC_TCP6}`)).toEqual([
      { port: 22, host: '0.0.0.0' },
      { port: 53, host: '127.0.0.53' },
      { port: 3000, host: '::ffff:127.0.0.1' },
      { port: 5173, host: '::1' },
      { port: 8790, host: '127.0.0.1' },
    ]);
  });

  it('нормализация адреса и достижимость через туннель', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('127.0.0.53%lo')).toBe('127.0.0.53');
    expect(normalizeHost('*')).toBe('0.0.0.0');
    expect(isTunnelReachable('::')).toBe(true);
    expect(isTunnelReachable('127.1.2.3')).toBe(true);
    expect(isTunnelReachable('192.168.1.5')).toBe(false);
    expect(isTunnelReachable('fe80::1')).toBe(false);
  });

  it('без дублей: порт на нескольких адресах — одна запись с лучшим адресом, процесс добирается из соседней', () => {
    expect(dedupePorts([
      { port: 3000, host: '::1', process: 'node', pid: 1 },
      { port: 3000, host: '127.0.0.1' },
      { port: 3000, host: '::' },
    ])).toEqual([{ port: 3000, host: '::', process: 'node', pid: 1 }]);
  });
});
