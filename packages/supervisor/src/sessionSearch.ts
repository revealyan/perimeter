// Поиск сессий как /resume в Claude Code (владелец 2026-11-26: «поиск сессий уже существующих, типа как в клод коде;
// мб даже в фоне автоматом сканить и дать уведомление»): все транскрипты всех аккаунтов этого сервера — и заведённые
// Perimeter'ом, и запущенные Claude Code напрямую (CLI). Поиск по названию, репликам, папке и содержимому.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface FoundSession {
  claudeSessionId: string;
  /** внешнее имя аккаунта, в папке которого транскрипт */
  account: string;
  cwd: string | null;
  /** название: ai-title Claude Code → последняя реплика → первая реплика */
  title: string;
  firstPrompt: string | null;
  updatedAt: number;
  bytes: number;
  /** реплик человека и ответов агента */
  messages: number;
  gitBranch: string | null;
  /** откуда запущена: cli — Claude Code напрямую, sdk-* — через SDK (Perimeter) */
  entrypoint: string | null;
  /** id сессии в Perimeter; нет — сессия вне Perimeter */
  perimeterId?: string;
  archived?: boolean;
  /** кусок текста вокруг совпадения */
  match?: string;
}

interface Meta { mtime: number; size: number; data: Omit<FoundSession, 'account' | 'perimeterId' | 'archived' | 'match'> }

/** Реплика человека, а не служебное (caveat команд, вывод локальной команды, напоминания). */
function humanText(o: { isMeta?: unknown; message?: { content?: unknown } }): string | null {
  if (o.isMeta === true) return null;
  const c = o.message?.content;
  let t: string | null = null;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    if (c.some((b: { type?: string }) => b?.type === 'tool_result')) return null;
    t = c.filter((b: { type?: string; text?: string }) => b?.type === 'text').map((b: { text?: string }) => b.text ?? '').join(' ') || null;
  }
  if (!t) return null;
  t = t.trim();
  if (t.startsWith('<local-command') || t.startsWith('<command-') || t.startsWith('<system-reminder>') || t === '') return null;
  return t;
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Разбор транскрипта (одним проходом). */
export function parseTranscript(text: string, claudeSessionId: string, mtime: number, size: number): Meta['data'] {
  let cwd: string | null = null;
  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  let firstPrompt: string | null = null;
  let gitBranch: string | null = null;
  let entrypoint: string | null = null;
  let messages = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const t = o['type'];
    if (typeof o['cwd'] === 'string' && cwd === null) cwd = o['cwd'];
    if (typeof o['gitBranch'] === 'string' && o['gitBranch']) gitBranch = o['gitBranch'];
    if (typeof o['entrypoint'] === 'string' && entrypoint === null) entrypoint = o['entrypoint'];
    if (t === 'ai-title' && typeof o['aiTitle'] === 'string') aiTitle = o['aiTitle'];
    else if (t === 'summary' && typeof o['summary'] === 'string' && !aiTitle) aiTitle = o['summary'];
    else if (t === 'last-prompt' && typeof o['lastPrompt'] === 'string') lastPrompt = o['lastPrompt'];
    else if (t === 'user') {
      const h = humanText(o as { isMeta?: unknown; message?: { content?: unknown } });
      if (h !== null) { messages++; firstPrompt ??= h; }
    } else if (t === 'assistant') messages++;
  }
  const title = oneLine(aiTitle ?? lastPrompt ?? firstPrompt ?? 'без названия', 120);
  return { claudeSessionId, cwd, title, firstPrompt: firstPrompt ? oneLine(firstPrompt, 200) : null, updatedAt: mtime, bytes: size, messages, gitBranch, entrypoint };
}

/** Сканер с кэшем по (mtime, size): повторный поиск не перечитывает неизменившиеся транскрипты. */
export class SessionIndex {
  private cache = new Map<string, Meta>();

  /** Все транскрипты аккаунтов: папки projects/<слаг>/<uuid>.jsonl (подпапки субагентов не считаем). */
  scan(dirs: Array<{ account: string; configDir: string }>): Array<FoundSession & { file: string }> {
    const out: Array<FoundSession & { file: string }> = [];
    const seen = new Set<string>();
    for (const { account, configDir } of dirs) {
      const root = join(configDir, 'projects');
      let slugs: string[];
      try { slugs = readdirSync(root); } catch { continue; }
      for (const slug of slugs) {
        let names: string[];
        try { names = readdirSync(join(root, slug)); } catch { continue; }
        for (const n of names) {
          if (!/^[0-9a-f-]{36}\.jsonl$/.test(n)) continue;
          const file = join(root, slug, n);
          if (seen.has(file)) continue; // одна папка у двух аккаунтов (базовая) — один раз
          seen.add(file);
          let st;
          try { st = statSync(file); } catch { continue; }
          let m = this.cache.get(file);
          if (!m || m.mtime !== st.mtimeMs || m.size !== st.size) {
            let text: string;
            try { text = readFileSync(file, 'utf8'); } catch { continue; }
            m = { mtime: st.mtimeMs, size: st.size, data: parseTranscript(text, n.slice(0, -6), st.mtimeMs, st.size) };
            this.cache.set(file, m);
          }
          if (m.data.messages === 0) continue; // пустые (сессия так и не начиналась)
          out.push({ ...m.data, account, file });
        }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Кусок вокруг совпадения в сыром транскрипте (JSON-экранирование сглажено). */
export function snippet(raw: string, idx: number, len: number): string {
  const from = Math.max(0, idx - 60);
  const s = raw.slice(from, idx + len + 80).replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\t/g, ' ');
  return `${from > 0 ? '…' : ''}${oneLine(s, 170)}…`;
}

/**
 * Поиск: пусто — все по свежести; иначе слова запроса (все) — в названии, репликах, папке, ветке или тексте транскрипта.
 * Совпадение по содержимому — со снипетом.
 */
export function searchSessions(all: Array<FoundSession & { file: string }>, query: string, limit = 60, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): FoundSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const res: FoundSession[] = [];
  for (const s of all) {
    if (res.length >= limit) break;
    const { file, ...pub } = s;
    if (words.length === 0) { res.push(pub); continue; }
    const head = `${s.title} ${s.firstPrompt ?? ''} ${s.cwd ?? ''} ${s.gitBranch ?? ''} ${s.account}`.toLowerCase();
    if (words.every((w) => head.includes(w))) { res.push(pub); continue; }
    let orig: string;
    try { orig = read(file); } catch { continue; }
    const raw = orig.toLowerCase();
    if (!words.every((w) => raw.includes(w) || head.includes(w))) continue;
    const w = words.find((x) => raw.includes(x))!;
    // кусок — из исходного текста (регистр как был); позиции у toLowerCase совпадают для кириллицы и латиницы
    res.push({ ...pub, match: snippet(orig, raw.indexOf(w), w.length) });
  }
  return res;
}
