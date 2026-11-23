// Подготовка ресурсов упаковки: локальный бандл supervisor'а (supervisor.mjs + lock для докачки движка)
// собирается тем же сборщиком, что и серверный, и раскладывается плоско в apps/desktop/resources —
// оттуда electron-builder кладёт его в <resources>/app-supervisor (путь ищет main-процесс).
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildLocal, buildServer } from '../../../packages/supervisor/scripts/build-server.mjs';

const here = import.meta.dirname;
const out = resolve(here, '..', 'resources');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// version-папку бандла → плоско в целевую папку (версия остаётся в manifest.json, её читает main)
function flatten({ version, dir }, dest) {
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(dir)) cpSync(join(dir, f), join(dest, f));
  rmSync(dir, { recursive: true, force: true });
}

const local = await buildLocal({ outRoot: out });
flatten(local, join(out, 'app-supervisor')); // локальная среда (Windows)
const server = await buildServer({ outRoot: out });
flatten(server, join(out, 'app-server')); // выкатка на VPS (Linux): packaged не собирает из исходников
console.log(`app-supervisor: ${local.version}; app-server: ${server.version} → ${out}`);
