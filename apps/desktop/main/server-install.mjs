// Установщик supervisor'а на сервер по ssh подключения (АДР 004, как VS Code Remote SSH).
// Сборка — packages/supervisor/scripts/build-server.mjs: в режиме разработки собирается из исходников при каждом
// запросе статуса (папка по содержимому — пересборка без правок ничего не меняет); PERIMETER_SERVER_BUNDLE — готовая папка.
// На сервере всё делает perimeter-server.sh из сборки: status (скрипт идёт через stdin, ничего не кладётся),
// install (сборка — во временную папку по sftp, скрипт ставит и переключает службу, сам откатывается),
// rollback (на previous). Обновление — только по кнопке (решение владельца 2026-11-13): main сам ничего не ставит.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ssh2 from 'ssh2';
import { buildAuth, sshErrorText } from './tunnel.mjs';

const { Client } = ssh2;

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const SERVER_FILES = ['supervisor.mjs', 'package.json', 'package-lock.json', 'manifest.json', 'server.env', 'perimeter-server.sh', 'start.sh'];

/** Аргумент для sh в одинарных кавычках. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Вывод `perimeter-server.sh status` (строки ключ=значение) → статус для UI. */
export function parseStatus(text) {
  const kv = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const mode = kv.mode === 'user' ? 'user' : 'system';
  return {
    mode,
    sshUser: kv.ssh_user ?? '',
    serviceUser: kv.svc_user ?? '',
    serviceHome: kv.svc_home ?? '',
    arch: kv.arch ?? '',
    systemd: kv.systemd === 'yes',
    unit: kv.unit === 'yes',
    unitUser: kv.unit_user ?? '',
    managed: kv.unit_managed === 'yes',
    active: kv.active ?? '',
    current: kv.current ?? '',
    previous: kv.previous ?? '',
    running: kv.running ?? '',
    busy: Number(kv.busy) || 0,
    // системные пакеты полного функционала (git/xvfb/gcc/make/python3) — предложение «установить недостающее»
    packagesMissing: (kv.packages_missing ?? '').split(/[ ,]+/).filter(Boolean),
    pkgManager: kv.pkg_manager === 'apt' ? 'apt' : 'none',
    ...(kv.linger !== undefined ? { linger: kv.linger } : {}),
    // возможности сервера группами (git · терминал · браузер · docker); старый скрипт их не сообщает — нет поля
    ...(Object.keys(kv).some((k) => k.startsWith('feature_')) ? { features: featuresOf(kv) } : {}),
  };
}

/** Группы возможностей сервера, которые установщик умеет ставить. */
export const FEATURES = ['git', 'terminal', 'browser', 'docker'];

/** feature_<имя>=ok|missing|manual (+ feature_<имя>_why) → { имя: { state, why? } }. */
export function featuresOf(kv) {
  const out = {};
  for (const f of FEATURES) {
    const v = kv[`feature_${f}`];
    if (v !== 'ok' && v !== 'missing' && v !== 'manual') continue;
    out[f] = { state: v, ...(kv[`feature_${f}_why`] ? { why: kv[`feature_${f}_why`] } : {}) };
  }
  return out;
}

/**
 * Что делать с сервером при версии приложения appVersion:
 * 'install' — supervisor'а из установщика нет (или служба из исходников), 'update' — другая версия,
 * 'ok' — стоит та же и отвечает, 'restart' — стоит та же, но не отвечает (переустановка поднимет).
 */
export function planOf(st, appVersion) {
  if (!st.managed || !st.current) return 'install';
  if (st.current !== appVersion) return 'update';
  return st.running === appVersion ? 'ok' : 'restart';
}

/** Итог для UI: при неудаче — строка «ОШИБКА: …», при успехе — «готово: …» (stderr досылается последним), иначе последняя непустая. */
export function resultMessage(lines, ok) {
  const rev = [...lines].reverse();
  const err = rev.find((l) => l.startsWith('ОШИБКА:'));
  if (!ok && err) return err.slice('ОШИБКА:'.length).trim();
  const done = ok ? rev.find((l) => l.startsWith('готово')) : undefined;
  if (done) return done;
  const last = rev.find((l) => l.trim() !== '');
  return last ?? (ok ? 'готово' : 'не получилось');
}

/** Пользователь службы для команд: ssh не под root — он сам; под root — из подключения (пусто — скрипт возьмёт из юнита). */
export function serviceUserArg(conn) {
  return conn.user === 'root' ? (conn.serviceUser ?? '') : conn.user;
}

