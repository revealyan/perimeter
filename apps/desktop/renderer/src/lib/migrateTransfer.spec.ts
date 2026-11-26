import { describe, expect, it } from 'vitest';
import { archiveName, b64ToBytes, bytesToB64, CHUNK, download, relay, upload } from './migrateTransfer';

/** Источник с пакетом из байтов и цель, принимающая куски строго по порядку — как supervisor. */
function sides(size: number) {
  const data = new Uint8Array(size).map((_, i) => (i * 7) % 251);
  const src = { migrateRead: async (_p: string, off: number, len: number) => { const s = data.subarray(off, off + len); return { data: bytesToB64(s), eof: off + s.length >= size, bytes: size }; } };
  const got: number[] = [];
  let id: string | undefined;
  const dst = { migrateUpload: async (pkg: string | undefined, off: number, b64: string) => {
    if (off !== got.length) throw new Error('не по порядку');
    if (pkg === undefined) id = 'p1'; else expect(pkg).toBe(id);
    for (const b of b64ToBytes(b64)) got.push(b);
    return { pkg: id!, bytes: got.length };
  } };
  return { data, src, dst, got };
}

describe('перегон пакета', () => {
  it('сразу на сервер: все куски по порядку, байт в байт; прогресс до конца', async () => {
    const s = sides(CHUNK * 2 + 123);
    const prog: number[] = [];
    expect(await relay(s.src, 'x', s.dst, (d) => prog.push(d))).toBe('p1');
    expect(Buffer.from(s.got).equals(Buffer.from(s.data))).toBe(true);
    expect(prog.at(-1)).toBe(CHUNK * 2 + 123);
  });

  it('скачать архив и загрузить его на другой сервер — тот же пакет', async () => {
    const s = sides(CHUNK + 5);
    const blob = await download(s.src, 'x');
    expect(blob.size).toBe(CHUNK + 5);
    const t = sides(0);
    expect(await upload(t.dst, blob)).toBe('p1');
    expect(Buffer.from(t.got).equals(Buffer.from(s.data))).toBe(true);
  });

  it('имя архива — хост и время, без лишних символов', () => {
    expect(archiveName('vps-10074 old', new Date('2026-11-26T15:04:00Z'))).toBe('perimeter-migration-vps-10074_old-2026-11-26-15-04.tgz');
  });
});
