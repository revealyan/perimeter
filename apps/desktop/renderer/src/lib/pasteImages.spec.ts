import { describe, expect, it } from 'vitest';
import { hasImageData, splitImageFiles } from './pasteImages';

describe('вложения-картинки', () => {
  it('пустые файлы не берём (отдельный счёт), не-картинки пропускаем', () => {
    expect(splitImageFiles([{ type: 'image/png', size: 0 }, { type: 'image/png', size: 10 }, { type: 'text/plain', size: 5 }])).toEqual({ ok: [1], empty: 1 });
  });
  it('data URL без данных — не картинка', () => {
    expect(hasImageData('data:image/png;base64,')).toBe(false);
    expect(hasImageData('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(hasImageData('')).toBe(false);
  });
});
