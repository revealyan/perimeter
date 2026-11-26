// «Окружение» (docs/design/environment.md §1; владелец 2026-11-26: «не понял, где энвайроменты в UI»): что стоит
// в этой среде, какой версии, чего нет и на что это влияет. Один код для «Этого компьютера» и VPS — окно рисует
// колонку на среду; на VPS «Поставить» ведёт в установщик (возможности сервера), локально — инструкция.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, homedir, hostname, release, totalmem, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { resolveClaudeBin } from './accounts.js';
import { rootlessDockerHost } from './dockerEnv.js';
import { findChromium } from './panels/rbrowser.js';
import { loadNodePty } from './panels/terminal.js';
import { execFile } from 'node:child_process';

/** Запуск без shell; env — добавка к окружению процесса; ненулевой код — не исключение. */
export type Runner = (cmd: string, args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number | null; stdout: string; stderr: string }>;
export const runEnv: Runner = (cmd, args, timeoutMs, env) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && typeof (err as { code?: unknown }).code !== 'number' ? String(err.message) : '') });
  });
});

export type { EnvFeatureId as FeatureId, EnvProbe, EnvTool } from '@perimeter/protocol';
import type { EnvProbe, EnvTool } from '@perimeter/protocol';

/** Первая строка вывода (версии печатают и в stdout, и в stderr — ssh -V). */
const first = (r: { stdout: string; stderr: string }) => (r.stdout.trim() || r.stderr.trim()).split(/\r?\n/)[0]?.trim() ?? '';
const ver = (s: string) => /(\d+\.\d+(?:\.\d+)?)/.exec(s)?.[1];

/** Есть ли программа в PATH (без shell: which/where не везде). */
export function inPath(name: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const exts = platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean)) {
    for (const e of exts) {
      const p = join(dir, name + e.toLowerCase());
      const P = join(dir, name + e);
      if (existsSync(p)) return p;
      if (existsSync(P)) return P;
    }
  }
  return null;
}

export interface ProbeDeps {
  run?: Runner;
  platform?: NodeJS.Platform;
  live?: { count: number; max: number | null };
  chromium?: () => string | null;
  pty?: () => Promise<unknown>;
  dockerHost?: () => string | null;
  has?: (name: string) => string | null;
}

