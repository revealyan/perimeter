import { describe, expect, it } from 'vitest';
import { loginNeeded } from './loginNeeded';

describe('вход на этом компьютере', () => {
  it('есть рабочий (вошёл или по ключу) — ничего не предлагаем; все не вошли — аккаунт по умолчанию первым', () => {
    expect(loginNeeded([{ name: 'default', auth: { loggedIn: false } }, { name: 'zai' }])).toBeNull();
    expect(loginNeeded([{ name: 'default', auth: { loggedIn: true } }])).toBeNull();
    expect(loginNeeded([{ name: 'work', auth: { loggedIn: false } }, { name: 'default', auth: { loggedIn: false } }])?.name).toBe('default');
    expect(loginNeeded([])).toBeNull();
  });
});
