// Боковые панели supervisor'а: файлы, git, порты, терминал.
// Корень путей — cwd сессии из шапки кадра; ошибки — PanelError с кодом протокола.

import type { Cmd } from '@perimeter/protocol';
import { PanelError } from './errors.js';
import { listDir, readFileIn } from './fs.js';
import { gitStatus } from './git.js';
import { listPorts, type ListenPort } from './ports.js';
import { TerminalManager, type TermSubscriber } from './terminal.js';

export { PanelError } from './errors.js';
export * from './paths.js';
export * from './fs.js';
export * from './git.js';
export * from './ports.js';
export * from './terminal.js';

/** Команды, которые обслуживает панельный модуль. */
export const PANEL_CMD_TYPES = [
  'cmd:fs.list', 'cmd:fs.read', 'cmd:git.status', 'cmd:net.ports',
  'cmd:term.open', 'cmd:term.attach', 'cmd:term.list', 'cmd:term.input', 'cmd:term.resize', 'cmd:term.close',
] as const;
export type PanelCmd = Extract<Cmd, { type: (typeof PANEL_CMD_TYPES)[number] }>;

export function isPanelCmd(f: Cmd): f is PanelCmd {
  return (PANEL_CMD_TYPES as readonly string[]).includes(f.type);
}

export interface PanelServiceOptions {
  /** cwd сессии; undefined у сессии без cwd; null — сессии нет */
  sessionCwd: (sessionId: string) => string | undefined | null;
  terminals?: TerminalManager;
  /** источник портов (подменяется в тестах) */
  ports?: () => Promise<ListenPort[]>;
}

export class PanelService {
  readonly terminals: TerminalManager;
  private readonly sessionCwd: PanelServiceOptions['sessionCwd'];
  private readonly ports: () => Promise<ListenPort[]>;

  constructor(opts: PanelServiceOptions) {
    this.sessionCwd = opts.sessionCwd;
    this.terminals = opts.terminals ?? new TerminalManager();
    this.ports = opts.ports ?? (() => listPorts());
  }

  /** Корень панели: cwd сессии из шапки кадра. */
  rootOf(sessionId: string | undefined): string {
    const sid = sessionId ?? '';
    const cwd = this.sessionCwd(sid);
    if (cwd === null) throw new PanelError('SESSION_NOT_FOUND', `нет сессии ${sid}`);
    if (cwd === undefined || cwd === '') throw new PanelError('NO_CWD', 'у сессии нет папки (cwd)');
    return cwd;
  }

  /** Выполнить команду панели → данные ack. Ошибки — PanelError (код протокола) или исключение (INTERNAL). */
  async handle(f: PanelCmd, subscriber: TermSubscriber): Promise<unknown> {
    switch (f.type) {
      case 'cmd:fs.list':
        return listDir(this.rootOf(f.sessionId), f.path);
      case 'cmd:fs.read':
        return readFileIn(this.rootOf(f.sessionId), f.path, f.maxBytes);
      case 'cmd:git.status':
        return gitStatus(this.rootOf(f.sessionId));
      case 'cmd:net.ports':
        // порты — свойство машины, а не сессии: шапка не обязательна
        return { ports: await this.ports() };
      case 'cmd:term.open': {
        const root = this.rootOf(f.sessionId);
        return this.terminals.open({
          sessionId: f.sessionId!, root, cols: f.cols, rows: f.rows, subscriber,
          ...(f.cwd !== undefined ? { cwd: f.cwd } : {}),
        });
      }
      case 'cmd:term.attach':
        return this.terminals.attach(f.termId, subscriber, f.sessionId);
      case 'cmd:term.list':
        this.rootOrMissing(f.sessionId);
        return { terms: this.terminals.list(f.sessionId ?? '') };
      case 'cmd:term.input':
        this.terminals.input(f.termId, f.data, f.sessionId);
        return undefined;
      case 'cmd:term.resize':
        this.terminals.resize(f.termId, f.cols, f.rows, f.sessionId);
        return undefined;
      case 'cmd:term.close':
        this.terminals.close(f.termId, f.sessionId);
        return undefined;
    }
  }

  /** Для list: сессия обязана существовать, а cwd не нужен (терминалов без cwd не бывает — будет пусто). */
  private rootOrMissing(sessionId: string | undefined): void {
    if (this.sessionCwd(sessionId ?? '') === null) throw new PanelError('SESSION_NOT_FOUND', `нет сессии ${sessionId ?? ''}`);
  }

  /** Остановка supervisor'а. */
  stop(): Promise<void> {
    return this.terminals.stopAll();
  }
}
