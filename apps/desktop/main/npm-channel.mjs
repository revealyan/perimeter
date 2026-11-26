// Канал npm (`npx @revealyan/perimeter` / `npm i -g @revealyan/perimeter`): новая версия — из реестра npm, ставит её
// сам npm. Приложение работает из файлов пакета (Electron — тоже из него), а занятые файлы на Windows не заменить —
// поэтому помощник на системном Node: ждёт выхода приложения, ставит новую версию и запускает её. Лог — рядом.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** x.y.z новее? (пререлизы — по основной части) */
export function newer(a, b) {
  const p = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Адрес последней версии пакета в реестре (scoped-имя — с %2F). */
export const registryUrl = (spec) => `https://registry.npmjs.org/${spec.replace('/', '%2F')}/latest`;

/** Помощник обновления (системный Node): ждёт выхода приложения → npm ставит → запускает новую. */
export const HELPER = `
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const [pid, mode, spec, log] = process.argv.slice(2);
const win = process.platform === 'win32';
const say = (s) => { try { appendFileSync(log, new Date().toISOString() + ' ' + s + '\\n'); } catch {} };
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
for (let i = 0; i < 600 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 800));
if (mode === 'global') {
  say('npm i -g ' + spec);
  const r = spawnSync('npm', ['i', '-g', spec], { shell: win, encoding: 'utf8' });
  say('npm: код ' + r.status + ' ' + (r.stderr || '').slice(-500));
  spawn('perimeter', [], { detached: true, stdio: 'ignore', shell: win }).unref();
} else {
  say('npx -y ' + spec);
  spawn('npx', ['-y', spec], { detached: true, stdio: 'ignore', shell: win }).unref();
}
say('запущено');
`;

/**
 * @param {{ spec: string, mode: 'global' | 'npx', quit: () => void, fetchImpl?: typeof fetch,
 *           spawnImpl?: typeof spawn, dir?: string }} o
 */
export function npmChannel({ spec, mode, quit, fetchImpl = fetch, spawnImpl = spawn, dir = join(homedir(), '.perimeter-client') }) {
  return {
    mode,
    /** Последняя версия в реестре. */
    async latest() {
      const r = await fetchImpl(registryUrl(spec), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`реестр npm ответил ${r.status}`);
      const j = await r.json();
      if (typeof j.version !== 'string') throw new Error('реестр npm не вернул версию');
      return j.version;
    },
    /** Поставить версию: помощник ждёт выхода приложения, затем npm ставит и запускает новую; приложение выходит. */
    install(version) {
      mkdirSync(dir, { recursive: true });
      const script = join(tmpdir(), `perimeter-npm-update-${process.pid}.mjs`);
      writeFileSync(script, HELPER);
      const log = join(dir, 'npm-update.log');
      const child = spawnImpl('node', [script, String(process.pid), mode, `${spec}@${version}`, log], { detached: true, stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true });
      child.unref?.();
      quit();
      return { script, log };
    },
  };
}
