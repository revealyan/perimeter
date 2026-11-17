// Сборка supervisor'а для сервера (АДР 004): один файл esbuild + package.json/package-lock.json только с тем, что
// в файл не собирается (node-pty — нативный модуль, Claude Code — бинарь платформенного пакета Agent SDK); их ставит
// `npm ci` на самом сервере по закреплённым версиям и integrity из lock-файла репозитория.
// Версия сборки = <версия пакета supervisor>-<8 знаков sha256 содержимого>; она же вшивается в supervisor
// (event:hello → server.version) — по ней установщик сверяет сервер с приложением.
// Выход — папка <outRoot>/<версия>/ (по содержимому: одинаковая сборка не пересобирается заново).
// Запуск: node packages/supervisor/scripts/build-server.mjs [папка вывода] → «<версия> <папка>».
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repoRoot = resolve(pkgDir, '..', '..');
/** метка версии в бандле до подсчёта хэша (хэш считается по бандлу с меткой) */
const PLACEHOLDER = '__PERIMETER_BUILD_ID_PLACEHOLDER__';

/** Файлы сборки — их кладёт на сервер установщик приложения. */
export const SERVER_FILES = ['supervisor.mjs', 'package.json', 'package-lock.json', 'manifest.json', 'server.env', 'perimeter-server.sh', 'start.sh'];

export const defaultOutRoot = () => join(pkgDir, 'dist', 'server');

const lf = (s) => s.replace(/\r\n/g, '\n');

/** Запись пакета в lock-файле: сначала корневой node_modules, потом вложенный (workspaces). */
export function lockEntry(lock, name) {
  const pk = lock?.packages ?? {};
  return pk[`node_modules/${name}`] ?? Object.entries(pk).find(([k]) => k.endsWith(`/node_modules/${name}`))?.[1];
}

/**
 * Зависимости сервера из lock-файла репозитория: имена → { optionalDependencies, packages } для package.json и
 * package-lock.json сервера (с транзитивными зависимостями). Всё необязательное: не собрался node-pty — npm ci
 * не падает (терминал уйдёт в запасной путь), чужая платформа Claude Code — пропускается.
 */
export function serverDeps(rootLock, names) {
  const packages = {};
  const queue = [...names];
  const seen = new Set();
  while (queue.length > 0) {
    const n = queue.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    const e = lockEntry(rootLock, n);
    if (!e?.version || !e.resolved || !e.integrity) throw new Error(`в package-lock.json нет ${n} с resolved/integrity`);
    const { dev: _d, peer: _p, devOptional: _o, ...rest } = e;
    packages[`node_modules/${n}`] = { ...rest, optional: true };
    for (const d of Object.keys(e.dependencies ?? {})) queue.push(d);
  }
  const optionalDependencies = Object.fromEntries(names.map((n) => [n, packages[`node_modules/${n}`].version]));
  return { optionalDependencies, packages };
}

/** Бандл supervisor'а (ESM для Node 22+) с меткой вместо версии; entry — точка входа (по умолчанию src/main.ts). */
export async function bundleSupervisor(entry = join(pkgDir, 'src', 'main.ts')) {
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    outfile: 'supervisor.mjs',
    // node-pty — нативный (ставится npm ci, грузится лениво); bufferutil/utf-8-validate — необязательные ускорители ws
    external: ['node-pty', 'bufferutil', 'utf-8-validate'],
    define: { __PERIMETER_BUILD__: JSON.stringify(PLACEHOLDER) },
    // CJS-зависимости (ws) зовут require() — в ESM-бандле его даём сами
    banner: { js: "import { createRequire as __perimeterRequire } from 'node:module'; const require = __perimeterRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'silent',
  });
  return r.outputFiles[0].text;
}

/**
 * Собрать сервер: { version, dir } — папка <outRoot>/<version>/ с SERVER_FILES.
 * tag (PERIMETER_BUILD_TAG) — добавка к хэшу, чтобы получить другую версию без правки кода (проверка отката);
 * entry — другая точка входа (снимок исходников внутри packages/supervisor, чтобы зависимости нашлись те же).
 */
export async function buildServer({ outRoot = defaultOutRoot(), tag = process.env.PERIMETER_BUILD_TAG ?? '', entry } = {}) {
  const runtime = JSON.parse(readFileSync(join(pkgDir, 'server', 'runtime.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const rootLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  const deps = serverDeps(rootLock, runtime.packages);
  const code = await bundleSupervisor(entry);
  const script = lf(readFileSync(join(pkgDir, 'server', 'perimeter-server.sh'), 'utf8'));
  const start = lf(readFileSync(join(pkgDir, 'server', 'start.sh'), 'utf8'));

  const h = createHash('sha256');
  for (const part of [code, script, start, JSON.stringify(deps), JSON.stringify(runtime.node), tag]) h.update(part).update('\0');
  const version = `${pkg.version}-${h.digest('hex').slice(0, 8)}`;

  const dir = join(outRoot, version);
  if (existsSync(join(dir, 'manifest.json'))) return { version, dir };

  const sdk = lockEntry(rootLock, '@anthropic-ai/claude-agent-sdk')?.version ?? '';
  const files = {
    'supervisor.mjs': code.split(PLACEHOLDER).join(version),
    'package.json': `${JSON.stringify({ name: 'perimeter-server', version, private: true, type: 'module', optionalDependencies: deps.optionalDependencies }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify({
      name: 'perimeter-server', version, lockfileVersion: 3, requires: true,
      packages: { '': { name: 'perimeter-server', version, optionalDependencies: deps.optionalDependencies }, ...deps.packages },
    }, null, 2)}\n`,
    'manifest.json': `${JSON.stringify({ version, node: runtime.node.version, agentSdk: sdk, packages: deps.optionalDependencies, tag: tag || undefined }, null, 2)}\n`,
    'server.env': [
      `VERSION=${version}`,
      `NODE_VERSION=${runtime.node.version}`,
      `NODE_SHA256_X64=${runtime.node.sha256['linux-x64']}`,
      `NODE_SHA256_ARM64=${runtime.node.sha256['linux-arm64']}`,
      '',
    ].join('\n'),
    'perimeter-server.sh': script,
    'start.sh': start,
  };
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tmp, name), text, 'utf8');
  // сборку той же версии мог только что положить параллельный запуск — тогда она уже есть
  try { renameSync(tmp, dir); } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(join(dir, 'manifest.json'))) throw e;
  }
  return { version, dir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version, dir } = await buildServer(process.argv[2] ? { outRoot: resolve(process.argv[2]) } : {});
  console.log(`${version} ${dir}`);
}
