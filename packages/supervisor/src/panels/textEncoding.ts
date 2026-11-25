// Кодировка текстового файла для просмотра в «Файлах»: BOM (UTF-8/UTF-16), иначе UTF-8, если он корректен; не UTF-8 —
// однобайтная: кириллическая Windows-1251 (файлы с Windows, 1С, старые проекты) или западная Windows-1252 — по тому,
// на что похожи старшие байты. Владелец 2026-11-25: «кириллица не читается cp1251 которая».

export type TextEncodingName = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1251' | 'windows-1252';

/** Байты кириллических букв в Windows-1251: А–я (0xC0–0xFF), Ё/ё (0xA8/0xB8). */
const isCp1251Letter = (b: number) => b >= 0xc0 || b === 0xa8 || b === 0xb8;

/**
 * Текст из байтов; binary — нулевой байт в начале (кроме UTF-16 с BOM). truncated — хвост мог оборваться посреди
 * многобайтного символа: для проверки UTF-8 отрезаем до 3 последних байт неполной последовательности.
 */
export function decodeText(buf: Buffer, truncated: boolean, probeBytes = 8192): { binary: true } | { binary: false; content: string; encoding: TextEncodingName } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { binary: false, content: new TextDecoder('utf-16le').decode(evenLength(buf.subarray(2))), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { binary: false, content: new TextDecoder('utf-16be').decode(evenLength(buf.subarray(2))), encoding: 'utf-16be' };
  if (buf.subarray(0, probeBytes).includes(0)) return { binary: true };
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.subarray(3) : buf;
  const usable = truncated ? body.subarray(0, body.length - incompleteUtf8Tail(body)) : body;
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(usable);
    return { binary: false, content, encoding: bom ? 'utf-8-bom' : 'utf-8' };
  } catch {
    // не UTF-8: однобайтная — кириллица или западная. Диапазоны букв пересекаются (é/ü в 1252 — там же, где а–я в
    // 1251), поэтому смотрим на соседство: в русском тексте старшие байты идут подряд (целые слова), в западном —
    // одиночные буквы среди латиницы
    const sample = body.subarray(0, 64 * 1024);
    let high = 0;
    let cyr = 0;
    let paired = 0;
    for (let i = 0; i < sample.length; i++) {
      const b = sample[i]!;
      if (b < 0x80) continue;
      high++;
      if (isCp1251Letter(b)) cyr++;
      if ((i > 0 && sample[i - 1]! >= 0x80) || (i + 1 < sample.length && sample[i + 1]! >= 0x80)) paired++;
    }
    const enc: TextEncodingName = high > 0 && cyr / high >= 0.6 && paired / high >= 0.5 ? 'windows-1251' : 'windows-1252';
    return { binary: false, content: new TextDecoder(enc).decode(body), encoding: enc };
  }
}

/** Сколько байт в конце — начатая, но не законченная последовательность UTF-8 (0–3). */
function incompleteUtf8Tail(b: Buffer): number {
  for (let i = 1; i <= Math.min(3, b.length); i++) {
    const c = b[b.length - i]!;
    if ((c & 0xc0) === 0x80) continue; // продолжение — смотрим дальше назад
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return need > i ? i : 0;
  }
  return 0;
}

const evenLength = (b: Buffer) => (b.length % 2 === 0 ? b : b.subarray(0, b.length - 1));
