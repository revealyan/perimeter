// Переезд: перегон пакета кусками — источник → окно → цель (сразу на сервер), источник → файл (скачать архив),
// файл → цель (загрузить архив). Кусок 1 МБ: туннель и WS не любят сотни мегабайт одним кадром.

export const CHUNK = 1024 * 1024;

export interface ReadSide { migrateRead(pkg: string, offset: number, length: number): Promise<{ data: string; eof: boolean; bytes: number }> }
export interface WriteSide { migrateUpload(pkg: string | undefined, offset: number, data: string): Promise<{ pkg: string; bytes: number }> }

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Сразу на сервер: кусок с источника → тот же кусок цели. Возвращает id пакета на цели. */
export async function relay(src: ReadSide, srcPkg: string, dst: WriteSide, onProgress?: (done: number, total: number) => void): Promise<string> {
  let off = 0;
  let pkg: string | undefined;
  for (;;) {
    const c = await src.migrateRead(srcPkg, off, CHUNK);
    const up = await dst.migrateUpload(pkg, off, c.data);
    pkg = up.pkg;
    off = up.bytes;
    onProgress?.(off, c.bytes);
    if (c.eof) return pkg;
  }
}

/** Скачать архив: куски источника → части файла (Blob не склеивает их в одну строку памяти). */
export async function download(src: ReadSide, pkg: string, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const parts: BlobPart[] = [];
  let off = 0;
  for (;;) {
    const c = await src.migrateRead(pkg, off, CHUNK);
    const bytes = b64ToBytes(c.data);
    parts.push(bytes);
    off += bytes.length;
    onProgress?.(off, c.bytes);
    if (c.eof) break;
  }
  return new Blob(parts, { type: 'application/gzip' });
}

/** Загрузить архив на сервер кусками. */
export async function upload(dst: WriteSide, file: Blob, onProgress?: (done: number, total: number) => void): Promise<string> {
  let pkg: string | undefined;
  for (let off = 0; off < file.size || (off === 0 && pkg === undefined); off += CHUNK) {
    const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
    const up = await dst.migrateUpload(pkg, off, bytesToB64(bytes));
    pkg = up.pkg;
    onProgress?.(up.bytes, file.size);
    if (file.size === 0) break;
  }
  return pkg!;
}

/** sha256 файла (сверка: архив дошёл до сервера целым). */
export async function sha256Hex(file: Blob): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Имя файла архива: perimeter-migration-<хост>-<дата>.tgz */
export function archiveName(host: string, at = new Date()): string {
  const d = at.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `perimeter-migration-${host.replace(/[^A-Za-z0-9.-]+/g, '_')}-${d}.tgz`;
}
