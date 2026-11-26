// Electron-оболочка: окно + подключения VPS (у каждого свой встроенный SSH-туннель) + локальный supervisor.
// Логика — в рендерере (React); supervisor-соединение рендерер тянет сам на 127.0.0.1:<localPort подключения>.
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, powerSaveBlocker, shell } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Tunnel, testConnection } from './tunnel.mjs';
import { ConnectionManager, migrateClientDir, validateInput } from './connections.mjs';
import { ServerInstaller } from './server-install.mjs';
import { ensureLocalServer, localSupervisorEnv } from './local-server.mjs';
import { installKeyWithPassword } from './ssh-keys.mjs';
import { LocalSupervisor } from './local-sup.mjs';
import { AppUpdater } from './updater.mjs';
import { ServerAutoUpdate } from './server-autoupdate.mjs';
import { npmChannel } from './npm-channel.mjs';
import electronUpdater from 'electron-updater';

// имя приложения (профиль %APPDATA%/Perimeter вместо scoped-имени пакета «@perimeter/desktop»)
app.setName('Perimeter');

// Как запущено: packaged — установщик/dmg (electron-builder); npm — пакет из реестра (`npx @revealyan/perimeter`:
// Electron из зависимостей + это приложение, без подписей — npm не ставит пометок «скачано из интернета», владелец
// 2026-11-26: «делаем, пока нет подписки»); dev — репозиторий. packaged и npm — «готовые»: рендерер собран,
// бандлы supervisor'а лежат в resources (у npm — рядом с приложением, а не в process.resourcesPath Electron'а).
const DIST = app.isPackaged ? 'packaged' : process.env.PERIMETER_DIST === 'npm' ? 'npm' : 'dev';
const shipped = DIST !== 'dev';
const resourcesDir = DIST === 'packaged' ? process.resourcesPath : join(import.meta.dirname, '..', 'resources');

// готовые: серверная сборка для VPS едет в resources (исходников в установке нет);
// devBundle установщика читает её через PERIMETER_SERVER_BUNDLE
if (shipped) process.env.PERIMETER_SERVER_BUNDLE = join(resourcesDir, 'app-server');

const devUrl = process.env.PERIMETER_DEV_URL ?? 'http://localhost:5173';

// Профиль приложения назывался «@codecode» до переименования (Electron берёт имя пакета): первого запуска
// под новым именем переносим старую папку целиком — настройки интерфейса, localStorage и кэш не теряются
// (миграция ключей codecode:* → perimeter:* в рендерере затем дообрабатывает содержимое).
{
  const userData = app.getPath('userData');
  const legacy = join(app.getPath('appData'), '@codecode');
  if (!existsSync(userData) && existsSync(legacy)) {
    try { renameSync(legacy, userData); } catch { /* перенос не вышел — начнём с пустого профиля */ }
  }
}

// Локальный supervisor (среда «Этот компьютер»): клиент сам поднимает его на :8791 (local-sup.mjs — один запуск за раз).
function setLocalStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('perimeter:local-sup-status', s);
}

