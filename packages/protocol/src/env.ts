// «Окружение» (docs/design/environment.md §1): ответ cmd:env.probe — что стоит в среде и ресурсы. Общие типы
// supervisor'а и окна.

export type EnvFeatureId = 'git' | 'terminal' | 'browser' | 'docker';

export interface EnvTool {
  id: string;
  title: string;
  status: 'ok' | 'missing' | 'warn';
  version?: string;
  /** подробность: путь, режим, причина «warn» */
  detail?: string;
  /** на что влияет отсутствие (показывается, когда не ok) */
  affects: string;
  /** на сервере ставится установщиком — эта возможность («Возможности сервера») */
  feature?: EnvFeatureId;
  /** как поставить руками (свой компьютер; на Windows/macOS — не наши пакеты) */
  hint?: string;
}

export interface EnvProbe {
  host: string;
  user: string;
  platform: string;
  os: string;
  node: string;
  cpus: number;
  memTotal: number;
  memFree: number;
  /** свободно на диске домашней папки; null — не узнали */
  diskFree: number | null;
  diskTotal: number | null;
  /** живые процессы Claude Code и лимит (сон сессий) */
  live: { count: number; max: number | null };
  tools: EnvTool[];
}
