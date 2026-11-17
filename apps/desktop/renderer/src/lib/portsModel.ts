// Порты подключения (как вкладка Ports в VS Code Remote SSH): что слушает машина, что проброшено сюда,
// какие новые dev-серверы пробросить автоматически. Чистые функции без React и IPC.
import type { PortInfo } from './panelData';
import { portSuggestions } from './browserNav';

export interface ForwardLike { connId: string; remotePort: number; localPort: number; url: string }

export interface PortRow {
  port: number;
  /** что слушает (если известно) */
  process?: string;
  host?: string;
  /** слушает сейчас (иначе — проброс остался, а сервер на той стороне уже не слушает) */
  listening: boolean;
  /** похоже на dev-сервер (node, vite, python…) — кандидат на автопроброс */
  dev: boolean;
  forward?: ForwardLike;
}

/**
 * Строки таблицы: слушающие порты машины подключения + пробросы этого подключения, которые больше не слушают.
 * Порядок: проброшенные, потом dev-серверы, потом остальные; внутри — по номеру.
 */
export function portRows(listening: PortInfo[], forwards: ForwardLike[], env: string, exclude: number[] = []): PortRow[] {
  const fw = new Map(forwards.filter((f) => f.connId === env).map((f) => [f.remotePort, f]));
  // dev-сервер: процесс известен (свой пользователь) и похож на dev-сервер; чужие и системные — нет
  const dev = new Set(portSuggestions(listening, exclude, 1000).filter((p) => p.process).map((p) => p.port));
  const rows = new Map<number, PortRow>();
  for (const p of listening) {
    if (exclude.includes(p.port)) continue;
    const cur = rows.get(p.port);
    if (cur && (cur.process || !p.process)) continue;
    rows.set(p.port, {
      port: p.port, listening: true, dev: dev.has(p.port),
      ...(p.process ? { process: p.process } : {}), ...(p.host ? { host: p.host } : {}),
      ...(fw.has(p.port) ? { forward: fw.get(p.port)! } : {}),
    });
  }
  for (const [port, f] of fw) if (!rows.has(port)) rows.set(port, { port, listening: false, dev: false, forward: f });
  const rank = (r: PortRow) => (r.forward ? 0 : r.dev ? 1 : 2);
  return [...rows.values()].sort((a, b) => rank(a) - rank(b) || a.port - b.port);
}

/** Какие порты пробросить автоматически: новые dev-серверы, ещё не проброшенные и не снятые руками. */
export function autoForwardPlan(rows: PortRow[], ignored: ReadonlySet<number>): number[] {
  return rows.filter((r) => r.listening && r.dev && !r.forward && !ignored.has(r.port)).map((r) => r.port);
}

/** Адрес для показа: «localhost:5173» вместо «http://127.0.0.1:5173». */
export function localAddress(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^127\.0\.0\.1/, 'localhost').replace(/\/$/, '');
}
