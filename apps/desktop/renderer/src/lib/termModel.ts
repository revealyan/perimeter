// Вкладка «Терминал»: подписи под-вкладок, нарезка ввода под лимит кадра, размер в границах схемы.
// Режим pipe (без PTY) особой обработки на клиенте не требует: эхо и правку строки эмулирует supervisor.
// Чистые функции.
import { baseName, toAbs } from './fileTree';

/** Папка терминала: cwd в ack — относительно корня сессии ('' — сам корень); корень известен — путь полный. */
export function termDir(cwd: string, root: string | null): string {
  if (!root) return cwd ? `./${cwd}` : '';
  return cwd ? toAbs(root, cwd) : root;
}

/** «bash · /opt/perimeter»: имя оболочки без пути и .exe + папка. */
export function termTitle(t: { shell: string; cwd: string }, root: string | null = null): string {
  const sh = baseName(t.shell || 'shell').replace(/\.exe$/i, '') || 'shell';
  const dir = termDir(t.cwd, root);
  return dir ? `${sh} · ${dir}` : sh;
}

/** Ввод режем на куски ≤ max (лимит кадра cmd:term.input — 65 536), не разрывая суррогатные пары. */
export function chunkInput(data: string, max = 16_384): string[] {
  if (data.length <= max) return data ? [data] : [];
  const out: string[] = [];
  let k = 0;
  while (k < data.length) {
    let end = Math.min(k + max, data.length);
    const c = data.charCodeAt(end - 1);
    if (end < data.length && c >= 0xd800 && c <= 0xdbff) end--; // старшая половина пары — не отрываем
    out.push(data.slice(k, end));
    k = end;
  }
  return out;
}

/** Размер терминала в пределах схемы кадра (cols 1…1000, rows 1…500). */
export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.round(cols) : 80;
  const r = Number.isFinite(rows) ? Math.round(rows) : 24;
  return { cols: Math.min(1000, Math.max(1, c)), rows: Math.min(500, Math.max(1, r)) };
}
