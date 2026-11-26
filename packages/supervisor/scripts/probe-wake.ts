// Замер пробуждения: query({resume}) без ввода — когда готов (initializationResult), приходит ли init без сообщения,
// сколько до ответа после сообщения; сравнение с «разбудить сообщением». Настоящий CLI + подставной шлюз.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { startFakeGateway } from './fake-gateway.js';

const home = mkdtempSync(join(tmpdir(), 'probe-wake-'));
const cwd = join(home, 'proj'); mkdirSync(cwd);
const gw = await startFakeGateway({ reply: 'ок' });
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: 'fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

function inputQ() {
  const items: SDKUserMessage[] = []; let wake: (() => void) | null = null;
  return {
    push(text: string) { items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }); wake?.(); },
    async *it(): AsyncIterable<SDKUserMessage> { for (;;) { while (items.length) yield items.shift()!; await new Promise<void>((r) => { wake = r; }); wake = null; } },
  };
}

async function run(label: string, resume: string | undefined, turns: number, sendAfterReady: boolean) {
  const t0 = Date.now(); const ms = () => `${Date.now() - t0}мс`;
  const inp = inputQ();
  const q = query({ prompt: inp.it(), options: { cwd, env, model: 'claude-sonnet-4-5', permissionMode: 'default', ...(resume ? { resume } : {}) } });
  let sid = ''; let results = 0; let firstMsg = '';
  const readyP = q.initializationResult().then(() => console.log(`${label}: initializationResult ${ms()}`));
  const loop = (async () => { for await (const m of q) {
    if (!firstMsg) { firstMsg = `${m.type}/${'subtype' in m ? m.subtype : ''}`; console.log(`${label}: первое сообщение ${firstMsg} ${ms()}`); }
    if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
    if (m.type === 'result') { results++; console.log(`${label}: result #${results} ${ms()}`); if (results >= turns) break; }
  } })();
  if (sendAfterReady) { await readyP; await new Promise((r) => setTimeout(r, 3000)); console.log(`${label}: за 3 с после готовности без ввода — первое сообщение: ${firstMsg || 'нет'}`); }
  const ts = Date.now();
  for (let i = 0; i < turns; i++) inp.push(`реплика ${i}`);
  await loop; console.log(`${label}: от отправки до ответа ${Date.now() - ts}мс`);
  q.close();
  return sid;
}

let sid: string;
const src = process.env['PROBE_TRANSCRIPT'];
if (src) {
  // настоящий длинный транскрипт: копия в папку проекта временного профиля (слаг пути cwd, как у CLI)
  const { copyFileSync, statSync } = await import('node:fs');
  const { basename } = await import('node:path');
  sid = basename(src, '.jsonl');
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, `${sid}.jsonl`));
  console.log(`транскрипт ${(statSync(src).size / 1e6).toFixed(1)} МБ`);
} else {
  sid = await run('создание', undefined, 1, false);
  for (let i = 0; i < 3; i++) await run(`наполнение ${i}`, sid, 1, false);
}
await run('будим сообщением', sid, 1, false);
await run('будим заранее', sid, 1, true);
await gw.close();
process.exit(0);
