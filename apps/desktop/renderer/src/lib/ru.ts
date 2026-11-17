// Русские числительные и короткие форматы времени — чистые функции.

/** Форма слова по числу: plural(2, ['файл', 'файла', 'файлов']) → 'файла'. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

/** «3 файла» */
export function countOf(n: number, forms: readonly [string, string, string]): string {
  return `${n} ${plural(n, forms)}`;
}

/** Таймер «идёт 1:12»: минуты:секунды, с часа — ч:мм:сс. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
