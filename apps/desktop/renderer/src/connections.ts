// Подключения (как в Happy): «Этот компьютер» есть всегда, VPS — подключаемые, их может быть несколько.
// В приложении список держит Electron (~/.perimeter-client/connections.json, ssh-туннель на каждое подключение);
// в браузерном стенде без Electron — localStorage (perimeter:dev-connections), чтобы проверять несколько VPS.

export const LOCAL = 'local';

export interface ConnInput {
  name: string;
  host: string;
  port?: number;
  user: string;
  /** путь к ключу ssh на этой машине (сам ключ никуда не передаётся) */
  privateKey?: string;
  /** порт supervisor'а на VPS (по умолчанию 8790) */
  remotePort?: number;
  /** под кем работает supervisor при входе под root (установщик, АДР 004) */
  serviceUser?: string;
}

export interface Conn extends Partial<ConnInput> {
  id: string;
  name: string;
  kind: 'local' | 'vps';
  enabled: boolean;
  wsUrl: string;
  /** статус туннеля/процесса: «подключён», «подключаюсь…», «нет связи: …», «выключен» */
  status?: string;
  localPort?: number;
}

/** Новые методы моста Electron (контракт помощника main); старого приложения может не быть. */
interface ConnIPC {
  connections?(): Promise<Array<Omit<Conn, 'kind'>>>;
  onConnections?(cb: (list: Array<Omit<Conn, 'kind'>>) => void): Promise<Array<Omit<Conn, 'kind'>>>;
  addConnection?(c: ConnInput): Promise<Omit<Conn, 'kind'>>;
  updateConnection?(id: string, patch: Partial<ConnInput> & { enabled?: boolean }): Promise<Omit<Conn, 'kind'>>;
  removeConnection?(id: string): Promise<boolean>;
  testConnection?(c: ConnInput): Promise<{ ok: boolean; message: string }>;
  pickKeyFile?(): Promise<string | null>;
  forwardPort?(remotePort: number, connId?: string): Promise<string>;
  unforwardPort?(remotePort: number, connId?: string): Promise<boolean>;
  forwards?(): Promise<Forward[]>;
  onForwards?(cb: (list: Forward[]) => void): Promise<Forward[]>;
  onTunnelStatus?(cb: (status: string) => void): Promise<string>;
  tunnelInfo?(): Promise<{ host: string; user: string; port: number } | null>;
}

export interface Forward { connId: string; remotePort: number; localPort: number; url: string }

export function ipc(): ConnIPC | undefined {
  return (window as unknown as { perimeterIPC?: ConnIPC }).perimeterIPC;
}

const DEV_KEY = 'perimeter:dev-connections';
const LOCAL_ON_KEY = 'perimeter:local-enabled';

/** «Этот компьютер»: включён, если явно не выключали (раньше режим «Только VPS» — выключен). */
export function localEnabled(): boolean {
  const v = localStorage.getItem(LOCAL_ON_KEY);
  if (v !== null) return v !== 'off';
  return localStorage.getItem('perimeter:envs') !== 'vps';
}

function localConn(status?: string): Conn {
  return {
    id: LOCAL, name: 'Этот компьютер', kind: 'local', enabled: localEnabled(),
    wsUrl: localStorage.getItem('perimeter:ws-local') ?? 'ws://127.0.0.1:8791',
    ...(status !== undefined ? { status } : {}),
  };
}

/** Список VPS стенда (без Electron): по умолчанию — одно подключение 'vps' на perimeter:ws (как раньше). */
function devVps(): Conn[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_KEY) ?? 'null') as Array<Omit<Conn, 'kind'>> | null;
    if (Array.isArray(raw)) return raw.map((c) => ({ ...c, kind: 'vps' as const }));
  } catch { /* битый — по умолчанию */ }
  return [{
    id: 'vps', name: 'VPS', kind: 'vps', enabled: localStorage.getItem('perimeter:envs') !== 'local',
    wsUrl: localStorage.getItem('perimeter:ws') ?? 'ws://127.0.0.1:8790',
  }];
}

function saveDev(list: Conn[]): void {
  localStorage.setItem(DEV_KEY, JSON.stringify(list.filter((c) => c.kind === 'vps').map(({ kind: _k, status: _s, ...rest }) => rest)));
}

/** Хранилище подключений: подписка, добавление/правка/удаление (через Electron или localStorage стенда). */
class ConnectionsStore {
  list: Conn[] = [localConn(), ...devVps()];
  private listeners = new Set<() => void>();
  private started = false;
  private localStatus: string | undefined;

