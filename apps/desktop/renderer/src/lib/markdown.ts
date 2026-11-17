// Мини-разбор маркдауна ответов агента в блоки (без зависимостей, без HTML — XSS невозможен).
// Блоки: абзацы, заголовки, списки (маркированные/нумерованные), цитаты, код, таблицы, разделитель.
// Инлайн разбирается отдельно (inlineTokens): `код`, **жирный**, *курсив*, ~~зачёркнутый~~, [ссылка](url).

export type MdBlock =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; start: number; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'code'; lang: string; text: string; open: boolean }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' };

const reFence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const reHeading = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const reUl = /^\s*[-*+]\s+(.*)$/;
const reOl = /^\s*(\d+)[.)]\s+(.*)$/;
const reQuote = /^\s*>\s?(.*)$/;
const reHr = /^\s*([-*_])(\s*\1){2,}\s*$/;
const reTableSep = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/;

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push({ t: 'p', text: para.join('\n') });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = reFence.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[j]!)) body.push(lines[j++]!);
      // незакрытый блок (идёт печать) — показываем как есть
      out.push({ t: 'code', lang: fence[2] ?? '', text: body.join('\n'), open: j >= lines.length });
      i = j;
      continue;
    }
    if (line.trim() === '') { flushPara(); continue; }

    const h = reHeading.exec(line);
    if (h) { flushPara(); out.push({ t: 'h', level: h[1]!.length, text: h[2]! }); continue; }

    if (reHr.test(line) && para.length === 0) { out.push({ t: 'hr' }); continue; }

    // таблица: строка с | и следом строка-разделитель
    if (line.includes('|') && i + 1 < lines.length && reTableSep.test(lines[i + 1]!)) {
      flushPara();
      const head = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes('|') && lines[j]!.trim() !== '') rows.push(splitRow(lines[j++]!));
      out.push({ t: 'table', head, rows });
      i = j - 1;
      continue;
    }

    const ul = reUl.exec(line);
    const ol = reOl.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = !ul;
      const items: string[] = [];
      const start = ol ? Number(ol[1]) : 1;
      let j = i;
      while (j < lines.length) {
        const l = lines[j]!;
        const m = ordered ? reOl.exec(l) : reUl.exec(l);
        if (m) { items.push(ordered ? m[2]! : m[1]!); j++; continue; }
        // продолжение пункта (отступ) — приклеиваем
        if (/^\s{2,}\S/.test(l) && items.length) { items[items.length - 1] += `\n${l.trim()}`; j++; continue; }
        break;
      }
      out.push(ordered ? { t: 'ol', start, items } : { t: 'ul', items });
      i = j - 1;
      continue;
    }

    const q = reQuote.exec(line);
    if (q) {
      flushPara();
      const body: string[] = [];
      let j = i;
      while (j < lines.length) {
        const m = reQuote.exec(lines[j]!);
        if (!m) break;
        body.push(m[1]!);
        j++;
      }
      out.push({ t: 'quote', text: body.join('\n') });
      i = j - 1;
      continue;
    }

    para.push(line);
  }
  flushPara();
  return out;
}

export type InlineToken =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b'; v: string }
  | { t: 'i'; v: string }
  | { t: 's'; v: string }
  | { t: 'a'; v: string; href: string };

const reInline = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])/g;

export function inlineTokens(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  reInline.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = reInline.exec(text)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: 'b', v: (m[2] ?? m[3])! });
    else if (m[4] !== undefined) out.push({ t: 's', v: m[4] });
    else if (m[5] !== undefined) out.push({ t: 'a', v: m[5], href: m[6]! });
    else out.push({ t: 'i', v: (m[7] ?? m[8])! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/** Ссылка безопасна для открытия (только http/https/mailto). */
export function safeHref(href: string): string | null {
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}