// ─── ssh ───────────────────────────────────────────────────────────────────

/** ssh-соединение по параметрам подключения (те же ключи/агент, что у туннеля). */
export function sshConnect(conn, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cfg = { user: conn.user, ...(conn.privateKey ? { privateKeyPath: conn.privateKey } : {}) };
    let auth;
    try { auth = buildAuth(cfg); } catch (e) { reject(e); return; }
    const c = new Client();
    c.once('ready', () => resolve(c));
    c.once('error', (err) => reject(new Error(sshErrorText(err))));
    c.connect({ host: conn.host, port: conn.port ?? 22, username: conn.user, authHandler: auth, readyTimeout: timeoutMs, keepaliveInterval: 15000 });
  });
}

/** Команда по ssh: построчно в onLine (stdout и stderr вместе), stdin — строка или нет. → { code, lines } */
export function sshExec(c, command, { stdin, onLine } = {}) {
  return new Promise((resolve, reject) => {
    c.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      const lines = [];
      const bufs = { out: '', err: '' };
      const feed = (k, chunk, flush = false) => {
        bufs[k] += chunk;
        const parts = bufs[k].split(/\r?\n/);
        bufs[k] = flush ? '' : parts.pop() ?? '';
        for (const l of parts) {
          if (flush && l === '') continue;
          lines.push(l);
          try { onLine?.(l); } catch { /* окно могло закрыться */ }
        }
      };
      stream.on('data', (d) => feed('out', String(d)));
      stream.stderr.on('data', (d) => feed('err', String(d)));
      stream.on('close', (code) => {
        feed('out', '', true);
        feed('err', '', true);
        resolve({ code: typeof code === 'number' ? code : 1, lines });
      });
      if (stdin !== undefined) stream.end(stdin);
      else stream.end();
    });
  });
}

/** Скрипт с этой машины выполнить на сервере: через stdin во временный файл (дочерние команды stdin не съедят). */
export function runScript(c, script, args, opts = {}) {
  const cmd = `sh -c 'f=$(mktemp) || exit 1; cat >"$f"; sh "$f" "$@"; rc=$?; rm -f "$f"; exit $rc' sh ${args.map(shq).join(' ')}`;
  return sshExec(c, cmd, { ...opts, stdin: script });
}

function sftpOf(c) {
  return new Promise((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))));
}

function sftpPut(sftp, local, remote) {
  return new Promise((resolve, reject) => sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve())));
}

// ─── сборка ────────────────────────────────────────────────────────────────

/** Готовая сборка из PERIMETER_SERVER_BUNDLE или свежая из исходников (dev). → { version, dir } */
export async function devBundle(env = process.env) {
  const ready = env.PERIMETER_SERVER_BUNDLE;
  if (ready) {
    const m = JSON.parse(readFileSync(join(ready, 'manifest.json'), 'utf8'));
    return { version: m.version, dir: ready };
  }
  const mod = await import(pathToFileURL(join(repoRoot, 'packages', 'supervisor', 'scripts', 'build-server.mjs')).href);
  return mod.buildServer();
}

// ─── установщик ────────────────────────────────────────────────────────────

export class ServerInstaller {
  /**
   * @param getBundle () => Promise<{ version, dir }> — сборка supervisor'а
   * @param connect (conn) => Promise<ssh2.Client> — подменяется в тестах
   */
  constructor({ getBundle = devBundle, connect = sshConnect } = {}) {
    this.getBundle = getBundle;
    this.connect = connect;
    /** id подключений, где идёт установка/откат */
    this.busy = new Set();
    this.bundleRun = null;
  }

  /** Сборка: параллельные запросы ждут одну и ту же. */
  bundle() {
    this.bundleRun ??= this.getBundle().finally(() => { this.bundleRun = null; });
    return this.bundleRun;
  }

  async withSsh(conn, fn) {
    const c = await this.connect(conn);
    try { return await fn(c); } finally { try { c.end(); } catch { /* уже закрыто */ } }
  }

