// Пакет канала npm (`npx @revealyan/perimeter`; владелец 2026-11-26: «делаем, пока нет подписки для аппстора»):
// лаунчер `perimeter` + приложение (main без тестов, собранный рендерер, бандлы supervisor'а из prepare-pack).
// Electron — зависимостью: его сборки подписаны, а файлы, поставленные npm, не помечены «скачано из интернета» —
// ни Gatekeeper, ни SmartScreen не ругаются. Перед запуском: `npm run build` и `npm run prepare-pack`.
//   node apps/desktop/scripts/pack-npm.mjs [папка-выхода]   (по умолчанию apps/dist-npm)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktop = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? join(desktop, '..', 'dist-npm'));
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const name = process.env.PERIMETER_NPM_NAME ?? '@revealyan/perimeter';

for (const need of ['dist-renderer/index.html', 'resources/app-supervisor/manifest.json', 'resources/app-server/manifest.json']) {
  if (!existsSync(join(desktop, need))) throw new Error(`нет ${need} — сначала npm run build и npm run prepare-pack`);
}

rmSync(out, { recursive: true, force: true });
const app = join(out, 'app');
mkdirSync(join(app, 'main'), { recursive: true });
for (const f of readdirSync(join(desktop, 'main'))) {
  if (f.endsWith('.spec.mjs')) continue;
  cpSync(join(desktop, 'main', f), join(app, 'main', f));
}
cpSync(join(desktop, 'dist-renderer'), join(app, 'dist-renderer'), { recursive: true });
cpSync(join(desktop, 'resources'), join(app, 'resources'), { recursive: true });
// package.json приложения — его читает Electron (версия, точка входа)
writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'perimeter', productName: 'Perimeter', version: pkg.version, type: 'module', main: 'main/index.mjs' }, null, 2)}\n`);

mkdirSync(join(out, 'bin'), { recursive: true });
writeFileSync(join(out, 'bin', 'perimeter.mjs'), `#!/usr/bin/env node
// Запуск Perimeter из пакета npm: Electron из зависимостей + приложение рядом; терминал сразу свободен.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const electron = createRequire(import.meta.url)('electron'); // путь к бинарю Electron
const app = join(import.meta.dirname, '..', 'app');
// npx держит пакет в своём кэше — обновление тогда через npx, а не npm i -g
const npx = process.env.npm_command === 'exec' || /[\\\\/]_npx[\\\\/]/.test(import.meta.dirname);
const env = { ...process.env, PERIMETER_DIST: 'npm', PERIMETER_NPM_MODE: npx ? 'npx' : 'global', PERIMETER_NPM_SPEC: ${JSON.stringify(name)} };
delete env.ELECTRON_RUN_AS_NODE; // унаследованная — подняла бы Electron как голый Node, без окна
const child = spawn(electron, [app, ...process.argv.slice(2)], { detached: true, stdio: 'ignore', env });
child.unref();
console.log('Perimeter ${pkg.version} запущен');
`);

const deps = { ...pkg.dependencies };
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name,
  version: pkg.version,
  description: 'Perimeter — десктоп-пульт к Claude Code: сессии живут на твоих серверах, переживают обрывы и ждут тебя',
  type: 'module',
  bin: { perimeter: 'bin/perimeter.mjs' },
  engines: { node: '>=22' },
  repository: { type: 'git', url: 'git+https://github.com/revealyan/perimeter.git' },
  homepage: 'https://github.com/revealyan/perimeter',
  license: 'UNLICENSED',
  files: ['bin', 'app', 'README.md'],
  dependencies: {
    // главному процессу нужны только эти (рендерер собран — react и прочее уже внутри)
    electron: pkg.devDependencies.electron,
    'electron-updater': deps['electron-updater'],
    ssh2: deps.ssh2,
    tar: deps.tar,
  },
}, null, 2)}\n`);

writeFileSync(join(out, 'README.md'), `# Perimeter

Десктоп-пульт к Claude Code: сессии живут на твоих серверах, переживают обрывы и ждут тебя.

\`\`\`bash
npx ${name}          # запустить (всегда свежая версия)
npm i -g ${name}     # или поставить: команда \`perimeter\`
\`\`\`

Нужен Node.js 22+. Без подписей и предупреждений системы: Electron ставится из npm. Обновление — «Обновить до vX»
в строке статуса (приложение закроется, npm поставит новую версию и запустит её).

Подробнее — https://github.com/revealyan/perimeter
`);
console.log(`${name}@${pkg.version} → ${out}`);
