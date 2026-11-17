// Конфайнмент путей панелей: всё, что приходит из кадра, — относительно корня (cwd сессии).
// Два слоя: (1) синтаксический — запрет абсолютных путей, `..`, дисков/потоков Windows;
// (2) фактический — realpath цели обязан лежать внутри realpath корня (симлинк наружу → OUTSIDE_ROOT).

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fsError, PanelError } from './errors.js';

export interface Resolved {
  /** настоящий абсолютный путь цели (после realpath) */
  abs: string;
  /** нормализованный относительный путь как в запросе ('' — корень), разделитель '/' */
  rel: string;
  /** настоящий абсолютный путь корня */
  realRoot: string;
}

const outside = (rel: string) => new PanelError('OUTSIDE_ROOT', `путь вне папки сессии: ${rel}`);

/**
 * Разбор относительного пути из кадра в сегменты. Подозрительное — OUTSIDE_ROOT:
 * абсолютные (`/x`, `\x`, `C:\x`, `C:x`, `\\srv\share`), любой сегмент `..`,
 * на Windows — `:` в сегменте (диск-относительные пути, NTFS-потоки) и сегменты из одних точек/пробелов
 * (Win32 обрезает хвостовые точки/пробелы — `.. ` мог бы стать `..`).
 */
export function splitRelPath(rel: string, platform: NodeJS.Platform = process.platform): string[] {
  if (rel.includes('\0')) throw new PanelError('BAD_PATH', 'нулевой байт в пути');
  const win = platform === 'win32';
  if (rel.startsWith('/') || path.posix.isAbsolute(rel)) throw outside(rel);
  if (win && (rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel) || path.win32.isAbsolute(rel))) throw outside(rel);
  const parts = rel.split(win ? /[\\/]+/ : /\/+/).filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw outside(rel);
    if (win && (p.includes(':') || /^[. ]+$/.test(p))) throw outside(rel);
  }
  return parts;
}

/** Лежит ли p внутри root (оба — уже настоящие абсолютные пути). */
export function isInside(root: string, p: string): boolean {
  const r = path.relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
}

/** Настоящий путь корня; несуществующая папка сессии — ROOT_NOT_FOUND. */
export async function realRootOf(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new PanelError('ROOT_NOT_FOUND', `папки сессии нет на диске: ${root}`);
    }
    return fsError(err, root);
  }
}

/** Разрешить относительный путь внутри корня (цель обязана существовать). */
export async function resolveInRoot(root: string, rel: string): Promise<Resolved> {
  const parts = splitRelPath(rel);
  const realRoot = await realRootOf(root);
  const normalized = parts.join('/');
  let abs: string;
  try {
    abs = await realpath(path.join(realRoot, ...parts));
  } catch (err) {
    return fsError(err, normalized || '.');
  }
  if (!isInside(realRoot, abs)) throw outside(normalized);
  return { abs, rel: normalized, realRoot };
}
