// Ошибки запросов к модели — человеческим языком: что случилось и что делать.
// Вход — текст «API Error: …» из ленты или повтор запроса (HTTP-статус + категория ошибки SDK).

export interface ApiErrorHint {
  title: string;
  hint?: string;
  tone: 'err' | 'warn';
}

export interface ApiErrorInput {
  text?: string;
  status?: number | null;
  /** категория SDK: rate_limit, authentication_failed, billing_error, overloaded, … */
  error?: string;
  /** аккаунт ходит через шлюз (z.ai): у него 429 бывает и от ключа не от кодинг-плана */
  gateway?: boolean;
}

/** Сообщение агента — это ошибка API (Claude Code пишет её текстом «API Error: …»). */
export function isApiErrorText(text: string): boolean {
  return /^\s*API Error\b/i.test(text);
}

function statusOf(i: ApiErrorInput): number | null {
  if (typeof i.status === 'number') return i.status;
  const t = i.text ?? '';
  const m = /\((\d{3})\)/.exec(t) ?? /\b([45]\d\d)\b/.exec(t);
  return m ? Number(m[1]) : null;
}

export function explainApiError(i: ApiErrorInput): ApiErrorHint {
  const text = i.text ?? '';
  const status = statusOf(i);
  const err = i.error;
  if (/\b1211\b|unknown model/i.test(text)) {
    return {
      title: 'z.ai: такой модели нет',
      hint: 'У аккаунта GLM работают модели GLM (glm-5.3[1m], glm-5.3-flash[1m]); модели Claude вроде Fable шлюз не знает — выберите GLM в поле ввода или поправьте список в Настройки → Аккаунты.',
      tone: 'err',
    };
  }
  if (/\b1113\b|insufficient balance|no resource package/i.test(text)) {
    return {
      title: 'z.ai: у ключа нет пакета',
      hint: 'Ключ не от кодинг-плана или пакет закончился. Настройки → Аккаунты → «Ключ API»: ключ с вкладки «Personal Coding Plan».',
      tone: 'err',
    };
  }
  if (status === 401 || status === 403 || err === 'authentication_failed' || /invalid api key|authentication_error|\bunauthorized\b/i.test(text)) {
    return { title: 'ключ не принят', hint: 'Проверьте ключ аккаунта: Настройки → Аккаунты.', tone: 'err' };
  }
  if (err === 'billing_error' || /billing|credit balance/i.test(text)) {
    return { title: 'проблема с оплатой аккаунта', hint: 'Проверьте баланс или подписку — или переключите сессию на другой аккаунт в поле ввода.', tone: 'err' };
  }
  if (err === 'model_not_found' || /not_found_error|model[^.]*not found/i.test(text)) {
    return { title: 'у аккаунта нет такой модели', hint: 'Выберите другую модель в поле ввода.', tone: 'err' };
  }
  if (status === 429 || err === 'rate_limit' || /rate.?limit/i.test(text)) {
    return {
      title: 'лимит запросов',
      hint: i.gateway
        ? 'У z.ai так же отвечает ключ не от кодинг-плана (код 1113) — проверьте ключ в Настройки → Аккаунты. Или подождите / переключите аккаунт.'
        : 'Подождите или переключите сессию на другой аккаунт в поле ввода.',
      tone: 'warn',
    };
  }
  if (status === 529 || err === 'overloaded' || /overloaded/i.test(text)) {
    return { title: 'серверы модели перегружены', hint: 'Claude Code повторит запрос сам.', tone: 'warn' };
  }
  if ((status !== null && status >= 500) || err === 'server_error') {
    return { title: 'ошибка на стороне сервера модели', hint: 'Обычно проходит само — повторите чуть позже.', tone: 'warn' };
  }
  if (status === null && (err === 'unknown' || err === undefined) && !text) {
    return { title: 'нет ответа от сервера модели', hint: 'Обрыв или таймаут — повтор идёт сам.', tone: 'warn' };
  }
  return { title: 'ошибка запроса к модели', tone: 'err' };
}

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  status: number | null;
  error: string;
}

/** «запрос не прошёл (429) · повтор 3 из 10 через 8 с». */
export function retryLine(r: RetryInfo): string {
  const what = r.status === null ? 'нет ответа' : String(r.status);
  const sec = Math.max(1, Math.round(r.delayMs / 1000));
  const of = r.maxRetries > 0 ? ` из ${r.maxRetries}` : '';
  return `запрос не прошёл (${what}) · повтор ${r.attempt}${of} через ${sec} с`;
}
