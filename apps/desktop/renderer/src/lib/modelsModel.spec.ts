import { describe, expect, it } from 'vitest';
import { addCustomModel, addManualModel, baseModelId, ctxLabel, customLabel, effectiveEffort, effortRange, effortsFor, findModel, isLong, modelChoices, ultracodeAllowed, type ProfileLike } from './modelsModel';

const yan: ProfileLike = {
  name: 'yan', model: 'sonnet', modelsSource: 'auto', defaultEffort: 'high',
  models: [
    { id: 'sonnet', label: 'Sonnet 5.5', efforts: ['max', 'low', 'medium', 'high', 'xhigh'] },
    { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'haiku', label: 'Haiku 5.5', efforts: [] },
  ],
};
const zai: ProfileLike = { name: 'zai', model: 'glm-5.3[1m]', modelsSource: 'manual', ultracode: false, models: [{ id: 'glm-5.3[1m]', efforts: [] }] };

describe('список моделей', () => {
  it('у аккаунта есть список — он и показывается', () => {
    expect(modelChoices(yan).map((m) => m.id)).toEqual(['sonnet', 'opus', 'haiku']);
  });
  it('списка нет (старый supervisor) — подсказки без сведений об усилии', () => {
    expect(modelChoices({ name: 'zai' }).map((m) => m.id)).toContain('glm-5.3');
    const def = modelChoices({ name: 'x', model: 'opus' });
    expect(def[0]).toEqual({ id: 'opus' });
    expect(new Set(def.map((m) => m.id)).size).toBe(def.length);
  });
  it('полный id сессии находит псевдоним в списке, но не путает модели шлюза', () => {
    expect(findModel(yan, 'claude-sonnet-5-5')?.id).toBe('sonnet');
    expect(findModel(yan, 'OPUS')?.id).toBe('opus');
    expect(findModel(zai, 'glm-5.3')).toBeUndefined();
  });
});

describe('усилие', () => {
  it('уровни по порядку; у модели без усилия и у шлюза — пусто', () => {
    expect(effortsFor(yan, 'sonnet')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor(yan, 'haiku')).toEqual([]);
    expect(effortsFor(zai, 'glm-5.3[1m]')).toEqual([]);
    expect(effortsFor(undefined, 'sonnet')).toEqual([]);
  });
  it('модель сессии не задана — берётся модель аккаунта по умолчанию', () => {
    expect(effortsFor(yan, undefined)).toHaveLength(5);
  });
  it('действующее усилие: сессия → аккаунт → решает модель; недоступный уровень не показываем', () => {
    const all = effortsFor(yan, 'sonnet');
    expect(effectiveEffort('low', yan, all)).toBe('low');
    expect(effectiveEffort(undefined, yan, all)).toBe('high');
    expect(effectiveEffort(undefined, { name: 'n' }, all)).toBeNull();
    expect(effectiveEffort('max', yan, [])).toBeNull();
  });
  it('диапазон коротко', () => {
    expect(effortRange(['max', 'low'])).toBe('низкое → максимальное');
    expect(effortRange(['high'])).toBe('высокое');
    expect(effortRange([])).toBe('без усилия');
    expect(effortRange(undefined)).toBe('без усилия');
  });
});

describe('ultracode и ручной список', () => {
  it('разрешён по умолчанию, запрет — только явный', () => {
    expect(ultracodeAllowed(yan)).toBe(true);
    expect(ultracodeAllowed(undefined)).toBe(true);
    expect(ultracodeAllowed(zai)).toBe(false);
  });
  it('добавление модели: без пустых, пробелов и дублей', () => {
    expect(addManualModel(zai.models!, '  glm-4.7-air ')?.map((m) => m.id)).toEqual(['glm-5.3[1m]', 'glm-4.7-air']);
    expect(addManualModel(zai.models!, 'GLM-5.3[1M]')).toBeNull();
    expect(addManualModel(zai.models!, '')).toBeNull();
    expect(addManualModel(zai.models!, 'glm 5')).toBeNull();
  });
});

describe('контекст 1M', () => {
  const zai: ProfileLike = { name: 'zai', long: ['glm-5.3'], models: [{ id: 'glm-5.3', efforts: [] }, { id: 'glm-4.7-air', efforts: [] }] };
  it('сессия с [1m] находит модель списка; включено ли 1M — по настройке или по id', () => {
    expect(baseModelId('glm-5.3[1m]')).toBe('glm-5.3');
    expect(findModel(zai, 'glm-5.3[1m]')?.id).toBe('glm-5.3');
    expect(isLong(zai, 'glm-5.3')).toBe(true);
    expect(isLong(zai, 'glm-4.7-air')).toBe(false);
    expect(isLong({ name: 'x' }, 'glm-5.3[1m]')).toBe(true);
  });
  it('окно контекста коротко', () => {
    expect(ctxLabel(1_000_000)).toBe('1M');
    expect(ctxLabel(200_000)).toBe('200K');
    expect(ctxLabel(undefined)).toBe('');
  });
});

describe('свои модели: база + окно контекста', () => {
  const p: ProfileLike = {
    name: 'claude',
    models: [{ id: 'claude-opus-5-5', efforts: ['low', 'max'] }, { id: 'claude-haiku-5-5', efforts: [] }],
    custom: [{ id: 'claude-opus-5-5@300k', base: 'claude-opus-5-5', ctx: 300_000 }, { id: 'glm-5.3@400k', base: 'glm-5.3', ctx: 400_000, label: 'GLM короче' }],
  };
  it('в выборе — сверху, с подписью и усилиями базы', () => {
    const list = modelChoices(p);
    expect(list.map((m) => m.id)).toEqual(['claude-opus-5-5@300k', 'glm-5.3@400k', 'claude-opus-5-5', 'claude-haiku-5-5']);
    expect(list[0]).toMatchObject({ label: 'claude-opus-5-5 · 300K', efforts: ['low', 'max'], ctx: 300_000, custom: true });
    expect(list[1]?.label).toBe('GLM короче');
    expect(effortsFor(p, 'claude-opus-5-5@300k')).toEqual(['low', 'max']);
  });
  it('узнаётся по id даже удалённая; 1M у неё не дописывается — окно в названии', () => {
    expect(findModel(p, 'claude-haiku-5-5@150k')).toMatchObject({ label: 'claude-haiku-5-5 · 150K', custom: true });
    expect(isLong(p, 'glm-5.3@400k')).toBe(false);
    expect(customLabel({ base: 'glm-5.3', ctx: 1_000_000 })).toBe('glm-5.3 · 1M');
  });
  it('добавление: окно 100–1000K, без пробелов и @ в базе, без повторов', () => {
    expect(addCustomModel([], ' glm-5.3 ', 400, '  ')).toEqual([{ id: 'glm-5.3@400k', base: 'glm-5.3', ctx: 400_000 }]);
    expect(addCustomModel([], 'glm-5.3', 50, '')).toBeNull();
    expect(addCustomModel([], 'glm-5.3', 1200, '')).toBeNull();
    expect(addCustomModel([], 'glm 5', 400, '')).toBeNull();
    expect(addCustomModel([], 'glm-5.3', Number.NaN, '')).toBeNull();
    expect(addCustomModel(p.custom!, 'glm-5.3', 400, 'ещё')).toBeNull();
  });
});