/** Процесс supervisor'а: process.execPath в Electron — сам electron.exe, без ELECTRON_RUN_AS_NODE он поднимет второе окно. */
function spawnProc(args, cwd, extraEnv) {
  return spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PERIMETER_PORT: '8791',
      PERIMETER_HOST: '127.0.0.1',
      PERIMETER_POOL_SIZE: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** Остановить вместе с дочерними процессами claude: на Windows kill() не доставляет SIGTERM и оставляет сирот. */
function killTree(child) {
  const pid = child.pid;
  if (process.platform === 'win32' && pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** Установка packaged-локального supervisor (докачка движка) — один промис на все вызовы. */
let localSupInstall = null;

/** Что запускать: готовые (packaged, npm) — бандл из resources и движок в профиле (докачка один раз на версию); dev — исходники. */
async function prepareLocal(onStatus) {
  if (shipped) {
    if (!localSupInstall) {
      localSupInstall = ensureLocalServer({
        bundleDir: join(resourcesDir, 'app-supervisor'),
        installRoot: join(app.getPath('userData'), 'local-server'),
        onStatus,
      }).catch((e) => { localSupInstall = null; throw e; });
    }
    const inst = await localSupInstall;
    return { args: [join(inst.dir, 'supervisor.mjs')], cwd: inst.dir, env: localSupervisorEnv({ app, installDir: inst.dir }) };
  }
  // dev: из исходников репозитория (tsx), состояние рядом с репо
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  return {
    args: ['--import', 'tsx', 'packages/supervisor/src/main.ts'],
    cwd: repoRoot,
    env: {
      PERIMETER_STATE: join(repoRoot, '.local-state.json'),
      // хранилище проектов этого компьютера: по умолчанию — папка рядом с репозиторием (у владельца это C:/devs/revealyan)
      PERIMETER_PROJECTS_ROOT: process.env.PERIMETER_PROJECTS_ROOT ?? dirname(repoRoot),
    },
  };
}

const localSup = new LocalSupervisor({ prepare: prepareLocal, spawnProc, killTree, onStatus: setLocalStatus });
const startLocalSupervisor = () => localSup.start();
const stopLocalSupervisor = () => localSup.stop();

let win = null;
/** сырой статус первого подключения — для старого onTunnelStatus ('up' | 'connecting' | 'down' | текст ошибки) */
let tunnelStatus = 'нет конфига';

function send(channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

// Подключения VPS (как в Happy): несколько, у каждого свой туннель; «Этот компьютер» — локальный supervisor выше.
/** автообновление supervisor'а на серверах — создаётся ниже, рядом с установщиком */
let serverAuto = null;
const conns = new ConnectionManager({
  TunnelClass: Tunnel,
  onChange: (list) => {
    send('perimeter:connections', list);
    serverAuto?.onConnections(list);
    const f = conns.first();
    const raw = !f ? 'нет конфига' : !f.conn.enabled ? 'down' : f.raw || 'connecting';
    if (raw !== tunnelStatus) {
      tunnelStatus = raw;
      send('perimeter:tunnel-status', raw);
    }
  },
  onForwards: (list) => send('perimeter:forwards', list),
  onError: (msg) => console.error(`[подключения] ${msg}`),
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#171614',
    title: 'perimeter',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: new URL('./preload.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    },
  });
  // новые окна (ссылки с target=_blank, всплывающие окна превью) — во внешний браузер, не окном Electron без защиты
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // готовые: собранный рендерер из файлов; dev: vite-сервер
  if (shipped) win.loadFile(join(import.meta.dirname, '..', 'dist-renderer', 'index.html'));
  else win.loadURL(devUrl);
  win.webContents.on('did-finish-load', () => {
    send('perimeter:tunnel-status', tunnelStatus);
    setLocalStatus(localSup.status);
    send('perimeter:connections', conns.list());
    send('perimeter:forwards', conns.forwards());
    send('perimeter:update', appUpdater.state);
  });
}

migrateClientDir(); // до первого чтения: конфиги времён «codecode» переезжают в ~/.perimeter-client
conns.start();

ipcMain.handle('perimeter:tunnel-status', () => tunnelStatus);
ipcMain.handle('perimeter:notify', (_e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title: String(title), body: String(body) }).show();
});
ipcMain.handle('perimeter:auto-launch', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('perimeter:set-auto-launch', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('perimeter:local-supervisor', () => localSup.status);
ipcMain.handle('perimeter:start-local-supervisor', () => startLocalSupervisor());
ipcMain.handle('perimeter:stop-local-supervisor', () => { stopLocalSupervisor(); return 'остановлен'; });
// выбор папки на этой машине (привязка проекта в среде «Этот компьютер»)
ipcMain.handle('perimeter:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win ?? undefined, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle('perimeter:path-exists', (_e, p) => typeof p === 'string' && p !== '' && existsSync(p));
// подключения VPS: список, добавить, правка (в т. ч. включить/выключить), удалить, пробное подключение
ipcMain.handle('perimeter:connections', () => conns.list());
ipcMain.handle('perimeter:add-connection', (_e, c) => conns.add(c ?? {}));
ipcMain.handle('perimeter:update-connection', (_e, arg) => conns.update(String(arg?.id ?? ''), arg?.patch ?? {}));
ipcMain.handle('perimeter:remove-connection', (_e, id) => conns.remove(String(id ?? '')));
ipcMain.handle('perimeter:test-connection', async (_e, c) => {
  let v;
  try { v = validateInput(c ?? {}); } catch (e) { return { ok: false, message: e.message }; }
  return testConnection({
    host: v.host,
    port: v.port ?? 22,
    user: v.user,
    remotePort: v.remotePort ?? 8790,
    ...(v.privateKey ? { privateKeyPath: v.privateKey } : {}),
  });
});
// новый сервер по паролю (docs/design/onboarding.md): один вход паролем → ключ приложения в authorized_keys →
// дальше подключение ходит ключом. Пароль только в памяти этого вызова — не пишется и не логируется.
ipcMain.handle('perimeter:setup-key', async (_e, arg) => {
  const host = String(arg?.host ?? '').trim();
  const user = String(arg?.user ?? '').trim();
  const port = arg?.port === undefined || arg?.port === null || arg?.port === '' ? 22 : Number(arg.port);
  const password = typeof arg?.password === 'string' ? arg.password : '';
  if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: 'нужны хост, пользователь и порт ssh' };
  if (!password) return { ok: false, message: 'введите пароль' };
  try {
    const r = await installKeyWithPassword({ host, port, user, password });
    return { ok: true, privateKeyPath: r.privateKeyPath, message: 'ключ приложения на сервере — дальше вход по нему' };
  } catch (e) {
    return { ok: false, message: String(e?.message ?? e) };
  }
});
// выбор файла ключа ssh для формы подключения (открывается в ~/.ssh)
ipcMain.handle('perimeter:pick-key-file', async () => {
  const r = await dialog.showOpenDialog(win ?? undefined, {
    title: 'Ключ ssh',
    defaultPath: join(homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
// проброс портов VPS (как в VS Code Remote SSH) через ssh-коннект подключения; без connId — первое подключение
const portOf = (v) => {
  const p = Number(v);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('неверный номер порта');
  return p;
};
ipcMain.handle('perimeter:forward-port', async (_e, arg) => conns.forwardPort(portOf(arg?.remotePort), arg?.connId ? String(arg.connId) : undefined));
ipcMain.handle('perimeter:unforward-port', (_e, arg) => conns.unforwardPort(portOf(arg?.remotePort), arg?.connId ? String(arg.connId) : undefined));
ipcMain.handle('perimeter:forwards', () => conns.forwards());
// supervisor на сервере (АДР 004): статус, установка/обновление и откат — только по кнопке в настройках подключения
const installer = new ServerInstaller();

// настройки приложения (не окна): автообновление supervisor'а на серверах — по умолчанию да
const appSettingsFile = join(app.getPath('userData'), 'app-settings.json');
let appSettings = { autoServerUpdate: true };
try { appSettings = { ...appSettings, ...JSON.parse(readFileSync(appSettingsFile, 'utf8')) }; } catch { /* нет файла — умолчания */ }
ipcMain.handle('perimeter:app-settings', () => appSettings);
// Картинка из буфера обмена напрямую из ОС: вставка в окне иногда даёт файл 0 байт (Windows отдаёт отложенный
// файл — мессенджеры, проводник), а битмап в буфере есть; null — картинки в буфере нет.
ipcMain.handle('perimeter:clipboard-image', () => {
  const img = clipboard.readImage();
  return img.isEmpty() ? null : img.toDataURL();
});
ipcMain.handle('perimeter:set-app-settings', (_e, patch) => {
  if (patch && typeof patch.autoServerUpdate === 'boolean') appSettings.autoServerUpdate = patch.autoServerUpdate;
  try { writeFileSync(appSettingsFile, JSON.stringify(appSettings, null, 2)); } catch { /* профиль недоступен — до перезапуска */ }
  return appSettings;
});
// supervisor на серверах — за приложением: подключились, там прошлая версия, ходов нет — обновляем (server-autoupdate.mjs)
serverAuto = new ServerAutoUpdate({
  installer,
  config: (id) => conns.config(id),
  enabled: () => appSettings.autoServerUpdate !== false,
  packaged: shipped,
  onEvent: (e) => send('perimeter:server-update', e),
  onLine: (id, line) => send('perimeter:server-log', { connId: id, line }),
});
serverAuto.onConnections(conns.list());
const connOf = (id) => conns.config(String(id ?? ''));
const logTo = (id) => (line) => send('perimeter:server-log', { connId: id, line });
ipcMain.handle('perimeter:server-status', async (_e, id) => {
  try { return await installer.status(connOf(id)); } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('perimeter:server-install', async (_e, arg) => {
  const id = String(arg?.id ?? '');
  try {
    // пользователь службы (ssh под root) сохраняется в подключении — дальше статус и откат берут его
    if (arg?.serviceUser !== undefined) await conns.update(id, { serviceUser: String(arg.serviceUser) });
    return await installer.install(connOf(id), logTo(id));
  } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('perimeter:server-rollback', async (_e, id) => {
  try { return await installer.rollback(connOf(id), logTo(String(id))); } catch (e) { return { ok: false, message: e.message }; }
});
// возможности сервера группами (git · терминал · браузер · docker): что ставить — решает скрипт сервера
ipcMain.handle('perimeter:server-feature', async (_e, arg) => {
  const id = String(arg?.id ?? '');
  try { return await installer.feature(connOf(id), String(arg?.name ?? ''), logTo(id)); } catch (e) { return { ok: false, message: e.message }; }
});
// «Установить недостающее» (git, xvfb, сборка node-pty…): только имена пакетов — без опций apt (ведущий «-»)
ipcMain.handle('perimeter:server-packages', async (_e, arg) => {
  const id = String(arg?.id ?? '');
  const pkgs = (Array.isArray(arg?.pkgs) ? arg.pkgs : []).map(String).filter((p) => /^[a-z0-9][a-z0-9+.-]{0,63}$/.test(p));
  if (pkgs.length === 0) return { ok: false, message: 'нечего ставить' };
  try { return await installer.packages(connOf(id), pkgs, logTo(id)); } catch (e) { return { ok: false, message: e.message }; }
});
// хост первого VPS для ссылок «Открыть в VS Code (Remote SSH)» — без ключей и прочих секретов
ipcMain.handle('perimeter:tunnel-info', () => {
  const f = conns.first();
  return f ? { host: f.conn.host, user: f.conn.user, port: f.conn.port } : null;
});
// «не засыпать», пока идёт работа сессий (тумблер в настройках; включается, когда хоть одна сессия работает)
let keepAwakeId = null;
ipcMain.handle('perimeter:keep-awake', (_e, enabled) => {
  const want = enabled === true;
  if (want && keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  else if (!want && keepAwakeId !== null) {
    if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
  return keepAwakeId !== null;
});
// внешние ссылки: VS Code и браузер ОС; прочие схемы не открываем
ipcMain.handle('perimeter:open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^(vscode|vscode-insiders|https?):/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

// обновление приложения: установленная версия (NSIS) — сама, portable и dev — нет (updater.mjs)
const appUpdater = new AppUpdater({
  updater: app.isPackaged ? electronUpdater.autoUpdater : null,
  version: app.getVersion(),
  portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
  packaged: shipped,
  // npm: новая версия — из реестра npm, ставит её npm (после выхода приложения: свои файлы занятыми не обновить)
  ...(DIST === 'npm' ? { npm: npmChannel({ spec: process.env.PERIMETER_NPM_SPEC ?? '@revealyan/perimeter', mode: process.env.PERIMETER_NPM_MODE === 'npx' ? 'npx' : 'global', quit: () => app.quit() }) } : {}),
  // macOS без подписи Apple: автоустановка невозможна — находим версию и ведём на страницу релиза
  manual: process.platform === 'darwin',
  openUrl: (url) => void shell.openExternal(url),
  onState: (s) => send('perimeter:update', s),
});
ipcMain.handle('perimeter:update-state', () => appUpdater.state);
ipcMain.handle('perimeter:update-check', () => appUpdater.check());
ipcMain.handle('perimeter:update-install', () => appUpdater.install());

app.whenReady().then(() => { createWindow(); appUpdater.start(); });
app.on('before-quit', () => stopLocalSupervisor());
app.on('window-all-closed', () => {
  conns.stopAll();
  stopLocalSupervisor();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
