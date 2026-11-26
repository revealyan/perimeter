// Переезд с сервера на сервер (docs/design/migration.md): опись сервера — что хранится и сколько; секреты — только
// флагом «есть», без значений. Ответ cmd:migrate.inventory (data). Общие типы supervisor'а и окна.

/** Как аккаунт входит: от этого зависит, едет ли он (вход подписки OAuth — заново на цели). */
export type AccountKind = 'gateway' | 'api-key' | 'subscription-token' | 'subscription-login' | 'none';

export interface InventoryAccount {
  /** внешнее имя (как в окне) */
  name: string;
  kind: AccountKind;
  /** адрес шлюза (без ключа) — для сверки «тот же аккаунт» на цели */
  baseUrl?: string;
  /** в env есть ключ/токен (значение не отдаём) */
  hasSecret: boolean;
  /** папка Claude Code аккаунта — своя (accounts/<slug>) или базовая ~/.claude */
  ownConfigDir: boolean;
  settings: boolean;
  claudeMd: boolean;
  /** MCP-серверы аккаунта (mcpServers в .claude.json) — имена */
  mcpServers: string[];
  /** свои skills/commands/agents (не симлинки на общее) — сколько */
  skills: number;
  commands: number;
  agents: number;
  plugins: number;
  /** транскрипты сессий в папке аккаунта */
  transcripts: { files: number; bytes: number };
}

export interface InventoryGit {
  remote: string | null;
  branch: string;
  head: string | null;
  /** изменённые отслеживаемые файлы */
  dirty: number;
  untracked: number;
  /** коммитов не на remote у текущей ветки; null — нет upstream */
  unpushed: number | null;
  /** локальные ветки без upstream или впереди него (поедут бандлом) */
  localBranches: string[];
  stash: number;
  /** игнорируемые не-тяжёлые (.env и т. п.) — первые 20 */
  ignored: string[];
}

export interface InventoryProject {
  name: string;
  path: string;
  exists: boolean;
  /** без тяжёлого пересобираемого (node_modules, .venv, dist…) */
  bytes: number;
  files: number;
  /** найденные тяжёлые папки (относительно проекта) — не поедут */
  heavy: string[];
  /** обход оборван лимитом — размер неполный */
  truncated: boolean;
  git: InventoryGit | null;
  sessions: number;
}

export interface Inventory {
  server: { host: string; user: string; home: string; platform: string; version: string; storageRoot: string };
  accounts: InventoryAccount[];
  /** общие MCP-серверы (mcp-shared.json) — имена */
  mcpShared: string[];
  projects: InventoryProject[];
  sessions: {
    total: number;
    archived: number;
    /** без проекта (cwd вне проектов) */
    withoutProject: number;
    /** транскрипта нет на диске — переносить нечего */
    noTranscript: number;
    /** по внешнему имени аккаунта */
    byAccount: Record<string, number>;
  };
  thinking: { bytes: number };
  browserProfile: { bytes: number; exists: boolean };
  git: { name: string | null; email: string | null };
  /** ключ, которым сервер ходит в GitHub (открытая часть — не нужна; только опознать) */
  github: { keyComment: string | null; fingerprint: string | null };
  /** вне Perimeter: показываем, не переносим */
  extras: { crontab: boolean; userUnits: string[]; dockerData: boolean };
}
