// IPC-мост из main (preload) — подключения VPS и их туннели, проброс портов, уведомления, автозапуск
export {};

declare global {
  /** Подключение VPS — то, что вводят в форме (секретов нет: только путь к ключу). */
  interface PerimeterConnInput {
    name: string;
    host: string;
    /** порт ssh, по умолчанию 22 */
    port?: number;
    user: string;
    /** путь к приватному ключу на этой машине; нет — ~/.ssh/id_ed25519|id_rsa|id_ecdsa и ssh-agent */
    privateKey?: string;
    /** порт supervisor'а на VPS, по умолчанию 8790 */
    remotePort?: number;
    /** под кем работает supervisor при входе под root (установщик, АДР 004); пусто — из юнита службы */
    serviceUser?: string;
  }
  /** Подключение VPS с состоянием туннеля. */
  interface PerimeterConnInfo extends PerimeterConnInput {
    /** 'vps' — мигрированное из tunnel.json, новые — 'c-xxxxxx' */
    id: string;
    enabled: boolean;
    /** локальный конец туннеля: 8790 у 'vps', у новых — свободный с 8800 */
    localPort: number;
    /** куда подключаться рендереру: ws://127.0.0.1:<localPort> */
    wsUrl: string;
    /** 'подключён' | 'подключаюсь…' | 'нет связи: …' | 'выключен' */
    status: string;
  }
  /** Проброшенный порт VPS. */
  interface PerimeterForward {
    connId: string;
    remotePort: number;
    localPort: number;
    /** http://127.0.0.1:<localPort> */
    url: string;
  }

  interface Window {
    perimeterIPC?: {
      onTunnelStatus(cb: (status: string) => void): Promise<string>;
      notify(title: string, body: string): void;
      autoLaunch(): Promise<boolean>;
      setAutoLaunch(enabled: boolean): Promise<boolean>;
      localSupervisor(): Promise<string>;
      startLocalSupervisor(): Promise<string>;
      stopLocalSupervisor(): Promise<string>;
      /** статус локального supervisor'а (запускается…/запущен/упал…); резолвится текущим */
      onLocalSupervisorStatus(cb: (status: string) => void): Promise<string>;
      /** нативный выбор папки на этой машине; null — отменили */
      pickFolder(): Promise<string | null>;
      pathExists(p: string): Promise<boolean>;
      /**
       * Проброс порта VPS через ssh-туннель подключения (без connId — первое подключение) →
       * 'http://127.0.0.1:<local>'; локальный порт — тот же, если свободен; повторно — тот же адрес.
       */
      forwardPort?(remotePort: number, connId?: string): Promise<string>;
      /** снять проброс; false — его не было */
      unforwardPort?(remotePort: number, connId?: string): Promise<boolean>;
      /** текущие пробросы всех подключений */
      forwards?(): Promise<PerimeterForward[]>;
      /** список пробросов при каждом изменении; резолвится текущим */
      onForwards?(cb: (list: PerimeterForward[]) => void): Promise<PerimeterForward[]>;
      /** хост/пользователь/порт ssh первого подключения; null — подключений нет */
      tunnelInfo?(): Promise<{ host: string; user: string; port: number } | null>;
      /** подключения VPS */
      connections?(): Promise<PerimeterConnInfo[]>;
      /** список при любом изменении (в т. ч. статуса туннеля); резолвится текущим */
      onConnections?(cb: (list: PerimeterConnInfo[]) => void): Promise<PerimeterConnInfo[]>;
      /** добавить подключение (сразу включено, туннель поднимается) */
      addConnection?(c: PerimeterConnInput): Promise<PerimeterConnInfo>;
      /** правка; enabled: false — туннель гасится, true — поднимается */
      updateConnection?(id: string, patch: Partial<PerimeterConnInput> & { enabled?: boolean }): Promise<PerimeterConnInfo>;
      /** удалить подключение (туннель и его пробросы гасятся) */
      removeConnection?(id: string): Promise<boolean>;
      /** пробное ssh-подключение и проверка, что на VPS слушает supervisor; ничего не сохраняет */
      testConnection?(c: PerimeterConnInput): Promise<{ ok: boolean; message: string }>;
      /** вход паролем один раз → ключ приложения в authorized_keys; путь ключа — для подключения */
      setupKey?(c: { host: string; port?: number; user: string; password: string }): Promise<{ ok: boolean; message: string; privateKeyPath?: string }>;
      /** нативный выбор файла ключа ssh (открывается в ~/.ssh); null — отменили */
      pickKeyFile?(): Promise<string | null>;
      /** supervisor на сервере (АДР 004): что стоит, версия приложения, что предлагать */
      serverStatus?(connId: string): Promise<import('./lib/serverInstallModel').ServerStatus>;
      /** поставить/обновить supervisor до версии приложения; serviceUser — при входе под root (сохраняется в подключении) */
      serverInstall?(connId: string, serviceUser?: string): Promise<{ ok: boolean; message: string; version?: string }>;
      serverPackages?(connId: string, pkgs: string[]): Promise<{ ok: boolean; message: string }>;
      serverFeature?(connId: string, name: 'git' | 'terminal' | 'browser' | 'docker'): Promise<{ ok: boolean; message: string }>;
      /** вернуть прошлую версию supervisor'а на сервере */
      serverRollback?(connId: string): Promise<{ ok: boolean; message: string }>;
      /** ход установки/отката строками; возвращает отписку */
      onServerLog?(cb: (m: { connId: string; line: string }) => void): () => void;
      /** открыть vscode:// или http(s):// во внешнем приложении ОС */
      openExternal?(url: string): Promise<boolean>;
      /** «не засыпать»: держать систему бодрой, пока включено (гасится при выключении) */
      setKeepAwake?(enabled: boolean): Promise<boolean>;
    };
  }
}
