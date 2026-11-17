// Синк проектов между средами: догадка, где проект лежит в этой среде.

/** Родительская папка и последний сегмент пути (разделители Windows и POSIX). */
export function splitPath(p: string): { dir: string; base: string; sep: string } {
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]/).filter(Boolean);
  const base = parts.pop() ?? '';
  const dir = p.startsWith('/') ? `/${parts.join('/')}` : parts.join(sep);
  return { dir, base, sep };
}

/**
 * Догадка о папке проекта здесь: рядом с уже известным проектом этой среды, с тем же именем папки,
 * что в другой среде (/opt/pipeline на VPS + C:\devs\perimeter здесь → C:\devs\pipeline). Нет опоры — пусто.
 */
export function guessPath(sug: { otherPath: string }, hereProjects: Array<{ path: string }>): string {
  const anchor = hereProjects[0]?.path;
  const { base } = splitPath(sug.otherPath);
  if (!anchor || !base) return '';
  const { dir, sep } = splitPath(anchor);
  return dir ? `${dir}${dir.endsWith(sep) ? '' : sep}${base}` : '';
}
