import { describe, expect, it } from 'vitest';
import { localSupBusy } from './localSup';

describe('localSupBusy', () => {
  it('установка и старт — занят', () => {
    expect(localSupBusy('готовлю локальный supervisor 0.1.0-abc')).toBe(true);
    expect(localSupBusy('докачиваю движок: 2/2 · claude-agent-sdk-win32-x64 · 45 из 153 МБ')).toBe(true);
    expect(localSupBusy('запускается…')).toBe(true);
  });
  it('ошибки, остановка и пустой статус — можно жать «запустить»', () => {
    for (const s of ['', 'не запущен', 'остановлен', 'упал (код 1): …', 'движок не установился: загрузка встала', 'запущен']) {
      expect(localSupBusy(s)).toBe(false);
    }
  });
});
