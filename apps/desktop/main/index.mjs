// Electron-оболочка: окно + подключения VPS (у каждого свой встроенный SSH-туннель) + локальный supervisor.
// Логика — в рендерере (React); supervisor-соединение рендерер тянет сам на 127.0.0.1:<localPort подключения>.
import { app, BrowserWindow, Notification, dialog, ipcMain, powerSaveBlocker, shell } from 'electron';
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Tunnel, testConnection } from './tunnel.mjs';
import { ConnectionManager, migrateClientDir, validateInput } from './connections.mjs';
import { ServerInstaller } from './server-install.mjs';
import { ensureLocalServer, localSupervisorEnv } from './local-server.mjs';

// имя приложения (профиль %APPDATA%/Perimeter вместо scoped-имени пакета «@perimeter/desktop»)
app.setName('Perimeter');

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

// Локальный supervisor (среда «Этот компьютер»): клиент сам поднимает его на :8791.
let localSup = null;
let localSupStatus = 'не запущен';
let localSupLastErr = '';

function setLocalStatus(s) {
  localSupStatus = s;
  if (win && !win.isDestroyed()) win.webContents.send('perimeter:local-sup-status', s);
}

/** Поднять процесс supervisor'а (аргументы и env уже собраны под режим). */
function spawnSupervisor(args, cwd, extraEnv) {
  // process.execPath в Electron — сам electron.exe: без ELECTRON_RUN_AS_NODE он поднимет второе окно приложения, а не Node
  localSup = spawn(process.execPath, args, {
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
  localSupLastErr = '';
  localSup.stdout?.on('data', (d) => {
    const line = String(d).trim();
    if (line.includes('ws://')) setLocalStatus('запущен');
  });
  // stderr — не обязательно ошибка (предупреждения Node); показываем только при падении
  localSup.stderr?.on('data', (d) => { localSupLastErr = String(d).trim().split(/\r?\n/).pop()?.slice(0, 160) ?? ''; });
  localSup.on('error', (err) => { localSup = null; setLocalStatus(`ошибка запуска: ${String(err.message).slice(0, 120)}`); });
  localSup.on('exit', (code) => {
    localSup = null;
    setLocalStatus(code === 0 || code === null ? 'остановлен' : `упал (код ${code})${localSupLastErr ? `: ${localSupLastErr}` : ''}`);
  });
  setLocalStatus('запускается…');
}

/** Установка packaged-локального supervisor (докачка движка) — один промис на все вызовы. */
let localSupInstall = null;

async function startLocalSupervisor() {
  if (localSup) return localSupStatus;
  if (app.isPackaged) {
    // packaged: бандл в resources, нативные пакеты — в профиль пользователя (один раз на версию)
    if (!localSupInstall) {
      localSupInstall = ensureLocalServer({
        bundleDir: join(process.resourcesPath, 'app-supervisor'),
        installRoot: join(app.getPath('userData'), 'local-server'),
        onStatus: setLocalStatus,
      }).catch((e) => { localSupInstall = null; throw e; });
    }
    let inst;
    try { inst = await localSupInstall; }
    catch (e) { setLocalStatus(`движок не установился: ${String(e.message).slice(0, 140)}`); return localSupStatus; }
    setLocalStatus('запускается…');
    spawnSupervisor([join(inst.dir, 'supervisor.mjs')], inst.dir, localSupervisorEnv({ app, installDir: inst.dir }));
    return localSupStatus;
  }
  // dev: из исходников репозитория (tsx), состояние рядом с репо
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  spawnSupervisor(['--import', 'tsx', 'packages/supervisor/src/main.ts'], repoRoot, {
    PERIMETER_STATE: join(repoRoot, '.local-state.json'),
    // хранилище проектов этого компьютера: по умолчанию — папка рядом с репозиторием (у владельца это C:/devs/revealyan)
    PERIMETER_PROJECTS_ROOT: process.env.PERIMETER_PROJECTS_ROOT ?? dirname(repoRoot),
  });
  return localSupStatus;
}

/** Остановить локальный supervisor вместе с дочерними процессами claude. */
function stopLocalSupervisor() {
  if (!localSup) return;
  const pid = localSup.pid;
  // на Windows kill() не доставляет SIGTERM и оставляет сиротами процессы claude — гасим всё дерево
  if (process.platform === 'win32' && pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else localSup.kill('SIGTERM');
  localSup = null;
  setLocalStatus('остановлен');
}

let win = null;
/** сырой статус первого подключения — для старого onTunnelStatus ('up' | 'connecting' | 'down' | текст ошибки) */
let tunnelStatus = 'нет конфига';

function send(channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

// Подключения VPS (как в Happy): несколько, у каждого свой туннель; «Этот компьютер» — локальный supervisor выше.
const conns = new ConnectionManager({
  TunnelClass: Tunnel,
  onChange: (list) => {
    send('perimeter:connections', list);
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
  // packaged: собранный рендерер из файлов; dev: vite-сервер
  if (app.isPackaged) win.loadFile(join(import.meta.dirname, '..', 'dist-renderer', 'index.html'));
  else win.loadURL(devUrl);
  win.webContents.on('did-finish-load', () => {
    send('perimeter:tunnel-status', tunnelStatus);
    setLocalStatus(localSupStatus);
    send('perimeter:connections', conns.list());
    send('perimeter:forwards', conns.forwards());
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
ipcMain.handle('perimeter:local-supervisor', () => localSupStatus);
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

app.whenReady().then(createWindow);
app.on('before-quit', () => stopLocalSupervisor());
app.on('window-all-closed', () => {
  conns.stopAll();
  stopLocalSupervisor();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
