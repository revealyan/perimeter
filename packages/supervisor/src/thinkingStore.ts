// Текст размышлений (thinking) моделей — свой журнал supervisor'а.
//
// Claude Code пишет thinking-блоки Anthropic-моделей в транскрипт БЕЗ текста: `{"thinking":"","signature":"…"}`
// (замечено на 2.1.3xx, 67 из 67 блоков). Живой поток SDK текст несёт, а лента после переподключения/ресинка
// собирается из транскрипта — и размышления пропадали. Подпись (signature) одна и та же в потоке и в транскрипте,
// поэтому ключ — хэш подписи: переживает respawn/resume (новый id сессии claude), форк и смену аккаунта
// (транскрипт копируется с теми же подписями) без привязки к сессии.
//
// Формат файла: строка на блок — `<32 hex sha256(signature)> <JSON-строка текста>\n`, только дописывание.
// В памяти — индекс хэш → (смещение, длина); текст читается с диска по запросу.
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const HASH_LEN = 32;

export const signatureKey = (signature: string): string => createHash('sha256').update(signature).digest('hex').slice(0, HASH_LEN);

export class ThinkingStore {
  private index: Map<string, { pos: number; len: number }> | null = null;
  private size = 0;

  constructor(private readonly file: string) {}

  /** Запомнить текст блока (повтор той же подписи — no-op). Ошибка записи не роняет поток сессии. */
  put(signature: string, text: string): void {
    if (!signature || !text) return;
    const idx = this.load();
    const h = signatureKey(signature);
    if (idx.has(h)) return;
    const line = Buffer.from(`${h} ${JSON.stringify(text)}\n`, 'utf8');
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      return;
    }
    idx.set(h, { pos: this.size, len: line.length - 1 });
    this.size += line.length;
  }

  /** Текст по подписи; нет — undefined. */
  get(signature: string): string | undefined {
    if (!signature) return undefined;
    const at = this.load().get(signatureKey(signature));
    if (!at) return undefined;
    let fd: number | null = null;
    try {
      fd = openSync(this.file, 'r');
      const buf = Buffer.alloc(at.len - HASH_LEN - 1);
      readSync(fd, buf, 0, buf.length, at.pos + HASH_LEN + 1);
      const v: unknown = JSON.parse(buf.toString('utf8'));
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  /** Индекс — лениво, одним проходом по файлу; битая строка (обрыв записи) пропускается. */
  private load(): Map<string, { pos: number; len: number }> {
    if (this.index) return this.index;
    const idx = new Map<string, { pos: number; len: number }>();
    this.index = idx;
    if (!existsSync(this.file)) return idx;
    let buf: Buffer;
    try {
      buf = readFileSync(this.file);
    } catch {
      return idx;
    }
    let pos = 0;
    while (pos < buf.length) {
      let nl = buf.indexOf(0x0a, pos);
      if (nl === -1) nl = buf.length; // хвост без перевода строки — запись оборвалась
      const len = nl - pos;
      if (len > HASH_LEN + 1 && buf[pos + HASH_LEN] === 0x20 && nl < buf.length) {
        idx.set(buf.toString('latin1', pos, pos + HASH_LEN), { pos, len });
      }
      pos = nl + 1;
    }
    // дописываем всегда в конец файла (оборванный хвост остаётся мусором — его строка не в индексе)
    try { this.size = statSync(this.file).size; } catch { this.size = buf.length; }
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
      try { appendFileSync(this.file, '\n'); this.size += 1; } catch { /* не дописалось — put() тоже не сможет писать */ }
    }
    return idx;
  }
}
