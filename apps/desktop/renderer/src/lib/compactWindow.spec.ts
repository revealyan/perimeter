import { describe, expect, it } from 'vitest';
import { compactOptions } from './compactWindow';

describe('окно автокомпакта: варианты', () => {
  it('«как у модели» и шаги 200K…800K; нестандартное текущее — на своём месте', () => {
    expect(compactOptions(undefined).map((o) => o.label)).toEqual(['как у модели', '200K', '300K', '400K', '500K', '600K', '800K']);
    expect(compactOptions(450_000).map((o) => o.value)).toEqual([null, 200_000, 300_000, 400_000, 450_000, 500_000, 600_000, 800_000]);
    expect(compactOptions(undefined, 'как у аккаунта')[0]!.label).toBe('как у аккаунта');
  });
});
