// Имена без ручного ввода: сессия — из первого сообщения (как в Claude Code Desktop),
// папка проекта — из названия латиницей (хранилище: имя → папка).

/** Имя сессии из первого сообщения: первая непустая строка, без markdown-шелухи, не длиннее max символов. */
export function sessionNameFrom(text: string, max = 48): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  const clean = line
    .replace(/^[#>*\-\s]+/, '') // заголовок, цитата, пункт списка
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return 'новая сессия';
  if (clean.length <= max) return clean.replace(/[.:;,]+$/, '');
  const cut = clean.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[.:;,\s]+$/, '')}…`;
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'e', ґ: 'g',
};

/**
 * Папка проекта из названия: транслит, нижний регистр, всё прочее — дефис; как ProjectSlugSchema протокола
 * (^[a-z0-9][a-z0-9._-]{0,63}$). Пусто после очистки — 'project'.
 */
export function projectSlug(name: string): string {
  const latin = [...name.trim().toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('');
  const slug = latin
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é → e
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64)
    .replace(/[-._]+$/g, '');
  return slug === '' ? 'project' : slug;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Имя репозитория из ссылки git (https, ssh, git@host:owner/repo.git, file://); пусто — нет. */
export function repoNameFromUrl(url: string): string {
  const u = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const last = u.split(/[/:\\]/).filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/** Похоже на ссылку git, которую можно клонировать (как проверяет supervisor; не начинается с «-»). */
export function looksLikeGitUrl(url: string): boolean {
  const u = url.trim();
  if (u === '' || u.startsWith('-') || /\s/.test(u)) return false;
  return /^(https?|ssh|git|file):\/\//i.test(u) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(u);
}
