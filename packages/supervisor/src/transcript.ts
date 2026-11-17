// Ресинк ленты из транскрипта claude (~/.claude/projects/<слаг>/<sid>.jsonl).
// Схема записей внутренняя и меняется между версиями CLI (recon §5) — поэтому
// парсер терпимый: незнакомые строки пропускаем, не падаем.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Слаг пути проекта: не-буквенно-цифровые символы → '-' (правило Claude Code). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function transcriptPath(claudeConfigDir: string, cwd: string, sessionId: string): string {
  return join(claudeConfigDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Перенести транскрипт сессии в каталог другого профиля (у каждого аккаунта свой CLAUDE_CONFIG_DIR/projects):
 * без этого resume под новым аккаунтом не находит историю. true — файл скопирован.
 */
export function carryTranscript(fromConfigDir: string, toConfigDir: string, cwd: string, claudeSessionId: string): boolean {
  const from = transcriptPath(fromConfigDir, cwd, claudeSessionId);
  const to = transcriptPath(toConfigDir, cwd, claudeSessionId);
  if (from === to || !existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to); // перезапись: при смене туда-обратно целевой файл старше исходного
  return true;
}

/**
 * Перенос в другую среду: переписать поле cwd верхнего уровня каждой записи транскрипта
 * на папку проекта здесь (клауде ищет историю по слагу cwd). Непарсящиеся строки — как есть.
 */
export function retargetTranscript(text: string, toCwd: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const o = JSON.parse(line) as { cwd?: unknown };
      out.push(JSON.stringify(typeof o?.cwd === 'string' ? { ...o, cwd: toCwd } : o));
    } catch {
      out.push(line);
    }
  }
  return `${out.join('\n')}\n`;
}

/** Записать принятый транскрипт в каталог слага нового cwd; возвращает путь файла. */
export function writeTranscript(claudeConfigDir: string, cwd: string, claudeSessionId: string, text: string): string {
  const to = transcriptPath(claudeConfigDir, cwd, claudeSessionId);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, text, 'utf8');
  return to;
}

/** Элемент ленты UI (совпадает по форме с FeedItem клиента). */
export interface TranscriptItem {
  kind: 'user' | 'text' | 'thinking' | 'tool-use' | 'tool-result' | 'state';
  data: Record<string, unknown>;
}

// Служебные user-строки, которые CLI пишет от имени пользователя, но это не реплики
// (замечены в живых транскриптах 2.1.x): напоминания, уведомления о фоновых задачах,
// вывод локальных/bash-команд, маркеры прерывания, саммари компакта.
const SERVICE_TEXT = [
  /^\s*<system-reminder>/,
  /^\s*<task-notification>/,
  /^\s*<local-command-(stdout|stderr|caveat)>/,
  /^\s*<bash-(input|stdout|stderr)>/,
  /^\s*<command-(stdout|stderr)>/,
  /^\s*<user-memory-input>/,
  /^\s*\[Request interrupted by user[^\]]*\]\s*$/,
  /^This session is being continued from a previous conversation/,
  /^Another Claude session sent a message:/,
];

const isServiceText = (t: string): boolean => SERVICE_TEXT.some((re) => re.test(t));

/** Слеш-команда, набранная пользователем: <command-name>/x</command-name>…<command-args>a</command-args> → «/x a». */
function slashCommandText(t: string): string | null {
  if (!/^\s*<command-(name|message)>/.test(t)) return null;
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
  const cmd = name.startsWith('/') ? name : `/${name}`;
  return args ? `${cmd} ${args}` : cmd;
}

/** Текст пользовательского блока → то, что показать в ленте (null — служебное, не показывать). */
function userText(t: string): string | null {
  const cmd = slashCommandText(t);
  if (cmd !== null) return cmd;
  if (isServiceText(t)) return null;
  return t;
}

/**
 * Читает транскрипт и мапит в элементы ленты. afterUuid — продолжить после строки
 * с этим uuid (P0: отдаём хвост последних N элементов, лента восстанавливается целиком).
 */
