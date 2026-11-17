// Асинхронная очередь для стримингового входа SDK: send() кладёт, query() читает.

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) throw new Error('очередь ввода закрыта');
    this.items.push(item);
    const w = this.waiters.shift();
    if (w) w();
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w();
  }

  /** Итератор, живущий до close() — его отдаём в query() как prompt. */
  iterator(): AsyncIterableIterator<T> {
    const self = this;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next(): Promise<IteratorResult<T>> {
        for (;;) {
          const item = self.items.shift();
          if (item !== undefined) return { value: item, done: false };
          if (self.closed) return { value: undefined, done: true };
          await new Promise<void>((resolve) => self.waiters.push(resolve));
        }
      },
    };
  }
}
