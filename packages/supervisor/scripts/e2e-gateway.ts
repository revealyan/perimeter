// Сквозная живая проверка без токенов: настоящий supervisor (startSupervisor) + настоящий Claude Code (CLI из SDK)
// + подставной шлюз вместо API; клиент — WSS, как у приложения. Проверяет, что реально уходит в API:
// лимит ответа по усилию (и на ходу), инструменты списка задач, усилие модели шлюза; и что размышления
// возвращаются из журнала supervisor'а, когда транскрипт хранит их без текста.
// Запуск: npx tsx packages/supervisor/scripts/e2e-gateway.ts   (сам перезапускается с временным HOME —
// настоящие ~/.claude и ~/.perimeter не трогает)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env['PERIMETER_E2E_HOME'] === undefined) {
  const home = mkdtempSync(join(tmpdir(), 'pm-e2e-'));
  const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!], {
    stdio: 'inherit',
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PERIMETER_E2E_HOME: home, PERIMETER_POOL_SIZE: '0' },
  });
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

const { default: WebSocket } = await import('ws');
const { startSupervisor } = await import('../src/supervisor.js');
const { startFakeGateway } = await import('./fake-gateway.js');

const home = process.env['PERIMETER_E2E_HOME']!;
const gw = await startFakeGateway({ thinking: 'думаю над ответом' });
const dir = join(home, '.perimeter');
const proj = join(home, 'proj');
mkdirSync(dir, { recursive: true });
mkdirSync(proj, { recursive: true });
writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { name: 'gw', env: { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: 'fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    modelsSource: 'manual', models: [{ id: 'glm-5.4', efforts: [] }], maxOutput: 64000, maxOutputHigh: 128000 },
] }));

const sup = await startSupervisor({
  port: 0, host: '127.0.0.1', permissionMode: 'acceptEdits', poolSize: 0, refreshModels: false, rbProfileDir: 'temp',
  stateFile: join(dir, 'state.json'), profilesFile: join(dir, 'profiles.json'), projectsFile: join(dir, 'projects.json'),
});
const ws = new WebSocket(`ws://127.0.0.1:${sup.port}`);
await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
type F = Record<string, unknown> & { type: string };
const frames: F[] = [];
const waiters: Array<{ test: (f: F) => boolean; resolve: (f: F) => void }> = [];
ws.on('message', (d) => {
  const f = JSON.parse(String(d)) as F;
  frames.push(f);
  for (const w of [...waiters]) if (w.test(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
});
const waitFor = (test: (f: F) => boolean, ms = 60_000) => new Promise<F>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('таймаут ожидания кадра')), ms);
  waiters.push({ test, resolve: (f) => { clearTimeout(t); resolve(f); } });
});
let n = 0;
const cmd = async (c: Record<string, unknown>) => {
  const id = `c${++n}`;
  const p = waitFor((f) => f['id'] === id && (f.type === 'ack' || f.type === 'error' || f.type === 'reply' || 'ok' in f));
  ws.send(JSON.stringify({ v: 1, ts: Date.now(), id, ...c }));
  const r = await p;
  if (r['ok'] === false || r.type === 'error') throw new Error(`${String(c['type'])}: ${JSON.stringify(r).slice(0, 300)}`);
  return r;
};
const turn = async (sid: string, text: string) => {
  const done = waitFor((f) => f.type === 'event:turn.result' && f['sessionId'] === sid);
  await cmd({ type: 'cmd:message.send', sessionId: sid, text });
  await done;
};

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, info: string) => { results.push([name, ok, info]); };
try {
  await cmd({ type: 'cmd:hello', lastSeq: {} });
  const created = await cmd({ type: 'cmd:session.new', profile: 'gw', model: 'glm-5.4', effort: 'high', cwd: proj });
  const sid = String(((created['data'] as Record<string, unknown>)['sessionId'] ?? (created['data'] as { session?: { id?: string } }).session?.id));
  await turn(sid, 'раз');
  await cmd({ type: 'cmd:session.settings', sessionId: sid, effort: 'xhigh' });
  await turn(sid, 'два');
  await cmd({ type: 'cmd:profile.update', profile: 'gw', maxOutput: null, maxOutputHigh: null });
  await turn(sid, 'три');

  const main = gw.requests.filter((r) => r.path.endsWith('/v1/messages') && r.tools.length > 0);
  const mt = main.map((r) => r.maxTokens);
  check('лимит ответа: high 64K → xhigh 128K → снят (по умолчанию 32K)', JSON.stringify(mt) === JSON.stringify([64000, 128000, 32000]), `max_tokens ${JSON.stringify(mt)}`);
  const eff = main.map((r) => (r.extra['output_config'] as { effort?: string } | undefined)?.effort);
  check('усилие уходит модели шлюза', JSON.stringify(eff) === JSON.stringify(['high', 'xhigh', 'xhigh']), `effort ${JSON.stringify(eff)}`);
  const body = JSON.stringify(main[0]?.body ?? {});
  const taskTools = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].filter((t) => body.includes(t));
  check('список задач: инструменты есть у glm', taskTools.length === 4, taskTools.join(',') || '—');
  const hello = frames.find((f) => f.type === 'event:hello') as { profiles?: Array<{ name: string; models?: Array<{ id: string; efforts?: string[] }> }> } | undefined;
  const glm = hello?.profiles?.find((p) => p.name === 'gw')?.models?.find((m) => m.id === 'glm-5.4');
  check('усилие у модели шлюза видно клиенту (стандартные уровни)', JSON.stringify(glm?.efforts) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']), JSON.stringify(glm?.efforts));
  const disp = main.map((r) => (r.thinking as { display?: string } | undefined)?.display);
  check('размышления просим текстом (summarized, не updates)', disp.every((d) => d === 'summarized') && !main.some((r) => /thinking-display-updates/.test(r.betas)), JSON.stringify(disp));

  // размышления: что записал Claude Code в транскрипт, и что отдаёт supervisor
  const projects = join(home, '.claude', 'projects');
  const files = readdirSync(projects, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl'));
  const tr = files.map((f) => readFileSync(join(projects, f), 'utf8')).join('\n');
  const inTranscript = [...tr.matchAll(/"type":"thinking","thinking":"([^"]*)"/g)].map((m) => m[1]);
  // справка: подставной шлюз отдаёт текст — Claude Code его и пишет; пустым он бывает в режиме updates (Anthropic)
  console.log(`  (в транскрипте Claude Code thinking: ${JSON.stringify(inTranscript)})`);
  const got = await cmd({ type: 'cmd:transcript.get', sessionId: sid });
  const items = ((got['data'] as { items?: Array<{ kind: string; data: { text?: string } }> }).items ?? []).filter((i) => i.kind === 'thinking');
  check('после ресинка размышления на месте (из журнала supervisor\'а)', items.length === 3 && items.every((i) => /думаю над ответом #\d/.test(i.data.text ?? '')), JSON.stringify(items.map((i) => i.data.text)));
} catch (e) {
  check('прогон', false, String((e as Error).message));
} finally {
  ws.close();
  await sup.stop();
  await gw.close();
}
for (const [name, ok, info] of results) console.log(`${ok ? '✓' : '✗'} ${name} — ${info}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
