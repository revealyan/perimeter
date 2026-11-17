// T2 smoke: одна сессия против реального claude (Agent SDK), события — в консоль.
// Запуск: npm run smoke -- [cwd] [промпт]

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session/manager.js';
import { sdkFactory } from '../src/session/sdk.js';

const cwd = process.argv[2] ?? join(tmpdir(), 'perimeter-smoke');
mkdirSync(cwd, { recursive: true });
const prompt = process.argv[3] ?? 'Ответь одним словом: ок';
const MODEL = process.env.PERIMETER_MODEL ?? 'glm-5.3[1m]';

function summarize(e: Parameters<Parameters<SessionManager['subscribe']>[0]>[0]): string {
  switch (e.type) {
    case 'event:session.state': return e.state + (e.needs ? ` · ${e.needs}` : '');
    case 'event:session.init': return `model=${e.model} tools=${e.tools.length} mcp=${e.mcpServers.length}`;
    case 'event:message.assistant': return e.block.type === 'tool_use' ? `tool_use ${e.block.name}` : e.block.type;
    case 'event:message.user': return `${e.toolName ?? ''} err=${e.isError ?? false}`;
    case 'event:turn.result': return `$${e.totalCostUsd ?? '?'} turns=${e.numTurns ?? '?'} result=${(e.result ?? '').slice(0, 80)}`;
    case 'event:permission.request': return `${e.toolName} request=${e.requestId.slice(0, 8)}`;
    case 'event:permission.result': return `${e.behavior}`;
    case 'event:error': return `${e.code}: ${e.message.slice(0, 120)}`;
    default: return '';
  }
}

const m = new SessionManager();
const done = new Promise<void>((resolve) => {
  m.subscribe((e) => {
    if (e.type === 'event:stream.delta') return; // партиалы не шумим
    console.log(`[${String(e.seq).padStart(3)}] ${e.type} ${summarize(e)}`);
    if (e.type === 'event:turn.result') resolve();
  });
});

const id = m.create({
  name: 'smoke',
  cwd,
  factory: sdkFactory({
    cwd, model: MODEL, permissionMode: 'acceptEdits', includePartialMessages: false,
    onStderr: (line) => console.error(`[claude-stderr] ${line}`),
  }),
});

// SDK стартует субпроцесс лениево — первое сообщение шлём сразу, не ждём idle
await new Promise((r) => setTimeout(r, 300));
console.log(`>>> send: ${prompt}`);
m.send(id, prompt);

const timeout = setTimeout(() => { console.error('TIMEOUT: ход не завершился за 180 с'); process.exit(1); }, 180_000);

await done;
clearTimeout(timeout);
console.log(`OK: сессия ${id} отработала ход`);
process.exit(0);
