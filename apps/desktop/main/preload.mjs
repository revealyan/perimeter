// Мост main↔рендерер (contextIsolation): подключения VPS и их туннели, проброс портов, уведомления, автозапуск.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('perimeterIPC', {
  onTunnelStatus(cb) {
    ipcRenderer.on('perimeter:tunnel-status', (_e, status) => cb(status));
    return ipcRenderer.invoke('perimeter:tunnel-status');
  },
  notify(title, body) {
    if (localStorage.getItem('perimeter:notify') === 'off') return;
    ipcRenderer.invoke('perimeter:notify', { title, body });
  },
  autoLaunch() {
    return ipcRenderer.invoke('perimeter:auto-launch');
  },
  setAutoLaunch(enabled) {
    return ipcRenderer.invoke('perimeter:set-auto-launch', enabled);
  },
  localSupervisor() {
    return ipcRenderer.invoke('perimeter:local-supervisor');
  },
  startLocalSupervisor() {
    return ipcRenderer.invoke('perimeter:start-local-supervisor');
  },
  stopLocalSupervisor() {
    return ipcRenderer.invoke('perimeter:stop-local-supervisor');
  },
  onLocalSupervisorStatus(cb) {
    ipcRenderer.on('perimeter:local-sup-status', (_e, status) => cb(status));
    return ipcRenderer.invoke('perimeter:local-supervisor');
  },
  pickFolder() {
    return ipcRenderer.invoke('perimeter:pick-folder');
  },
  pathExists(p) {
    return ipcRenderer.invoke('perimeter:path-exists', p);
  },
  // ─── подключения VPS (как в Happy): несколько, у каждого свой ssh-туннель ───
  connections() {
    return ipcRenderer.invoke('perimeter:connections');
  },
  onConnections(cb) {
    ipcRenderer.on('perimeter:connections', (_e, list) => cb(list));
    return ipcRenderer.invoke('perimeter:connections');
  },
  addConnection(c) {
    return ipcRenderer.invoke('perimeter:add-connection', c);
  },
  updateConnection(id, patch) {
    return ipcRenderer.invoke('perimeter:update-connection', { id, patch });
  },
  removeConnection(id) {
    return ipcRenderer.invoke('perimeter:remove-connection', id);
  },
  testConnection(c) {
    return ipcRenderer.invoke('perimeter:test-connection', c);
  },
  pickKeyFile() {
    return ipcRenderer.invoke('perimeter:pick-key-file');
  },
  // ─── проброс портов (как в VS Code Remote SSH) ───
  forwardPort(remotePort, connId) {
    return ipcRenderer.invoke('perimeter:forward-port', { remotePort, ...(connId ? { connId } : {}) });
  },
  unforwardPort(remotePort, connId) {
    return ipcRenderer.invoke('perimeter:unforward-port', { remotePort, ...(connId ? { connId } : {}) });
  },
  forwards() {
    return ipcRenderer.invoke('perimeter:forwards');
  },
  onForwards(cb) {
    ipcRenderer.on('perimeter:forwards', (_e, list) => cb(list));
    return ipcRenderer.invoke('perimeter:forwards');
  },
  // ─── supervisor на сервере (АДР 004): статус, установка/обновление, откат, ход установки ───
  serverStatus(connId) {
    return ipcRenderer.invoke('perimeter:server-status', connId);
  },
  serverInstall(connId, serviceUser) {
    return ipcRenderer.invoke('perimeter:server-install', { id: connId, ...(serviceUser !== undefined ? { serviceUser } : {}) });
  },
  serverRollback(connId) {
    return ipcRenderer.invoke('perimeter:server-rollback', connId);
  },
  serverPackages(connId, pkgs) {
    return ipcRenderer.invoke('perimeter:server-packages', { id: connId, pkgs });
  },
  onServerLog(cb) {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('perimeter:server-log', h);
    return () => ipcRenderer.removeListener('perimeter:server-log', h);
  },
  tunnelInfo() {
    return ipcRenderer.invoke('perimeter:tunnel-info');
  },
  openExternal(url) {
    return ipcRenderer.invoke('perimeter:open-external', url);
  },
  /** «Не засыпать»: держит систему бодрой, пока рендерер не выключит (сессии закончили работу). */
  setKeepAwake(enabled) {
    return ipcRenderer.invoke('perimeter:keep-awake', enabled);
  },
});
