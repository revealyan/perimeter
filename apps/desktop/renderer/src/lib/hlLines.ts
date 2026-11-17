// Подсвеченный код построчно (просмотр файла с номерами строк и отметками в гуттере).
// highlight.js отдаёт один HTML на весь текст, и <span> многострочной строки/комментария
// переходит через \n — режем по строкам, закрывая открытые теги в конце строки и открывая заново в начале.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** HTML подсветки → массив HTML по строкам, у каждой строки сбалансированные теги. */
export function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = '';
  let k = 0;
  while (k < html.length) {
    const ch = html[k]!;
    if (ch === '<') {
      const end = html.indexOf('>', k);
      if (end < 0) { cur += html.slice(k); break; }
      const tag = html.slice(k, end + 1);
      if (tag.startsWith('</')) open.pop();
      else if (!tag.endsWith('/>')) open.push(tag);
      cur += tag;
      k = end + 1;
      continue;
    }
    if (ch === '\n') {
      out.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
      k++;
      continue;
    }
    cur += ch;
    k++;
  }
  out.push(cur + '</span>'.repeat(open.length));
  return out;
}

/** Простой текст построчно, уже экранированный. */
export function plainLines(text: string): string[] {
  return text.split('\n').map(escapeHtml);
}
