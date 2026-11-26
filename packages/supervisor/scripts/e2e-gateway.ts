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
const nowSec = Math.floor(Date.now() / 1000);
// заголовки лимитов подписки, как у api.anthropic.com: Claude Code (вход токеном подписки) шлёт по ним rate_limit_event
const gwq = await startFakeGateway({ script: (n) => (n === 1 ? { delayMs: 2500, toolUse: { name: 'Read', input: { file_path: join(process.env['PERIMETER_E2E_HOME']!, 'proj', 'a.txt') } } } : { delayMs: 200, text: `ответ #${n}` }) });
const gw = await startFakeGateway({ thinking: 'думаю над ответом', headers: {
  'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': String(nowSec + 3600),
  'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': String(nowSec + 3600),
  'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.17', 'anthropic-ratelimit-unified-7d-reset': String(nowSec + 86400),
} });
const dir = join(home, '.perimeter');
const proj = join(home, 'proj');
mkdirSync(dir, { recursive: true });
mkdirSync(proj, { recursive: true });
writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { name: 'gw', env: { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: 'fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    modelsSource: 'manual', models: [{ id: 'glm-5.4', efforts: [] }], maxOutput: 64000, maxOutputHigh: 128000 },
  // реплика посреди хода: шлюз сначала отвечает вызовом инструмента с задержкой (ход длинный)
  { name: 'gwq', env: { ANTHROPIC_BASE_URL: gwq.url, ANTHROPIC_AUTH_TOKEN: 'fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, modelsSource: 'manual', models: [{ id: 'glm-5.4', efforts: [] }] },
  // «подписка» — токен подписки (как claude setup-token), API — тот же подставной шлюз
  { name: 'sub', env: { ANTHROPIC_BASE_URL: gw.url, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    modelsSource: 'manual', models: [{ id: 'claude-sonnet-5-5', efforts: [] }] },
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

  // автокомпакт на сессию: окно у самого Claude Code (getContextUsage) — на старте и после смены между ходами
  const c2 = await cmd({ type: 'cmd:session.new', profile: 'gw', model: 'glm-5.4[1m]', compactWindow: 400_000, cwd: proj });
  const sid2 = String(((c2['data'] as Record<string, unknown>)['sessionId'] ?? (c2['data'] as { session?: { id?: string } }).session?.id));
  await turn(sid2, 'окно');
  const ctx1 = ((await cmd({ type: 'cmd:session.context', sessionId: sid2 }))['data'] as Record<string, unknown>)['maxTokens'];
  await cmd({ type: 'cmd:session.settings', sessionId: sid2, compactWindow: 600_000 });
  await turn(sid2, 'окно 2');
  const ctx2 = ((await cmd({ type: 'cmd:session.context', sessionId: sid2 }))['data'] as Record<string, unknown>)['maxTokens'];
  check('автокомпакт на сессию: 400K на старте, 600K после смены между ходами', ctx1 === 400_000 && ctx2 === 600_000, `окно ${String(ctx1)} → ${String(ctx2)}`);

  // лимиты подписки: настоящий Claude Code по заголовкам ответа → rate_limit_event → event:usage клиенту
  const c3 = await cmd({ type: 'cmd:session.new', profile: 'sub', model: 'claude-sonnet-5-5', cwd: proj });
  const sid3 = String(((c3['data'] as Record<string, unknown>)['sessionId'] ?? (c3['data'] as { session?: { id?: string } }).session?.id));
  const usageEv = waitFor((f) => f.type === 'event:usage' && f['profile'] === 'sub', 60_000);
  await turn(sid3, 'лимиты');
  const ue = await usageEv.catch(() => null);
  const wins = ((ue?.['usage'] as { windows?: Array<{ id: string; pct: number }> } | undefined)?.windows ?? []).map((w) => `${w.id}:${w.pct}`);
  check('лимиты подписки из ответов API доходят до клиента (event:usage)', JSON.stringify(wins) === JSON.stringify(['five_hour:42', 'seven_day:17']), JSON.stringify(wins));

  // реплика посреди хода: Claude Code подмешивает её в следующий запрос того же хода — без отдельного хода
  // (23.11 без parent_tool_use_id: null она откладывалась/терялась, а потом отвечалась вторым ходом)
  const gq = gwq;
  writeFileSync(join(proj, 'a.txt'), 'hello');
  const c4 = await cmd({ type: 'cmd:session.new', profile: 'gwq', model: 'glm-5.4', cwd: proj }).catch(() => null);
  if (c4) {
    const sid4 = String(((c4['data'] as Record<string, unknown>)['sessionId'] ?? (c4['data'] as { session?: { id?: string } }).session?.id));
    const done4 = waitFor((f) => f.type === 'event:turn.result' && f['sessionId'] === sid4);
    await cmd({ type: 'cmd:message.send', sessionId: sid4, text: 'раз' });
    await new Promise((r) => setTimeout(r, 1200));
    await cmd({ type: 'cmd:message.send', sessionId: sid4, text: 'два' });
    await done4;
    await new Promise((r) => setTimeout(r, 3000));
    const qm = gq.requests.filter((r) => r.tools.length > 0).map((r) => (JSON.stringify(r.body['messages']).includes('два') ? 'с «два»' : 'без «два»'));
    check('реплика посреди хода — в том же ходе, без лишнего хода', JSON.stringify(qm) === JSON.stringify(['без «два»', 'с «два»']), JSON.stringify(qm));
    // строка активности: имя инструмента приходит окну в начале вызова, до готового блока (вход ещё пишется)
    const toolStart = frames.findIndex((f) => f.type === 'event:stream.delta' && f['sessionId'] === sid4 && f['tool'] === 'Read');
    const toolDone = frames.findIndex((f) => f.type === 'event:message.assistant' && f['sessionId'] === sid4 && (f['block'] as { type?: string } | undefined)?.type === 'tool_use');
    check('активность: «готовит Read» приходит до готового вызова', toolStart >= 0 && toolDone > toolStart, `кадр имени #${toolStart}, готовый вызов #${toolDone}`);
  } else {
    check('реплика посреди хода — в том же ходе, без лишнего хода', false, 'не создалась сессия на профиле gwq');
  }
  await gq.close();

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

  // сон без шва: остывшую будим заранее (окно открыло) — процесс поднимается с историей без хода и сам становится
  // «готова» (init CLI без ввода не шлёт — по initialize); сообщение идёт в этот же процесс, без второго запуска
  await cmd({ type: 'cmd:session.stop', sessionId: sid });
  const reqBefore = gw.requests.length;
  const mark = frames.length;
  const t0 = Date.now();
  const idleAgain = waitFor((f) => f.type === 'event:session.state' && f['sessionId'] === sid && f['state'] === 'idle', 30_000);
  const wr = ((await cmd({ type: 'cmd:session.wake', sessionId: sid }))['data'] as { result?: string }).result;
  await idleAgain;
  const wakeMs = Date.now() - t0;
  const reqDuringWake = gw.requests.length - reqBefore;
  const again = ((await cmd({ type: 'cmd:session.wake', sessionId: sid }))['data'] as { result?: string }).result;
  const t1 = Date.now();
  await turn(sid, 'после сна');
  const turnMs = Date.now() - t1;
  const states = frames.slice(mark).filter((f) => f.type === 'event:session.state' && f['sessionId'] === sid).map((f) => String(f['state']));
  check('пробуждение заранее: woken → «готова» без хода, потом alive; ход — в том же процессе',
    wr === 'woken' && again === 'alive' && reqDuringWake === 0 && JSON.stringify(states) === JSON.stringify(['initializing', 'idle', 'working', 'idle']),
    `${String(wr)}/${String(again)}, готова через ${wakeMs} мс, запросов к API при пробуждении ${reqDuringWake}, ход ${turnMs} мс, состояния ${states.join('→')}`);
} catch (e) {
  check('прогон', false, String((e as Error).message));
} finally {
  ws.close();
  await sup.stop();
  await gw.close();
}
for (const [name, ok, info] of results) console.log(`${ok ? '✓' : '✗'} ${name} — ${info}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
