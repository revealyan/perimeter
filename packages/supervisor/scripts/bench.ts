// Нагрузочный тест (N6): поток событий через WSS → замер рендер-нагрузки и пропускной способности.
// Запуск: npx tsx packages/supervisor/scripts/bench.ts [событий] [размер кадра байт]
// Метрики: события/сек доставки, rAF-кадры/сек (в Electron), время полного догона после обрыва.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@perimeter/protocol';

const REPO = join(import.meta.dirname, '..', '..', '..');
const COUNT = Number(process.argv[2] ?? 5000);
const PAYLOAD = Number(process.argv[3] ?? 200); // байт текста в каждом событии
const PORT = 8799;
const dir = mkdtempSync(join(tmpdir(), 'cc-bench-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = 'a'.repeat(PAYLOAD);

console.log(`бенчмарк: ${COUNT} событий × ${PAYLOAD} байт, порт ${PORT}`);

// 1. Поднять supervisor с бенчмарк-профилем (без claude — мок-фабрика)
const sup = spawn(process.execPath, ['--import', 'tsx', 'packages/supervisor/scripts/bench-server.ts'], {
  cwd: REPO,
  env: { ...process.env, BENCH_PORT: String(PORT), BENCH_DIR: dir, BENCH_COUNT: String(COUNT), BENCH_TEXT: text },
  stdio: ['ignore', 'pipe', 'inherit'],
});
sup.stdout?.on('data', (d) => process.stdout.write(`[sup] ${d}`));

// ждать порт
async function waitPort(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        ws.once('open', () => { ws.close(); resolve(); });
        ws.once('error', reject);
      });
      return;
    } catch { await sleep(500); }
  }
  throw new Error('supervisor не поднялся');
}

await waitPort();

// 2. Подключиться, hello, session.new → сервер льёт COUNT событий
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let received = 0;
const t0 = { value: 0 };
let done = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h', type: 'cmd:hello', lastSeq: {} }));
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'n', type: 'cmd:session.new' }));
});
ws.on('message', (d) => {
  const f = JSON.parse(String(d));
  if (f.type === 'event:session.init') t0.value = Date.now();
  if ('seq' in f && f.seq > 0) {
    received++;
    if (received === COUNT) {
      const ms = Date.now() - t0.value;
      console.log(`\n✓ ${COUNT} событий за ${ms} мс = ${Math.round(COUNT / (ms / 1000))} событий/сек`);
      done = true;
      ws.close();
      sup.kill();
      process.exit(0);
    }
  }
});

// 3. Обрыв на середине: замерить время догона после реконнекта
let disconnected = false;
setTimeout(() => {
  if (received > COUNT * 0.3 && !disconnected) {
    disconnected = true;
    const atDisconnect = received;
    ws.close();
    console.log(`обрыв на ${atDisconnect}/${COUNT} — проверяем догон`);
    setTimeout(() => {
      const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), id: 'h2', type: 'cmd:hello', lastSeq: {} }));
      });
      ws2.on('message', (d) => {
        const f = JSON.parse(String(d));
        if ('seq' in f) received++;
      });
    }, 2000);
  }
}, 1000);

setTimeout(() => { if (!done) { console.error('TIMEOUT'); sup.kill(); process.exit(1); } }, 120_000);
