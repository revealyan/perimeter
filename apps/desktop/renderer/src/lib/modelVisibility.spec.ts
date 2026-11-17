import { describe, expect, it } from 'vitest';
import { splitVisible } from './modelVisibility';

const models = [{ id: 'sonnet' }, { id: 'opus' }, { id: 'haiku' }];
const ids = (l: Array<{ id: string }>) => l.map((m) => m.id);

describe('видимость моделей', () => {
  it('скрытые уходят в «Другие модели», порядок сохраняется', () => {
    const r = splitVisible(models, new Set(['opus']));
    expect(ids(r.shown)).toEqual(['sonnet', 'haiku']);
    expect(ids(r.other)).toEqual(['opus']);
  });

  it('текущая модель сессии остаётся на виду, даже если скрыта', () => {
    const r = splitVisible(models, new Set(['opus', 'haiku']), 'haiku');
    expect(ids(r.shown)).toEqual(['sonnet', 'haiku']);
    expect(ids(r.other)).toEqual(['opus']);
  });

  it('скрыто всё — первая модель остаётся в списке, чтобы он не опустел', () => {
    const r = splitVisible(models, new Set(['sonnet', 'opus', 'haiku']));
    expect(ids(r.shown)).toEqual(['sonnet']);
    expect(ids(r.other)).toEqual(['opus', 'haiku']);
  });

  it('ничего не скрыто — «Других» нет', () => {
    expect(splitVisible(models, new Set()).other).toEqual([]);
  });
});