export function readTranscriptItems(path: string, limit = 500): { items: TranscriptItem[]; lines: number } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const items: TranscriptItem[] = [];
  let lines = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    lines += 1;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    // ветка субагента (в старых версиях CLI — в том же файле) в основную ленту не идёт
    if (obj['isSidechain'] === true) continue;
    const type = obj['type'];
    if (type === 'assistant' && obj['message'] && typeof obj['message'] === 'object') {
      const msg = obj['message'] as { content?: unknown; id?: string };
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          items.push({ kind: 'text', data: { text: b['text'] } });
        } else if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
          items.push({ kind: 'thinking', data: { text: b['thinking'] } });
        } else if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
          items.push({ kind: 'tool-use', data: { id: b['id'], name: b['name'], input: b['input'], result: undefined, isError: false, done: true } });
        }
      }
    } else if (type === 'user' && obj['message'] && typeof obj['message'] === 'object') {
      // мета-строки (caveat, размеры картинок, сообщения других сессий) и саммари компакта — не реплики
      if (obj['isMeta'] === true || obj['isCompactSummary'] === true || obj['isVisibleInTranscriptOnly'] === true) continue;
      const msg = obj['message'] as { content?: unknown };
      // набранная реплика: CLI пишет её строкой, а не массивом блоков
      if (typeof msg.content === 'string') {
        const text = userText(msg.content);
        if (text !== null && text.trim() !== '') items.push({ kind: 'user', data: { text } });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      // обычное сообщение пользователя (текст + картинки) — картинки как картинки, не base64-текст
      const isToolFlow = (msg.content as Array<Record<string, unknown>>).some((b) => b['type'] === 'tool_result');
      if (!isToolFlow) {
        const text: string[] = [];
        const images: string[] = [];
        for (const b of msg.content as Array<Record<string, unknown>>) {
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            const shown = userText(b['text']);
            if (shown !== null && shown.trim() !== '') text.push(shown);
          }
          const src = (b as { source?: { type?: string; media_type?: string; data?: unknown } }).source;
          if (b['type'] === 'image' && src && src['type'] === 'base64' && typeof src['data'] === 'string') {
            images.push(`data:${src['media_type'] ?? 'image/png'};base64,${src['data']}`);
          }
        }
        if (text.length > 0 || images.length > 0) {
          items.push({ kind: 'user', data: { text: text.join('\n'), ...(images.length > 0 ? { images } : {}) } });
        }
        continue;
      }
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
          // приклеиваем к карточке вызова, как в живом потоке
          const target = [...items].reverse().find((it) => it.kind === 'tool-use' && it.data['id'] === b['tool_use_id']);
          if (target) {
            target.data['result'] = stripImages(obj['toolUseResult'] ?? b['content']);
            target.data['isError'] = b['is_error'] === true;
          } else {
            items.push({ kind: 'tool-result', data: { isError: b['is_error'] === true, result: stripImages(obj['toolUseResult'] ?? b['content']) } });
          }
        }
      }
    }
    // прочие типы (system/summary/ai-title/mode/…) в ленту не идут
  }
  return { items: items.length > limit ? items.slice(-limit) : items, lines };
}

/**
 * Картинки в результатах инструментов (агент читает файл-картинку → её base64 целиком в истории, часто дублем
 * вложения) — главный вес transcript.get через туннель (~150 КБ/с до VPS). В подгрузке истории оставляем
 * только пометку «картинка, N байт»; в живой ленте картинки по-прежнему приходят как есть.
 */
export function stripImages(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => stripImages(x, depth + 1));
  const o = v as Record<string, unknown>;
  const src = o['source'] as Record<string, unknown> | undefined;
  if (o['type'] === 'image' && src && typeof src['data'] === 'string') {
    return { type: 'image', omitted: true, mediaType: typeof src['media_type'] === 'string' ? src['media_type'] : 'image/png', bytes: Math.round((src['data'] as string).length * 0.75) };
  }
  const file = o['file'] as Record<string, unknown> | undefined;
  if (o['type'] === 'image' && file && typeof file['base64'] === 'string') {
    const { base64, ...rest } = file;
    return { ...o, file: { ...rest, omitted: true, bytes: Math.round((base64 as string).length * 0.75) } };
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, stripImages(x, depth + 1)]));
}
