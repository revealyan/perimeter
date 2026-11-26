// Живой прогон переезда пакетом: два supervisor'а (разные HOME — отдельные процессы), настоящий Claude Code через
// подставной шлюз. Источник: проект git + сессия с ходом → экспорт → куски → цель (со своим проектом в занятой
// папке) → превью → импорт → ход в перенесённой сессии: модель видит историю с источника.
//   npx tsx packages/supervisor/scripts/e2e-migrate.ts
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const role = process.argv[2];
if (role === 'src' || role === 'dst') {
  // ── ребёнок: supervisor со своим HOME (homedir() процесса — на него завязаны ~/.claude и git --global) ──
  const { startSupervisor } = await import('../src/supervisor.js');
  const home = process.env['HOME']!;
  const dir = join(home, '.perimeter');
  const sup = await startSupervisor({
    port: 0, host: '127.0.0.1', permissionMode: 'acceptEdits', poolSize: 0, refreshModels: false, rbProfileDir: 'temp', idleTimeoutMs: 0,
    stateFile: join(dir, 'state.json'), profilesFile: join(dir, 'profiles.json'), projectsFile: join(dir, 'projects.json'),
  });
  console.log(`PORT ${sup.port}`);
  process.on('SIGTERM', () => { void sup.stop().finally(() => process.exit(0)); });
  await new Promise(() => undefined);
}

const { startFakeGateway } = await import('./fake-gateway.js');
const gw = await startFakeGateway({ reply: 'ок' });
const homes: string[] = [];
const env0 = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } as Record<string, string | undefined>;
delete env0['CLAUDE_CONFIG_DIR'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

function makeHome(withProject: boolean): string {
  const home = mkdtempSync(join(tmpdir(), 'e2e-mig-'));
  homes.push(home);
  const dir = join(home, '.perimeter');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
    { name: 'gw', env: { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: 'fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, modelsSource: 'manual', models: [{ id: 'glm-5.4', efforts: [] }] },
  ] }));
  const root = join(home, 'projects');
  mkdirSync(join(root, 'app'), { recursive: true });
  if (withProject) {
    const app = join(root, 'app');
    git(app, 'init', '-q', '-b', 'main');
    writeFileSync(join(app, 'README.md'), '# app\n');
    git(app, 'add', '.');
    git(app, 'commit', '-q', '-m', 'init');
    writeFileSync(join(app, '.env'), 'TOKEN=1\n');
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, root, projects: [{ id: 'p-app', name: 'app', path: app, profile: 'gw' }] }));
  } else {
    writeFileSync(join(root, 'app', 'своё.txt'), 'цель: не трогать');  // папка app занята чужим
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, root, projects: [] }));
  }
  return home;
}

function startChild(r: 'src' | 'dst', home: string): Promise<{ port: number; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [...process.execArgv, new URL(import.meta.url).pathname, r], { env: { ...env0, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.on('data', (d: Buffer) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve({ port: Number(m[1]), kill: () => c.kill('SIGTERM') }); });
    c.on('exit', (code) => reject(new Error(`${r} вышел: ${code}`)));
  });
}

