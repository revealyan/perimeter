import { describe, expect, it } from 'vitest';
import { highOptions, normalOptions, tokensLabel } from './outputLimit';

describe('лимит ответа: варианты', () => {
  it('обычно: умолчание Claude Code и шаги 64/96/128K; нестандартное текущее — на своём месте', () => {
    expect(normalOptions(undefined).map((o) => o.label)).toEqual(['по умолчанию Claude Code (32K)', '64K', '96K', '128K']);
    expect(normalOptions(48_000).map((o) => o.value)).toEqual([null, 48_000, 64_000, 96_000, 128_000]);
  });
  it('на высоком усилии: «как обычно» и те же шаги', () => {
    expect(highOptions(undefined).map((o) => o.value)).toEqual([null, 64_000, 96_000, 128_000]);
  });
  it('подпись: тысячи — K, иначе как есть', () => {
    expect(tokensLabel(128_000)).toBe('128K');
    expect(tokensLabel(12_345)).toBe('12345');
  });
});
