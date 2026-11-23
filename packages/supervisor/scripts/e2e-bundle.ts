// Живой прогон СБОРКИ перед релизом (правило флоу релизов): серверный бандл (то, что едет на VPS — один файл esbuild)
// запускается отдельным процессом с временным HOME и настоящим Claude Code (PERIMETER_CLI_PATH, как в packaged),
// API — подставной шлюз. Проверяет, что бандл стартует, ход доходит до конца и новое (лимит ответа, задачи,
// размышления, лимиты подписки) работает в сборке, а не только в исходниках.
// Запуск: npx tsx packages/supervisor/scripts/e2e-bundle.ts
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildServer } from './build-server.mjs';
import { startFakeGateway } from './fake-gateway.js';

const home = mkdtempSync(join(tmpdir(), 'pm-bundle-'));
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, info: string) => { results.push([name, ok, info]); };
const req = createRequire(import.meta.url);
const cli = join(req.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/package.json', { paths: [process.cwd()] }), '..', 'claude');

const nowSec = Math.floor(Date.now() / 1000);
const gw = await startFakeGateway({ thinking: 'думаю', headers: {
  'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.3', 'anthropic-ratelimit-unified-5h-reset': String(nowSec + 3600),
} });
let child: ReturnType<typeof spawn> | null = null;
try {
  const { version, dir } = await buildServer({ outRoot: join(home, 'build') }) as { version: string; dir: string };
  check('бандл собран', existsSync(join(dir, 'supervisor.mjs')), version);
  const pdir = join(home, '.perimeter');
  mkdirSync(pdir, { recursive: true });
  mkdirSync(join(home, 'proj'), { recursive: true });
  writeFileSync(join(pdir, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
    { name: 'gw', env: { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: 'fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, modelsSource: 'manual', models: [{ id: 'glm-5.4', efforts: [] }], maxOutput: 64000 },
    { name: 'sub', env: { ANTHROPIC_BASE_URL: gw.url, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, modelsSource: 'manual', models: [{ id: 'claude-sonnet-5-5', efforts: [] }] },
  ] }));
  const port = 18_000 + Math.floor(Math.random() * 1000);
  child = spawn(process.execPath, [join(dir, 'supervisor.mjs')], {
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PERIMETER_PORT: String(port), PERIMETER_HOST: '127.0.0.1',
      PERIMETER_STATE: join(pdir, 'state.json'), PERIMETER_PROFILES: join(pdir, 'profiles.json'), PERIMETER_PROJECTS: join(pdir, 'projects.json'),
      PERIMETER_POOL_SIZE: '0', PERIMETER_CLI_PATH: cli, PERIMETER_RB_PROFILE: 'temp' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d) => { log += String(d); });
  child.stderr?.on('data', (d) => { log += String(d); });
  for (let i = 0; i < 100 && !log.includes('ws://'); i++) await new Promise((r) => setTimeout(r, 100));
  check('бандл стартует', log.includes('ws://'), log.split('\n').find((l) => l.includes('ws://'))?.slice(0, 120) ?? log.slice(-300));

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
  const waitFor = async (pred: (f: Record<string, unknown>) => boolean, ms = 60_000) => {
    const t0 = Date.now();
    for (;;) { const f = frames.find(pred); if (f) return f; if (Date.now() - t0 > ms) throw new Error('таймаут'); await new Promise((r) => setTimeout(r, 50)); }
  };
  let n = 0;
  const cmd = async (c: Record<string, unknown>) => { const id = `c${++n}`; ws.send(JSON.stringify({ v: 1, ts: Date.now(), id, ...c })); const r = await waitFor((f) => f['id'] === id); if (r['ok'] === false) throw new Error(JSON.stringify(r).slice(0, 200)); return r; };
  await cmd({ type: 'cmd:hello', lastSeq: {} });
  const sidOf = (r: Record<string, unknown>) => String((r['data'] as { sessionId?: string; session?: { id?: string } }).sessionId ?? (r['data'] as { session?: { id?: string } }).session?.id);
  const s1 = sidOf(await cmd({ type: 'cmd:session.new', profile: 'gw', model: 'glm-5.4', cwd: join(home, 'proj') }));
  await cmd({ type: 'cmd:message.send', sessionId: s1, text: 'раз' });
  await waitFor((f) => f['type'] === 'event:turn.result' && f['sessionId'] === s1);
  const main = gw.requests.filter((r) => r.path.endsWith('/v1/messages') && r.tools.length > 0);
  check('ход в сборке: лимит ответа, задачи, размышления текстом', main[0]?.maxTokens === 64000 && JSON.stringify(main[0]?.body ?? {}).includes('TaskCreate') && (main[0]?.thinking as { display?: string } | undefined)?.display === 'summarized',
    `max_tokens ${main[0]?.maxTokens}, thinking ${JSON.stringify(main[0]?.thinking)}`);
  const s2 = sidOf(await cmd({ type: 'cmd:session.new', profile: 'sub', model: 'claude-sonnet-5-5', cwd: join(home, 'proj') }));
  await cmd({ type: 'cmd:message.send', sessionId: s2, text: 'два' });
  const ev = await waitFor((f) => f['type'] === 'event:usage', 60_000).catch(() => null);
  check('лимиты подписки в сборке (event:usage)', ev !== null, JSON.stringify((ev?.['usage'] as { windows?: unknown } | undefined)?.windows ?? null));
  const tl = join(pdir, 'thinking.log');
  check('журнал размышлений пишется', existsSync(tl) && readFileSync(tl, 'utf8').includes('думаю'), existsSync(tl) ? `${readFileSync(tl, 'utf8').split('\n').filter(Boolean).length} строк` : 'нет файла');
  ws.close();
} catch (e) {
  check('прогон', false, String((e as Error).message).slice(0, 300));
} finally {
  child?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  await gw.close();
  rmSync(home, { recursive: true, force: true });
}
for (const [name, ok, info] of results) console.log(`${ok ? '✓' : '✗'} ${name} — ${info}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
