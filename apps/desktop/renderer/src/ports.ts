// Проброс портов подключений сюда (ssh-туннели Electron) — как Ports в VS Code Remote SSH:
// список пробросов, ручной проброс/снятие, автопроброс новых dev-серверов на VPS.
// В браузере-стенде (без Electron) проброса нет: порты открываются напрямую.
import { connections, ipc, isRemote, type Forward } from './connections';
import type { SupervisorClient } from './supervisor';
import { autoForwardPlan, portRows } from './lib/portsModel';

const AUTO_KEY = (env: string) => `perimeter:auto-forward:${env}`;
/** как часто автопроброс спрашивает слушающие порты (ответ — пара килобайт) */
export const AUTO_POLL_MS = 8000;

/** Порт самого supervisor'а на машине подключения — не пробрасываем и не показываем. */
export function ownPorts(env: string): number[] {
  const c = connections.get(env);
  return [c?.remotePort ?? 8790];
}

class PortsStore {
  forwards: Forward[] = [];
  /** проброшено автоматически (env:port) — в таблице отметка «авто» */
  readonly auto = new Set<string>();
  private listeners = new Set<() => void>();
  private started = false;
  /** снятые руками — автопроброс их больше не трогает (до перезапуска окна) */
  private ignored = new Map<string, Set<number>>();
  private busy = new Set<string>();

  /** В приложении (Electron) — да; в браузере-стенде — нет. */
  get available(): boolean {
    return typeof ipc()?.forwardPort === 'function';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const i = ipc();
    if (!i?.onForwards) return;
    void i.onForwards((l) => { this.forwards = l; this.notify(); })
      .then((l) => { this.forwards = l; this.notify(); })
      .catch(() => undefined);
  }

  private async refresh(): Promise<void> {
    const l = await ipc()?.forwards?.().catch(() => undefined);
    if (l) { this.forwards = l; this.notify(); }
  }

  private ignoredFor(env: string): Set<number> {
    let s = this.ignored.get(env);
    if (!s) { s = new Set(); this.ignored.set(env, s); }
    return s;
  }

  of(env: string): Forward[] {
    return this.forwards.filter((f) => f.connId === env);
  }

  /** Пробросить порт машины подключения сюда → локальный адрес. */
  async forward(env: string, port: number): Promise<string> {
    const i = ipc();
    if (!i?.forwardPort) throw new Error('проброс портов — только в приложении');
    const url = await i.forwardPort(port, env);
    this.ignoredFor(env).delete(port);
    await this.refresh();
    return url;
  }

  async unforward(env: string, port: number): Promise<void> {
    await ipc()?.unforwardPort?.(port, env);
    this.ignoredFor(env).add(port);
    this.auto.delete(`${env}:${port}`);
    await this.refresh();
  }

  /** Автопроброс включён у подключения (по умолчанию — да, как в VS Code). */
  autoForward(env: string): boolean {
    return localStorage.getItem(AUTO_KEY(env)) !== 'off';
  }

  setAutoForward(env: string, on: boolean): void {
    localStorage.setItem(AUTO_KEY(env), on ? 'on' : 'off');
    this.notify();
  }

  /** Один проход автопроброса: новые dev-серверы VPS — сюда. */
  async autoPass(env: string, client: SupervisorClient): Promise<void> {
    if (!this.available || !isRemote(env) || !this.autoForward(env) || client.status !== 'live' || this.busy.has(env)) return;
    this.busy.add(env);
    try {
      const list = await client.netPorts().catch(() => null);
      if (!list) return;
      const plan = autoForwardPlan(portRows(list, this.forwards, env, ownPorts(env)), this.ignoredFor(env));
      for (const port of plan) {
        try {
          await ipc()!.forwardPort!(port, env);
          this.auto.add(`${env}:${port}`);
        } catch {
          this.ignoredFor(env).add(port); // не вышло — не долбим каждый проход
        }
      }
      if (plan.length > 0) await this.refresh();
    } finally {
      this.busy.delete(env);
    }
  }
}

export const ports = new PortsStore();
