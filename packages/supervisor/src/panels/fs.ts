// Панель файлов: cmd:fs.list и cmd:fs.read строго внутри папки сессии.

import type { Dirent } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fsError, PanelError } from './errors.js';
import { resolveInRoot } from './paths.js';

/** Сколько записей папки отдаём максимум (дальше — truncated). */
export const LIST_LIMIT = 2000;
/** Сколько байт файла читаем по умолчанию. */
export const READ_DEFAULT_BYTES = 512 * 1024;
/** Окно поиска нулевого байта для детекта бинарного файла. */
export const BINARY_PROBE_BYTES = 8192;

export type FsKind = 'file' | 'dir' | 'link';

export interface FsEntry {
  name: string;
  kind: FsKind;
  size: number;
  mtimeMs: number;
}

export interface FsListResult {
  root: string;
  path: string;
  entries: FsEntry[];
  truncated: boolean;
  /** всего записей в папке (при truncated больше, чем entries.length) */
  total: number;
}

export interface FsReadResult {
  path: string;
  size: number;
  mtimeMs: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function kindOf(d: Dirent): FsKind {
  if (d.isSymbolicLink()) return 'link';
  if (d.isDirectory()) return 'dir';
  return 'file'; // fifo/сокеты/устройства — тоже «файл»: чтение их отвергнет (NOT_A_FILE)
}

/** Сортировка: папки сначала, внутри — по имени (без регистра, числа по значению). */
function compareEntries(a: { name: string; kind: FsKind }, b: { name: string; kind: FsKind }): number {
  const da = a.kind === 'dir' ? 0 : 1;
  const db = b.kind === 'dir' ? 0 : 1;
  if (da !== db) return da - db;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * Список папки без рекурсии. Скрытые файлы показываем. Большие папки — первые `limit` записей
 * (после сортировки) и truncated: true; lstat делаем только для отданных.
 * `root` — папка сессии как её знает supervisor (отдаётся в ack как есть).
 */
export async function listDir(root: string, rel: string, limit = LIST_LIMIT): Promise<FsListResult> {
  const r = await resolveInRoot(root, rel);
  let dirents: Dirent[];
  try {
    dirents = await readdir(r.abs, { withFileTypes: true });
  } catch (err) {
    return fsError(err, r.rel || '.');
  }
  const sorted = dirents.map((d) => ({ name: d.name, kind: kindOf(d) })).sort(compareEntries);
  const slice = sorted.slice(0, limit);
  const entries: FsEntry[] = new Array(slice.length);
  // lstat пачками: не открываем тысячи дескрипторов разом
  const BATCH = 64;
  for (let i = 0; i < slice.length; i += BATCH) {
    await Promise.all(slice.slice(i, i + BATCH).map(async (e, j) => {
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await lstat(path.join(r.abs, e.name));
        size = e.kind === 'dir' ? 0 : st.size;
        mtimeMs = Math.round(st.mtimeMs);
      } catch {
        // запись исчезла/недоступна между readdir и lstat (pagefile.sys, гонка) — отдаём без размеров
      }
      entries[i + j] = { name: e.name, kind: e.kind, size, mtimeMs };
    }));
  }
  return { root, path: r.rel, entries, truncated: sorted.length > limit, total: sorted.length };
}

/**
 * Чтение файла: не больше maxBytes (по умолчанию 512 КБ). Бинарный (нулевой байт в первых 8 КБ) →
 * binary: true, content пустой. Обрезанный UTF-8 не рвём посреди символа.
 */
export async function readFileIn(root: string, rel: string, maxBytes = READ_DEFAULT_BYTES): Promise<FsReadResult> {
  if (rel.trim() === '') throw new PanelError('NOT_A_FILE', 'не указан файл');
  const r = await resolveInRoot(root, rel);
  // stat до open: открытие FIFO на чтение зависло бы до появления писателя
  let st;
  try {
    st = await stat(r.abs);
  } catch (err) {
    return fsError(err, r.rel);
  }
  if (st.isDirectory()) throw new PanelError('NOT_A_FILE', `это папка, а не файл: ${r.rel}`);
  if (!st.isFile()) throw new PanelError('NOT_A_FILE', `не обычный файл: ${r.rel}`);

  // читаем на байт больше лимита: так truncated честный и для файлов с size 0 (/proc) или растущих логов
  const want = maxBytes + 1;
  let fh;
  try {
    fh = await open(r.abs, 'r');
  } catch (err) {
    return fsError(err, r.rel);
  }
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    while (n < want) {
      const size = Math.min(want - n, 256 * 1024);
      const b = Buffer.allocUnsafe(size);
      const { bytesRead } = await fh.read(b, 0, size, n);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === size ? b : b.subarray(0, bytesRead));
      n += bytesRead;
    }
  } finally {
    await fh.close();
  }
  const data = Buffer.concat(chunks, n);
  const truncated = n > maxBytes;
  const body = truncated ? data.subarray(0, maxBytes) : data;
  const binary = body.subarray(0, BINARY_PROBE_BYTES).includes(0);
  let content = '';
  if (!binary) {
    // StringDecoder.write не отдаёт неполный хвостовой символ — обрыв на лимите не даёт U+FFFD в конце
    content = truncated ? new StringDecoder('utf8').write(body) : body.toString('utf8');
  }
  return {
    path: r.rel,
    size: Math.max(st.size, n),
    mtimeMs: Math.round(st.mtimeMs),
    truncated,
    binary,
    content,
  };
}
