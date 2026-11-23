// Локальная среда в packaged-приложении: supervisor живёт бандлом в resources, а его нативные части
// (node-pty, Claude Code — бинарь платформенного пакета Agent SDK) ставятся в профиль пользователя
// по package-lock бандла — мини-npm: скачать tgz, сверить integrity, распаковать. Один раз на версию;
// обновление = новая папка версии, откат = прежняя (та же механика, что на VPS).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { extract } from 'tar';

/** Прогресс установки строками («докачиваю движок: 2/5 · node-pty»). */
export async function ensureLocalServer({ bundleDir, installRoot, onStatus = () => {} }) {
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  const dir = join(installRoot, version);
  const marker = join(dir, '.installed');
  if (existsSync(marker)) return { version, dir };

  onStatus(`готовлю локальный supervisor ${version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of ['supervisor.mjs', 'package.json', 'package-lock.json', 'manifest.json']) {
    if (existsSync(join(bundleDir, f))) copyFileSync(join(bundleDir, f), join(dir, f));
  }

  // пакеты из lock: tgz с registry, проверка sha512 из integrity, распаковка в node_modules/<name>
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const names = Object.entries(lock.packages)
    .filter(([k, v]) => k.startsWith('node_modules/') && v.resolved && v.integrity)
    .map(([k, v]) => ({ name: k.slice('node_modules/'.length), ...v }));
  const total = names.length;
  for (let i = 0; i < names.length; i++) {
    const p = names[i];
    onStatus(`докачиваю движок: ${i + 1}/${total} · ${p.name}`);
    await installPackage(p, join(dir, 'node_modules', p.name));
  }

  writeFileSync(marker, `${version}\n`, 'utf8');
  return { version, dir };
}

async function installPackage(p, dest) {
  const res = await fetch(p.resolved, { redirect: 'follow' });
  if (!res.ok) throw new Error(`не скачался ${p.name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // integrity вида «sha512-<base64>»
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(p.integrity ?? '');
  if (m) {
    const got = createHash('sha512').update(buf).digest('base64');
    if (got !== m[1]) throw new Error(`${p.name}: не сошлась контрольная сумма (испорчен скачиванием?)`);
  }
  // tar делает chdir в C — папка назначения должна существовать (и быть пустой)
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // tar читает архив из файла: пишем буфер во временный и распаковываем (опции buffer у extract нет)
  const tmp = `${dest}.tgz-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, buf);
  try {
    await extract({ file: tmp, strip: 1, C: dest, strict: true });
  } finally {
    rmSync(tmp, { force: true });
  }
  if (!existsSync(join(dest, 'package.json'))) throw new Error(`${p.name}: распаковка не дала файлов`);
}

/** Запуск packaged-локального supervisor: бандл из resources, состояние в профиле. */
export function localSupervisorEnv({ app, installDir }) {
  // SDK в бандле не разрезолвит платформенный CLI сам — указываем бинарь явно
  const cli = join(installDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
  return {
    PERIMETER_STATE: join(app.getPath('userData'), 'local-state.json'),
    // хранилище проектов этого компьютера: рядом с домом (в dev это был родитель репозитория)
    PERIMETER_PROJECTS_ROOT: process.env.PERIMETER_PROJECTS_ROOT ?? join(homedir(), 'perimeter-projects'),
    PERIMETER_LOCAL_BUNDLE: installDir,
    ...(existsSync(cli) ? { PERIMETER_CLI_PATH: cli } : {}),
  };
}
