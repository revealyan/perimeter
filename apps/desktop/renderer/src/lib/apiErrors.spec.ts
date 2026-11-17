import { describe, expect, it } from 'vitest';
import { explainApiError, isApiErrorText, retryLine } from './apiErrors';

const ZAI_1113 = 'API Error: Request rejected (429) · [1113][Insufficient balance or no resource package. Please recharge.][2026…]';

describe('ошибки API человеческим языком', () => {
  it('сообщение агента «API Error: …» узнаётся, обычный текст — нет', () => {
    expect(isApiErrorText(ZAI_1113)).toBe(true);
    expect(isApiErrorText('Поправил API error handling в клиенте')).toBe(false);
  });
  it('z.ai 1211: неизвестная модель — подсказка про модели GLM (Fable и прочие Claude шлюз не знает)', () => {
    const r = explainApiError({ text: 'API Error: 400 {"error":{"code":"1211","message":"[1211][Unknown Model, please check the model code.][2026111208081148ef4b2a68cc45c2]"}}' });
    expect(r.title).toBe('z.ai: такой модели нет');
    expect(r.hint).toContain('glm-5.3[1m]');
  });
  it('z.ai 1113: не лимит, а ключ не от кодинг-плана — с подсказкой, где поменять', () => {
    const r = explainApiError({ text: ZAI_1113 });
    expect(r.title).toContain('нет пакета');
    expect(r.hint).toContain('Personal Coding Plan');
    expect(r.tone).toBe('err');
  });
  it('по статусу и категории SDK', () => {
    expect(explainApiError({ status: 401 }).title).toBe('ключ не принят');
    expect(explainApiError({ error: 'authentication_failed', status: null }).title).toBe('ключ не принят');
    expect(explainApiError({ status: 429, error: 'rate_limit' }).title).toBe('лимит запросов');
    expect(explainApiError({ status: 529 }).title).toContain('перегружены');
    expect(explainApiError({ status: 503 }).title).toContain('сервера модели');
    expect(explainApiError({ error: 'billing_error' }).title).toContain('оплат');
    expect(explainApiError({ error: 'model_not_found' }).title).toContain('модели');
    expect(explainApiError({ status: null, error: 'unknown' }).title).toContain('нет ответа');
    expect(explainApiError({ text: 'API Error: что-то странное' }).title).toBe('ошибка запроса к модели');
  });
  it('429 у шлюза — подсказка про ключ кодинг-плана; у Claude — подождать', () => {
    expect(explainApiError({ status: 429, gateway: true }).hint).toContain('1113');
    expect(explainApiError({ status: 429 }).hint).not.toContain('1113');
  });
  it('статус вытаскивается из текста ошибки', () => {
    expect(explainApiError({ text: 'API Error: Request rejected (401) · invalid x-api-key' }).title).toBe('ключ не принят');
  });
});

describe('строка повтора', () => {
  it('номер, лимит и пауза; без HTTP-ответа — «нет ответа»', () => {
    expect(retryLine({ attempt: 3, maxRetries: 10, delayMs: 8200, status: 429, error: 'rate_limit' })).toBe('запрос не прошёл (429) · повтор 3 из 10 через 8 с');
    expect(retryLine({ attempt: 1, maxRetries: 0, delayMs: 100, status: null, error: 'unknown' })).toBe('запрос не прошёл (нет ответа) · повтор 1 через 1 с');
  });
});
