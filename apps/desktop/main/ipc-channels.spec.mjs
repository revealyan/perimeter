// Сторож: каждый канал, который preload вызывает (ipcRenderer.invoke), обработан в main (ipcMain.handle).
// 23.11 кнопка «Установить недостающее» падала «No handler registered for 'perimeter:server-packages'».
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const here = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const found = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

describe('каналы IPC окна ↔ main', () => {
  it('на каждый invoke из preload есть handle в main', () => {
    const invoked = found(here('./preload.mjs'), /ipcRenderer\.invoke\(\s*'([^']+)'/g);
    const handled = found(here('./index.mjs'), /ipcMain\.handle\(\s*'([^']+)'/g);
    expect(invoked.size).toBeGreaterThan(10);
    expect([...invoked].filter((c) => !handled.has(c))).toEqual([]);
  });
});
