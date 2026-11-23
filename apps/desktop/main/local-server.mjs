// Локальная среда в packaged-приложении: supervisor живёт бандлом в resources, а его нативные части
// (node-pty, Claude Code — бинарь платформенного пакета Agent SDK) ставятся в профиль пользователя
// по package-lock бандла — мини-npm: скачать tgz, сверить integrity, распаковать. Один раз на версию;
// обновление = новая папка версии, откат = прежняя (та же механика, что на VPS).
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { extract } from 'tar';

/** Нет ни байта столько времени — загрузка считается зависшей (иначе статус «докачиваю» висел вечно). */
export const STALL_MS = 60_000;
/** Попыток на пакет: сеть до registry бывает рваной, движок весит ~160 МБ. */
const ATTEMPTS = 3;
/** Пометка «пакет поставлен целиком» в его папке: повтор после сбоя не качает заново уже готовое. */
const PKG_MARK = '.perimeter-installed';

const mb = (n) => (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1);

/**
 * Прогресс установки строками («докачиваю движок: 2/2 · claude-agent-sdk-win32-x64 · 45 из 153 МБ»).
 * fetchImpl/stallMs — для тестов.
 */
export async function ensureLocalServer({ bundleDir, installRoot, onStatus = () => {}, fetchImpl = fetch, stallMs = STALL_MS }) {
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  const dir = join(installRoot, version);
  const marker = join(dir, '.installed');
  if (existsSync(marker)) return { version, dir };

  onStatus(`готовлю локальный supervisor ${version}`);
  // папку версии не сносим: пакеты, уже поставленные прошлой (оборвавшейся) попыткой, переиспользуются
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
    const dest = join(dir, 'node_modules', p.name);
    const mark = join(dest, PKG_MARK);
    if (existsSync(mark) && readFileSync(mark, 'utf8').trim() === p.integrity) continue;
    const head = `докачиваю движок: ${i + 1}/${total} · ${p.name.replace(/^@[^/]+\//, '')}`;
    for (let attempt = 1; ; attempt++) {
      try {
        await installPackage(p, dest, {
          fetchImpl,
          stallMs,
          onProgress: (got, size) => onStatus(`${head} · ${size ? `${mb(got)} из ${mb(size)} МБ` : `${mb(got)} МБ`}${attempt > 1 ? ` (попытка ${attempt})` : ''}`),
          onExtract: () => onStatus(`${head} · распаковываю…`),
        });
        writeFileSync(mark, `${p.integrity}\n`, 'utf8');
        break;
      } catch (e) {
        if (attempt >= ATTEMPTS) throw e;
        onStatus(`${head} · сбой: ${String(e.message).slice(0, 80)} — пробую ещё раз`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  writeFileSync(marker, `${version}\n`, 'utf8');
  return { version, dir };
}

/** Скачать tgz потоком в файл (не в память — движок ~160 МБ), считая sha512 и прогресс; зависание — ошибка. */
export async function downloadTo(url, file, { fetchImpl = fetch, stallMs = STALL_MS, onProgress = () => {} } = {}) {
  const ac = new AbortController();
  let stalled = false;
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; ac.abort(); }, stallMs);
  };
  const hash = createHash('sha512');
  let out = null;
  try {
    arm();
    const res = await fetchImpl(url, { redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('пустой ответ');
    const size = Number(res.headers.get('content-length')) || 0;
    out = createWriteStream(file);
    let got = 0;
    let shown = 0;
    onProgress(0, size);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      hash.update(value);
      got += value.length;
      if (!out.write(value)) await once(out, 'drain');
      // прогресс — не чаще, чем на каждый мегабайт (статус уходит в окно по IPC)
      if (got - shown >= 1048576) { shown = got; onProgress(got, size); }
    }
    onProgress(got, size);
    out.end();
    await once(out, 'close');
    out = null;
    return hash.digest('base64');
  } catch (e) {
    if (stalled) throw new Error(`загрузка встала: ${Math.round(stallMs / 1000)} с без данных — проверьте сеть и нажмите «запустить»`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    // оборвалось посреди записи — дождаться закрытия файла (на Windows открытый файл не удалить)
    if (out) { out.destroy(); await once(out, 'close').catch(() => undefined); }
  }
}

async function installPackage(p, dest, { fetchImpl, stallMs, onProgress, onExtract }) {
  // tar делает chdir в C — папка назначения должна существовать (и быть пустой)
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  // архив — во временный файл рядом (tar читает из файла: опции buffer у extract нет)
  const tmp = `${dest}.tgz-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    let got;
    try {
      got = await downloadTo(p.resolved, tmp, { fetchImpl, stallMs, onProgress });
    } catch (e) {
      throw new Error(`не скачался ${p.name}: ${e.message}`);
    }
    // integrity вида «sha512-<base64>»
    const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(p.integrity ?? '');
    if (m && got !== m[1]) throw new Error(`${p.name}: не сошлась контрольная сумма (испорчен скачиванием?)`);
    onExtract();
    mkdirSync(dest, { recursive: true });
    await extract({ file: tmp, strip: 1, C: dest, strict: true });
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* не удалился временный — не прячем им настоящую ошибку */ }
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