  /** Electron с новым мостом — список ведёт main. */
  get managed(): boolean {
    return typeof ipc()?.connections === 'function';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private setVps(vps: Array<Omit<Conn, 'kind'>>): void {
    this.list = [localConn(this.localStatus), ...vps.map((c) => ({ ...c, kind: 'vps' as const }))];
    this.emit();
  }

  /** Подписка на список из Electron (один раз). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const m = ipc();
    // старое приложение: одно подключение 'vps', статус — от единственного туннеля
    const legacy = () => {
      if (m?.onTunnelStatus) void m.onTunnelStatus((s) => this.patchDevStatus(s)).then((s) => this.patchDevStatus(s), () => undefined);
    };
    if (m?.onConnections) {
      // новый preload при старом main (окно перезагрузили, а main — нет): обработчика нет — как раньше
      void m.onConnections((list) => this.setVps(list)).then((list) => this.setVps(list), legacy);
    } else legacy();
  }

  private patchDevStatus(s: string): void {
    this.list = this.list.map((c) => (c.id === 'vps' ? { ...c, status: s === 'up' ? 'подключён' : s } : c));
    this.emit();
  }

  /** Статус локального supervisor'а (из main) — в подключение «Этот компьютер». */
  setLocalStatus(s: string): void {
    this.localStatus = s;
    this.list = this.list.map((c) => (c.id === LOCAL ? { ...c, status: s } : c));
    this.emit();
  }

  setLocalEnabled(on: boolean): void {
    localStorage.setItem(LOCAL_ON_KEY, on ? 'on' : 'off');
    this.list = this.list.map((c) => (c.id === LOCAL ? { ...c, enabled: on } : c));
    if (on) void (window as unknown as { perimeterIPC?: { startLocalSupervisor?: () => Promise<string> } }).perimeterIPC?.startLocalSupervisor?.().catch(() => undefined);
    this.emit();
  }

  get(id: string): Conn | undefined {
    return this.list.find((c) => c.id === id);
  }

  async add(c: ConnInput & { wsUrl?: string }): Promise<Conn> {
    const m = ipc();
    if (this.managed && m?.addConnection) {
      const r = await m.addConnection(c);
      return { ...r, kind: 'vps' };
    }
    // стенд: подключение — просто адрес supervisor'а (ws://…), без ssh
    const id = `c-${Math.random().toString(36).slice(2, 8)}`;
    const conn: Conn = { ...c, id, kind: 'vps', enabled: true, wsUrl: c.wsUrl ?? `ws://${c.host}:${c.remotePort ?? 8790}` };
    this.list = [...this.list, conn];
    saveDev(this.list);
    this.emit();
    return conn;
  }

  async update(id: string, patch: Partial<ConnInput> & { enabled?: boolean; wsUrl?: string }): Promise<void> {
    if (id === LOCAL) {
      if (patch.enabled !== undefined) this.setLocalEnabled(patch.enabled);
      return;
    }
    const m = ipc();
    if (this.managed && m?.updateConnection) {
      const { wsUrl: _w, ...rest } = patch;
      await m.updateConnection(id, rest);
      return; // список придёт через onConnections
    }
    this.list = this.list.map((c) => (c.id === id ? { ...c, ...patch } : c));
    saveDev(this.list);
    this.emit();
  }

  async remove(id: string): Promise<void> {
    if (id === LOCAL) return; // «Этот компьютер» есть всегда
    const m = ipc();
    if (this.managed && m?.removeConnection) {
      await m.removeConnection(id);
      return;
    }
    this.list = this.list.filter((c) => c.id !== id);
    saveDev(this.list);
    this.emit();
  }

  async test(c: ConnInput): Promise<{ ok: boolean; message: string }> {
    const m = ipc();
    if (m?.testConnection) return m.testConnection(c);
    return { ok: true, message: 'на стенде без Electron проверка ssh недоступна — подключение будет по адресу ws://' };
  }
}

export const connections = new ConnectionsStore();

/** Подпись среды: «Этот компьютер» или имя VPS-подключения. */
export function envLabel(id: string): string {
  return connections.get(id)?.name ?? (id === LOCAL ? 'Этот компьютер' : id === 'vps' ? 'VPS' : id);
}

/** Короткая метка для строк и карточек: «ПК» или имя VPS (обрезанное). */
export function envShort(id: string): string {
  if (id === LOCAL) return 'ПК';
  const n = envLabel(id);
  return n.length > 10 ? `${n.slice(0, 9)}…` : n;
}

export function isRemote(id: string): boolean {
  return id !== LOCAL;
}
