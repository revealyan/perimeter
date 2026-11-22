// Подготовка ресурсов упаковки: локальный бандл supervisor'а (supervisor.mjs + lock для докачки движка)
// собирается тем же сборщиком, что и серверный, и раскладывается плоско в apps/desktop/resources —
// оттуда electron-builder кладёт его в <resources>/app-supervisor (путь ищет main-процесс).
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildLocal } from '../../../packages/supervisor/scripts/build-server.mjs';

const here = import.meta.dirname;
const out = resolve(here, '..', 'resources');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const { version, dir } = await buildLocal({ outRoot: out });
// version-папку → плоско (хэш версии остаётся в manifest, main читает его оттуда)
for (const f of readdirSync(dir)) cpSync(join(dir, f), join(out, f));
rmSync(dir, { recursive: true, force: true });
console.log(`app-supervisor: ${version} → ${out}`);