type F = Record<string, unknown> & { type: string };
async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  const frames: F[] = [];
  const waiters: Array<{ t: (f: F) => boolean; r: (f: F) => void }> = [];
  ws.on('message', (d) => { const f = JSON.parse(String(d)) as F; frames.push(f); for (const w of [...waiters]) if (w.t(f)) { waiters.splice(waiters.indexOf(w), 1); w.r(f); } });
  const wait = (t: (f: F) => boolean, ms = 90_000) => new Promise<F>((res, rej) => { const tm = setTimeout(() => rej(new Error('таймаут кадра')), ms); waiters.push({ t, r: (f) => { clearTimeout(tm); res(f); } }); });
  let n = 0;
  const cmd = async (c: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = `c${++n}`;
    const p = wait((f) => f['id'] === id, 180_000);
    ws.send(JSON.stringify({ v: 1, ts: Date.now(), id, ...c }));
    const r = await p;
    if (r['ok'] === false) throw new Error(`${String(c['type'])}: ${JSON.stringify(r).slice(0, 400)}`);
    return (r['data'] ?? {}) as Record<string, unknown>;
  };
  await cmd({ type: 'cmd:hello', lastSeq: {} });
  return { ws, frames, wait, cmd };
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, info: string) => results.push([name, ok, info]);
const srcHome = makeHome(true);
const dstHome = makeHome(false);
const src = await startChild('src', srcHome);
const dst = await startChild('dst', dstHome);
try {
  const a = await client(src.port);
  const b = await client(dst.port);
  // источник: сессия в проекте, ход
  const made = await a.cmd({ type: 'cmd:session.new', name: 'фича на старом', profile: 'gw', model: 'glm-5.4', projectId: 'p-app' });
  const sid = String(made['sessionId']);
  const done = a.wait((f) => f.type === 'event:turn.result' && f['sessionId'] === sid);
  await a.cmd({ type: 'cmd:message.send', sessionId: sid, text: 'запомни слово КАШТАН' });
  await done;
  // экспорт → куски → цель
  const ex = await a.cmd({ type: 'cmd:migrate.export', selection: { accounts: ['gw'], mcp: [], projects: ['app'], sessions: 'active', thinking: true, browser: false, gitIdentity: false, secrets: true } });
  let off = 0;
  let pkg: string | undefined;
  for (;;) {
    const c = await a.cmd({ type: 'cmd:migrate.read', pkg: ex['pkg'], offset: off, length: 64 * 1024 });
    const up = await b.cmd({ type: 'cmd:migrate.upload', ...(pkg ? { pkg } : {}), offset: off, data: c['data'] });
    pkg = String(up['pkg']);
    off = Number(up['bytes']);
    if (c['eof']) break;
  }
  check('пакет передан кусками', off === ex['bytes'], `${String(ex['bytes'])} байт, sha256 ${String(ex['sha256']).slice(0, 12)}…`);
  const pv = await b.cmd({ type: 'cmd:migrate.preview', pkg, sha256: ex['sha256'] });
  const dec = pv['decisions'] as Array<{ id: string; action: string; on: boolean; detail: string }>;
  const acc = dec.find((d) => d.id === 'acc:gw');
  const prj = dec.find((d) => d.id === 'prj:0');
  check('превью: аккаунт с тем же именем на цели — не трогаем; папка проекта занята — рядом', acc?.action === 'exists' && prj?.action === 'rename' && prj.detail.includes('app-2'), dec.map((d) => `${d.id}:${d.action}`).join(' '));
  const imp = await b.cmd({ type: 'cmd:migrate.import', pkg, chosen: dec.filter((d) => d.on).map((d) => d.id) });
  const lines = imp['lines'] as Array<{ id: string; ok: boolean; text: string }>;
  check('импорт без ошибок', lines.every((l) => l.ok), lines.map((l) => l.text).join(' | '));
  const list = (await b.cmd({ type: 'cmd:session.list' }))['sessions'] as Array<{ id: string; name: string; cwd?: string; state: string }>;
  const moved = list.find((s) => s.id === sid);
  check('сессия на цели, «остывшая», в новой папке проекта', moved !== undefined && moved.state === 'dead' && (moved.cwd ?? '').endsWith('/projects/app-2'), JSON.stringify(moved));
  // ход в перенесённой сессии: модель получает историю с источника
  const before = gw.requests.length;
  const done2 = b.wait((f) => f.type === 'event:turn.result' && f['sessionId'] === sid);
  await b.cmd({ type: 'cmd:message.send', sessionId: sid, text: 'какое слово?' });
  await done2;
  const req = gw.requests.slice(before).filter((r) => r.tools.length > 0).at(-1);
  const history = JSON.stringify(req?.body['messages'] ?? []);
  check('ход на цели — с историей с источника (resume перенесённого транскрипта)', history.includes('КАШТАН') && history.includes('какое слово?'), `в запросе ${history.length} симв., КАШТАН: ${history.includes('КАШТАН')}`);
  const app2 = join(dstHome, 'projects', 'app-2');
  check('файлы: проект из бандла с .env, чужая папка цела', git(app2, 'log', '--oneline').includes('init') && execFileSync('cat', [join(app2, '.env')], { encoding: 'utf8' }) === 'TOKEN=1\n' && execFileSync('cat', [join(dstHome, 'projects', 'app', 'своё.txt')], { encoding: 'utf8' }) === 'цель: не трогать', app2);
  a.ws.close();
  b.ws.close();
} catch (e) {
  check('прогон', false, String((e as Error).message));
} finally {
  src.kill();
  dst.kill();
  await gw.close();
  await new Promise((r) => setTimeout(r, 500));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
}
for (const [name, ok, info] of results) console.log(`${ok ? '✓' : '✗'} ${name} — ${info}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
