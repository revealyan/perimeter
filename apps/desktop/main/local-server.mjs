// Локальная среда в packaged-приложении: supervisor живёт бандлом в resources, а его нативные части
// (node-pty, Claude Code — бинарь платформенного пакета Agent SDK) ставятся в профиль пользователя
// по package-lock бандла — мини-npm: скачать tgz, сверить integrity, распаковать. Один раз на версию;
// обновление = новая папка версии, откат = прежняя (та же механика, что на VPS).
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * Прогресс установки строками («докачиваю движок: 2/2 · claude-agent-sdk-darwin-arm64 · 45 из 153 МБ»).
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
  // в lock — пакеты всех настольных платформ (Claude Code под win/mac): ставим только свои (os/cpu, как npm)
  const names = Object.entries(lock.packages)
    .filter(([k, v]) => k.startsWith('node_modules/') && v.resolved && v.integrity && forPlatform(v))
    .map(([k, v]) => ({ name: k.slice('node_modules/'.length), ...v }));
  const total = names.length;
  for (let i = 0; i < names.length; i++) {
    const p = names[i];
    const dest = join(dir, 'node_modules', p.name);
    const mark = join(dest, PKG_MARK);
    if (existsSync(mark) && readFileSync(mark, 'utf8').trim() === p.integrity) continue;
    // тот же пакет (та же контрольная сумма) уже стоит в прошлой версии — копируем, а не качаем заново:
    // версия бандла меняется с каждым релизом, а Claude Code (~150 МБ) — гораздо реже
    const prev = reusable(installRoot, version, p);
    if (prev) {
      onStatus(`готовлю движок: ${i + 1}/${total} · ${p.name.replace(/^@[^/]+\//, '')} · из прошлой версии`);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(prev, dest, { recursive: true });
      continue;
    }
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
  // старые версии движка (~330 МБ каждая) копились бы с каждым релизом — оставляем текущую и одну прошлую (откат)
  pruneVersions(installRoot, version);
  return { version, dir };
}

/** Убрать версии движка, кроме текущей и самой свежей из прошлых; занятые файлы (Windows) — пропустить. */
export function pruneVersions(installRoot, current, keepPrevious = 1) {
  let names;
  try { names = readdirSync(installRoot); } catch { return []; }
  const others = names.filter((v) => v !== current).map((v) => {
    try { return { v, at: statSync(join(installRoot, v, '.installed')).mtimeMs }; } catch { return { v, at: 0 }; }
  }).sort((a, b) => b.at - a.at);
  const removed = [];
  for (const { v } of others.slice(keepPrevious)) {
    try { rmSync(join(installRoot, v), { recursive: true, force: true }); removed.push(v); } catch { /* занято запущенным процессом — в другой раз */ }
  }
  return removed;
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

/** Папка того же пакета с той же контрольной суммой в другой (прошлой) версии движка; нет — null. */
export function reusable(installRoot, version, p) {
  let versions;
  try { versions = readdirSync(installRoot); } catch { return null; }
  for (const v of versions) {
    if (v === version) continue;
    const d = join(installRoot, v, 'node_modules', p.name);
    try { if (readFileSync(join(d, PKG_MARK), 'utf8').trim() === p.integrity) return d; } catch { /* нет такого */ }
  }
  return null;
}

/** Пакет для этой платформы (поля os/cpu из lock, как их понимает npm; нет полей — для всех). */
export function forPlatform(entry, platform = process.platform, arch = process.arch) {
  // npm: ["darwin"] — только для перечисленных; ["!win32"] — для всех, кроме
  const fits = (list, v) => {
    if (!Array.isArray(list) || list.length === 0) return true;
    if (list.includes(`!${v}`)) return false;
    const allow = list.filter((x) => !x.startsWith('!'));
    return allow.length === 0 || allow.includes(v);
  };
  return fits(entry.os, platform) && fits(entry.cpu, arch);
}

/** Бинарь Claude Code из платформенного пакета Agent SDK (claude.exe на Windows, claude на macOS/Linux). */
export function localCliPath(installDir, platform = process.platform, arch = process.arch) {
  return join(installDir, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}-${arch}`, platform === 'win32' ? 'claude.exe' : 'claude');
}

/** Запуск packaged-локального supervisor: бандл из resources, состояние в профиле. */
export function localSupervisorEnv({ app, installDir }) {
  // SDK в бандле не разрезолвит платформенный CLI сам — указываем бинарь явно
  const cli = localCliPath(installDir);
  return {
    PERIMETER_STATE: join(app.getPath('userData'), 'local-state.json'),
    // хранилище проектов этого компьютера: рядом с домом (в dev это был родитель репозитория)
    PERIMETER_PROJECTS_ROOT: process.env.PERIMETER_PROJECTS_ROOT ?? join(homedir(), 'perimeter-projects'),
    PERIMETER_LOCAL_BUNDLE: installDir,
    ...(existsSync(cli) ? { PERIMETER_CLI_PATH: cli } : {}),
  };
}
