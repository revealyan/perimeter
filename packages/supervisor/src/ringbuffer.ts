// Ринг-буфер событий сессии для догона после обрыва (p0-design §3).
// Инвариант 1: seq монотонный без дыр; если запрошено глубже буфера — null → RESYNC.

export class RingBuffer<T extends { seq: number }> {
  private items: T[] = [];

  constructor(readonly capacity = 2000) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  get oldestSeq(): number | null {
    return this.items[0]?.seq ?? null;
  }

  get lastSeq(): number | null {
    return this.items.length ? (this.items[this.items.length - 1]!.seq) : null;
  }

  /** События с seq > lastSeq; null = дыра глубже буфера (нужен ресинк из транскрипта). */
  since(lastSeq: number): T[] | null {
    if (this.items.length === 0) return [];
    const oldest = this.oldestSeq!;
    if (lastSeq + 1 < oldest) return null;
    return this.items.filter((i) => i.seq > lastSeq);
  }
}