export async function probeEnv(d: ProbeDeps = {}): Promise<EnvProbe> {
  const run = d.run ?? runEnv;
  const platform = d.platform ?? process.platform;
  const win = platform === 'win32';
  const linux = platform === 'linux';
  const has = d.has ?? ((n: string) => inPath(n));
  const T = 6000;

  const claudeBin = resolveClaudeBin();
  let sdk: string | undefined;
  try {
    // package.json пакета не в его exports — от точки входа вверх
    let dir = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
    for (let i = 0; i < 4 && !existsSync(join(dir, 'package.json')); i++) dir = dirname(dir);
    sdk = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch { /* нет пакета */ }
  const py = win ? (has('python') ? 'python' : 'py') : 'python3';
  const [claude, git, ssh, python, gcc, make, docker] = await Promise.all([
    run(claudeBin[0]!, [...claudeBin.slice(1), '--version'], 15_000),
    run('git', ['--version'], T),
    run('ssh', ['-V'], T),
    run(py, ['--version'], T),
    linux ? run('gcc', ['--version'], T) : Promise.resolve(null),
    linux ? run('make', ['--version'], T) : Promise.resolve(null),
    run('docker', ['--version'], T),
  ]);
  const tools: EnvTool[] = [];

  // ─── движок ───
  const cv = claude.code === 0 ? ver(first(claude)) : undefined;
  tools.push({
    id: 'claude', title: 'Claude Code', status: cv ? 'ok' : 'missing',
    ...(cv ? { version: cv } : {}), ...(sdk ? { detail: `Agent SDK ${sdk} · обновляется вместе с supervisor'ом` } : {}),
    affects: 'без него сессии не запускаются',
    ...(!cv ? { hint: 'переустановите supervisor (на сервере — «Supervisor на сервере» → «Установить»; здесь — перезапуск приложения докачает движок)' } : {}),
  });
  tools.push({ id: 'node', title: 'Node.js', status: 'ok', version: process.versions.node, detail: 'на нём работает supervisor', affects: '' });

  // ─── git и ssh ───
  const gv = git.code === 0 ? ver(first(git)) : undefined;
  tools.push({
    id: 'git', title: 'Git', status: gv ? 'ok' : 'missing', ...(gv ? { version: gv } : {}),
    affects: 'нет статуса правок в «Файлах», клона проектов из git, переноса правок и git-проектов при переезде, отдельных веток воркеров',
    ...(linux ? { feature: 'git' as const } : {}),
    ...(win ? { hint: 'Git for Windows: https://git-scm.com/download/win — после установки перезапустите приложение' } : platform === 'darwin' ? { hint: 'xcode-select --install или brew install git' } : {}),
  });
  const sv = ssh.code === 0 || first(ssh).includes('OpenSSH') ? (ver(first(ssh)) ?? first(ssh).split(/[,\s]/)[0]) : undefined;
  tools.push({
    id: 'ssh', title: 'SSH-клиент', status: sv ? 'ok' : 'missing', ...(sv ? { version: sv } : {}),
    affects: 'git по ssh (git@github.com) и «Проверить GitHub» во вкладке «С сервера»',
    ...(linux ? { hint: 'apt install openssh-client' } : win ? { hint: 'Параметры Windows → Приложения → Дополнительные компоненты → «Клиент OpenSSH»' } : {}),
  });

  // ─── терминал ───
  const pty = await (d.pty ?? loadNodePty)().catch(() => null);
  tools.push({
    id: 'terminal', title: 'Терминал (node-pty)', status: pty ? 'ok' : 'warn', detail: pty ? 'полноценный терминал' : 'упрощённый режим: без цветов, интерактивных программ и Ctrl+C внутри них',
    affects: 'вкладка «Терминал» — только простой режим', ...(linux ? { feature: 'terminal' as const } : {}),
    ...(!linux ? { hint: 'на этом компьютере node-pty едет вместе с движком — перезапуск приложения докачает его' } : {}),
  });

  // ─── сборка и Python (агенты ставят зависимости; node-pty собирается из исходников на Linux) ───
  if (linux) {
    const ok = gcc?.code === 0 && make?.code === 0;
    tools.push({
      id: 'build', title: 'Сборка (gcc, make)', status: ok ? 'ok' : 'missing', ...(ok ? { version: `gcc ${ver(first(gcc!)) ?? '?'}` } : {}),
      affects: 'не соберутся node-pty и npm/pip-пакеты с нативной частью', feature: 'terminal',
    });
  }
  const pv = python.code === 0 ? ver(first(python)) : undefined;
  tools.push({
    id: 'python', title: 'Python', status: pv ? 'ok' : 'missing', ...(pv ? { version: pv } : {}),
    affects: 'агенты не запустят Python-скрипты и тесты', ...(linux ? { feature: 'terminal' as const } : {}),
    ...(win ? { hint: 'https://www.python.org/downloads/ (галка «Add python.exe to PATH»)' } : {}),
  });

  // ─── браузер ───
  const chrome = (d.chromium ?? (() => findChromium()))();
  const xvfb = linux ? has('Xvfb') : 'n/a';
  let bv: string | undefined;
  if (chrome && !win) { const r = await run(chrome, ['--version'], T); bv = r.code === 0 ? ver(first(r)) : undefined; }
  tools.push({
    id: 'browser', title: 'Браузер (Chromium)', status: chrome && xvfb ? 'ok' : chrome ? 'warn' : 'missing',
    ...(bv ? { version: bv } : {}), ...(chrome ? { detail: chrome + (linux && !xvfb ? ' · нет Xvfb — окно браузера не поднимется' : '') } : {}),
    affects: 'вкладка «Браузер»: агент не откроет страницу, не снимет скриншот и не проверит вёрстку',
    ...(linux ? { feature: 'browser' as const } : { hint: 'нужен Chrome или Edge (Edge в Windows уже есть) — или путь в PERIMETER_CHROMIUM' }),
  });

  // ─── docker ───
  const dc = docker.code === 0 ? ver(first(docker)) : undefined;
  let daemon: string | null = null;
  let rootless = false;
  if (dc) {
    // rootless-демон пользователя службы — по его сокету (как у сессий: dockerEnv)
    const host = (d.dockerHost ?? (() => rootlessDockerHost()))();
    const r = await run('docker', ['info', '--format', '{{.ServerVersion}}|{{json .SecurityOptions}}'], T, host ? { DOCKER_HOST: host } : undefined);
    if (r.code === 0) { const [v, sec] = r.stdout.trim().split('|'); daemon = v || 'есть'; rootless = /rootless/.test(sec ?? ''); }
  }
  tools.push({
    id: 'docker', title: 'Docker', status: dc && daemon ? 'ok' : dc ? 'warn' : 'missing', ...(dc ? { version: dc } : {}),
    ...(dc ? { detail: daemon ? (rootless ? 'rootless — под пользователем службы, без прав root' : 'демон отвечает') : 'клиент есть, демон не отвечает' } : {}),
    affects: 'агенты не поднимут базы и сервисы проекта в контейнерах', ...(linux ? { feature: 'docker' as const } : { hint: 'Docker Desktop: https://www.docker.com/products/docker-desktop/' }),
  });

  let diskFree: number | null = null;
  let diskTotal: number | null = null;
  try { const s = statfsSync(homedir()); diskFree = s.bavail * s.bsize; diskTotal = s.blocks * s.bsize; } catch { /* нет statfs */ }
  return {
    host: hostname(), user: userInfo().username, platform, os: `${platform} ${release()}`, node: process.versions.node,
    cpus: cpus().length, memTotal: totalmem(), memFree: freemem(), diskFree, diskTotal,
    live: d.live ?? { count: 0, max: null }, tools,
  };
}