  /** Что стоит на сервере и что предлагать. → { ok, appVersion, plan, ...статус } | { ok: false, message } */
  async status(conn) {
    try {
      const b = await this.bundle();
      const script = readFileSync(join(b.dir, 'perimeter-server.sh'), 'utf8');
      const r = await this.withSsh(conn, (c) => runScript(c, script, ['status', serviceUserArg(conn), String(conn.remotePort ?? 8790)]));
      if (r.code !== 0) return { ok: false, message: resultMessage(r.lines, false) };
      const st = parseStatus(r.lines.join('\n'));
      return { ok: true, appVersion: b.version, plan: planOf(st, b.version), installing: this.busy.has(conn.id), ...st };
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  }

  /** Поставить версию приложения и переключить службу. onLine — ход установки. → { ok, message, version } */
  async install(conn, onLine) {
    if (this.busy.has(conn.id)) return { ok: false, message: 'установка на этот сервер уже идёт' };
    this.busy.add(conn.id);
    try {
      const b = await this.bundle();
      onLine?.(`сборка ${b.version}`);
      return await this.withSsh(conn, async (c) => {
        const mk = await sshExec(c, 'mktemp -d /tmp/perimeter-install.XXXXXX');
        const stage = mk.lines[0]?.trim();
        if (mk.code !== 0 || !stage?.startsWith('/tmp/perimeter-install.')) throw new Error(`не создалась временная папка: ${mk.lines.join(' ')}`);
        onLine?.(`отправляю сборку на сервер (${stage})…`);
        const sftp = await sftpOf(c);
        try {
          for (const f of SERVER_FILES) await sftpPut(sftp, join(b.dir, f), `${stage}/${f}`);
        } finally { sftp.end(); }
        const user = serviceUserArg(conn);
        const cmd = `sh ${shq(`${stage}/perimeter-server.sh`)} install ${shq(stage)} ${shq(user)} ${shq(String(conn.remotePort ?? 8790))}; rc=$?; rm -rf ${shq(stage)}; exit $rc`;
        const r = await sshExec(c, cmd, { onLine });
        const ok = r.code === 0;
        return { ok, version: b.version, message: resultMessage(r.lines, ok) };
      });
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) };
    } finally {
      this.busy.delete(conn.id);
    }
  }

  /** Вернуть прошлую версию (previous). → { ok, message } */
  async rollback(conn, onLine) {
    if (this.busy.has(conn.id)) return { ok: false, message: 'на этом сервере уже идёт установка' };
    this.busy.add(conn.id);
    try {
      const b = await this.bundle();
      const script = readFileSync(join(b.dir, 'perimeter-server.sh'), 'utf8');
      const r = await this.withSsh(conn, (c) => runScript(c, script, ['rollback', serviceUserArg(conn), String(conn.remotePort ?? 8790)], { onLine }));
      const ok = r.code === 0;
      return { ok, message: resultMessage(r.lines, ok) };
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) };
    } finally {
      this.busy.delete(conn.id);
    }
  }

  /**
   * Поставить возможность сервера (git · terminal · browser · docker) — скрипт сам знает, какие пакеты и шаги;
   * терминал после пересборки node-pty перезапускает службу. → { ok, message }
   */
  async feature(conn, name, onLine) {
    if (!FEATURES.includes(name)) return { ok: false, message: `неизвестная возможность «${name}»` };
    if (this.busy.has(conn.id)) return { ok: false, message: 'на этом сервере уже идёт установка' };
    this.busy.add(conn.id);
    try {
      const b = await this.bundle();
      const script = readFileSync(join(b.dir, 'perimeter-server.sh'), 'utf8');
      const r = await this.withSsh(conn, (c) => runScript(c, script, ['feature', name, serviceUserArg(conn)], { onLine }));
      const ok = r.code === 0;
      return { ok, message: resultMessage(r.lines, ok) };
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) };
    } finally {
      this.busy.delete(conn.id);
    }
  }

  /**
   * Системные пакеты полного функционала (git/xvfb/gcc/make/python3): root — ставит, sudo -n — ставит,
   * иначе сервер отвечает командой для рук (сообщение придёт в onLine/итог). → { ok, message }
   */
  async packages(conn, pkgs, onLine) {
    if (this.busy.has(conn.id)) return { ok: false, message: 'на этом сервере уже идёт установка' };
    this.busy.add(conn.id);
    try {
      const b = await this.bundle();
      const script = readFileSync(join(b.dir, 'perimeter-server.sh'), 'utf8');
      const r = await this.withSsh(conn, (c) => runScript(c, script, ['packages', ...pkgs], { onLine }));
      const ok = r.code === 0;
      return { ok, message: resultMessage(r.lines, ok) };
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) };
    } finally {
      this.busy.delete(conn.id);
    }
  }
}
