// «Этот компьютер» без рабочего аккаунта (владелец 2026-11-26: на маке вход Claude Code Desktop лежит отдельно —
// аккаунт не подтянулся): какой аккаунт предложить войти. Чистая функция.

export interface AuthLike { name: string; auth?: { loggedIn: boolean } | undefined }

/**
 * Рабочий — вошёл или работает по ключу (входа не требует: auth не проверяется). Нет ни одного рабочего, а есть
 * не вошедший — его и предлагаем (аккаунт по умолчанию — первым). Аккаунтов нет вовсе — null (там «добавить», не «войти»).
 */
export function loginNeeded<T extends AuthLike>(profiles: T[], base = 'default'): T | null {
  if (profiles.some((p) => p.auth?.loggedIn !== false)) return null;
  return profiles.find((p) => p.name === base) ?? profiles[0] ?? null;
}
