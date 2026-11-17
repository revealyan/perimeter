// Форматирование вызовов и результатов инструментов для ленты — чистые функции без React.
// Результат в кадре — структурированный toolUseResult SDK (у каждого инструмента своя форма,
// см. sdk-tools.d.ts: BashOutput, FileReadOutput, FileEditOutput, GlobOutput, GrepOutput, AgentOutput…),
// после ресинка из транскрипта — он же или сырой content блока tool_result.

export type ToolKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'agent' | 'web' | 'question' | 'todo' | 'mcp' | 'other';

export interface ToolHead {
  kind: ToolKind;
  /** глагол по-русски: «Команда», «Чтение», «Правка»… */
  verb: string;
  /** главное: команда, путь, шаблон, url */
  target: string;
  /** второстепенное: описание команды, каталог поиска, тип субагента */
  note?: string;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Короткая шапка вызова: что делает инструмент и над чем. */
export function toolHead(name: string, input: unknown): ToolHead {
  const i = asObj(input) ?? {};
  switch (name) {
    case 'Bash':
      return { kind: 'shell', verb: 'Команда', target: str(i['command']), ...(str(i['description']) ? { note: str(i['description']) } : {}) };
    case 'Read': {
      const off = typeof i['offset'] === 'number' ? i['offset'] : undefined;
      const lim = typeof i['limit'] === 'number' ? i['limit'] : undefined;
      const range = off !== undefined || lim !== undefined ? `строки ${off ?? 1}–${(off ?? 1) + (lim ?? 0) - 1}` : undefined;
      return { kind: 'read', verb: 'Чтение', target: str(i['file_path']), ...(range && lim !== undefined ? { note: range } : {}) };
    }
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'edit', verb: 'Правка', target: str(i['file_path']) };
    case 'Write':
      return { kind: 'write', verb: 'Запись', target: str(i['file_path']) };
    case 'NotebookEdit':
      return { kind: 'edit', verb: 'Правка ноутбука', target: str(i['notebook_path']) };
    case 'Glob':
      return { kind: 'search', verb: 'Поиск файлов', target: str(i['pattern']), ...(str(i['path']) ? { note: str(i['path']) } : {}) };
    case 'Grep':
      return { kind: 'search', verb: 'Поиск', target: str(i['pattern']), ...(str(i['path']) || str(i['glob']) ? { note: str(i['path']) || str(i['glob']) } : {}) };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', verb: 'Субагент', target: str(i['description']) || str(i['prompt']).slice(0, 120), ...(str(i['subagent_type']) ? { note: str(i['subagent_type']) } : {}) };
    case 'mcp__perimeter__delegate_to_agent':
      // сквозной сабагент: цель — аккаунт-воркер, пояснение — имя задачи (воркер живёт отдельной сессией)
      return { kind: 'agent', verb: 'Воркер', target: str(i['account']), ...(str(i['name']) ? { note: str(i['name']) } : str(i['prompt']) ? { note: str(i['prompt']).slice(0, 120) } : {}) };
    case 'WebFetch':
      return { kind: 'web', verb: 'Загрузка', target: str(i['url']) };
    case 'WebSearch':
      return { kind: 'web', verb: 'Веб-поиск', target: str(i['query']) };
    case 'AskUserQuestion': {
      const qs = Array.isArray(i['questions']) ? (i['questions'] as Array<Record<string, unknown>>) : [];
      return { kind: 'question', verb: 'Вопрос', target: qs.map((q) => str(q['header']) || str(q['question'])).join(' · ') || 'вопрос' };
    }
    case 'TodoWrite':
      return { kind: 'todo', verb: 'План', target: `${Array.isArray(i['todos']) ? (i['todos'] as unknown[]).length : 0} пунктов` };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      if (m) return { kind: 'mcp', verb: m[1]!, target: m[2]!.replace(/_/g, ' ') };
      return { kind: 'other', verb: name, target: compactJson(input, 140) };
    }
  }
}

/** Последние сегменты пути: «…/components/RightRail.tsx». */
export function shortPath(p: string, keep = 3): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep) return p;
  return `…/${parts.slice(-keep).join('/')}`;
}

// ─── диф ────────────────────────────────────────────────────────────────────

export interface DiffLine { sign: ' ' | '+' | '-'; text: string; oldNo?: number; newNo?: number }
export interface Hunk { oldStart: number; newStart: number; lines: DiffLine[] }
export interface Patch { path: string; hunks: Hunk[]; added: number; removed: number }

/** Хунки из structuredPatch SDK (строки с префиксом ' ', '+', '-'). */
export function hunksFromStructured(sp: unknown): Hunk[] | null {
  if (!Array.isArray(sp)) return null;
  const hunks: Hunk[] = [];
  for (const raw of sp) {
    const h = asObj(raw);
    if (!h || !Array.isArray(h['lines'])) continue;
    let o = typeof h['oldStart'] === 'number' ? h['oldStart'] : 1;
    let n = typeof h['newStart'] === 'number' ? h['newStart'] : 1;
    const lines: DiffLine[] = [];
    for (const l of h['lines'] as unknown[]) {
      const s = str(l);
      const sign = s[0];
      const text = s.slice(1);
      if (sign === '+') lines.push({ sign: '+', text, newNo: n++ });
      else if (sign === '-') lines.push({ sign: '-', text, oldNo: o++ });
      else if (sign === ' ') lines.push({ sign: ' ', text, oldNo: o++, newNo: n++ });
      // '\' No newline at end of file — пропускаем
    }
    hunks.push({ oldStart: (h['oldStart'] as number) ?? 1, newStart: (h['newStart'] as number) ?? 1, lines });
  }
  return hunks;
}

/** Построчный диф двух текстов (LCS); для огромных — грубый «всё удалить / всё добавить». */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length * b.length > 250_000) {
    return [...a.map((text, k) => ({ sign: '-' as const, text, oldNo: k + 1 })), ...b.map((text, k) => ({ sign: '+' as const, text, newNo: k + 1 }))];
  }
  // таблица длин LCS с конца
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let x = a.length - 1; x >= 0; x--) {
    for (let y = b.length - 1; y >= 0; y--) {
      dp[x]![y] = a[x] === b[y] ? dp[x + 1]![y + 1]! + 1 : Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let x = 0;
  let y = 0;
  while (x < a.length && y < b.length) {
    if (a[x] === b[y]) { out.push({ sign: ' ', text: a[x]!, oldNo: x + 1, newNo: y + 1 }); x++; y++; }
    else if (dp[x + 1]![y]! >= dp[x]![y + 1]!) { out.push({ sign: '-', text: a[x]!, oldNo: x + 1 }); x++; }
    else { out.push({ sign: '+', text: b[y]!, newNo: y + 1 }); y++; }
  }
  while (x < a.length) { out.push({ sign: '-', text: a[x]!, oldNo: x + 1 }); x++; }
  while (y < b.length) { out.push({ sign: '+', text: b[y]!, newNo: y + 1 }); y++; }
  return out;
}

function countPatch(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l.sign === '+') added++;
    else if (l.sign === '-') removed++;
  }
  return { added, removed };
}

/** Диф правки файла: из результата (точный, с номерами строк) или из входа (до результата/после ресинка). */
export function editPatch(name: string, input: unknown, result: unknown): Patch | null {
  const i = asObj(input) ?? {};
  const r = asObj(result);
  const path = str(i['file_path']) || str(i['notebook_path']) || str(r?.['filePath']);
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
    const fromResult = hunksFromStructured(r?.['structuredPatch']);
    if (fromResult && fromResult.length > 0) return { path, hunks: fromResult, ...countPatch(fromResult) };
    let lines: DiffLine[] = [];
    if (name === 'Edit') lines = lineDiff(str(i['old_string']), str(i['new_string']));
    else if (name === 'MultiEdit' && Array.isArray(i['edits'])) {
      for (const e of i['edits'] as Array<Record<string, unknown>>) lines.push(...lineDiff(str(e['old_string']), str(e['new_string'])));
    } else if (name === 'Write') lines = lineDiff('', str(i['content']));
    const hunks = [{ oldStart: 1, newStart: 1, lines }];
    return { path, hunks, ...countPatch(hunks) };
  }
  if (name === 'NotebookEdit') {
    const hunks = [{ oldStart: 1, newStart: 1, lines: lineDiff('', str(i['new_source'])) }];
    return { path, hunks, ...countPatch(hunks) };
  }
  return null;
}

// ─── результат ──────────────────────────────────────────────────────────────

export type ResultView =
  | { type: 'none' }
  | { type: 'text'; text: string; lang?: string; error?: boolean; markdown?: boolean }
  | { type: 'console'; stdout: string; stderr: string; interrupted: boolean }
  | { type: 'patch'; patch: Patch }
  | { type: 'files'; files: string[]; total: number; truncated: boolean }
  | { type: 'image'; src: string; caption?: string }
  | { type: 'answers'; pairs: Array<{ q: string; a: string }> }
  | { type: 'todos'; items: Array<{ text: string; status: string }> };

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', py: 'python', sh: 'bash', bash: 'bash', css: 'css', html: 'xml', xml: 'xml', svg: 'xml',
  cs: 'csharp', go: 'go', rs: 'rust', md: 'markdown', yml: 'yaml', yaml: 'yaml',
};
export function langOf(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? EXT_LANG[m[1]!.toLowerCase()] : undefined;
}

/** Блоки content tool_result (после ресинка): текст + картинки. */
/** Картинка из результата, которую supervisor не передал в подгруженной истории (экономия туннеля). */
export function omittedImage(bytes: unknown): string {
  const kb = typeof bytes === 'number' && bytes > 0 ? ` · ${Math.max(1, Math.round(bytes / 1024))} КБ` : '';
  return `картинка${kb} — в подгруженной истории не передаётся (в живой ленте видна)`;
}

function fromContentBlocks(blocks: unknown[]): ResultView | null {
  const texts: string[] = [];
  let image: string | null = null;
  for (const raw of blocks) {
    const b = asObj(raw);
    if (!b) continue;
    if (b['type'] === 'text') texts.push(str(b['text']));
    const src = asObj(b['source']);
    if (b['type'] === 'image' && src && src['type'] === 'base64') image ??= `data:${str(src['media_type']) || 'image/png'};base64,${str(src['data'])}`;
    if (b['type'] === 'image' && b['omitted'] === true) texts.push(omittedImage(b['bytes']));
  }
  if (image) return { type: 'image', src: image, ...(texts.length ? { caption: texts.join('\n') } : {}) };
  if (texts.length) return { type: 'text', text: texts.join('\n') };
  return null;
}

/** Представление результата инструмента для карточки. */
export function resultView(name: string, input: unknown, result: unknown, isError = false): ResultView {
  if (result === undefined || result === null || result === '') return { type: 'none' };
  if (typeof result === 'string') {
    const img = /data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)/.exec(result);
    if (img) return { type: 'image', src: img[0] };
    return { type: 'text', text: result, error: isError };
  }
  if (Array.isArray(result)) return fromContentBlocks(result) ?? { type: 'text', text: compactJson(result), error: isError };
  const r = asObj(result)!;

  // делегирование: итог воркера — content-блоки CallToolResult, показываем как текст агента
  if (name === 'mcp__perimeter__delegate_to_agent' && Array.isArray(r['content'])) {
    return fromContentBlocks(r['content']) ?? { type: 'text', text: compactJson(r['content']), error: isError };
  }

  // Bash и подобные: stdout/stderr
  if ('stdout' in r || 'stderr' in r) {
    return { type: 'console', stdout: str(r['stdout']), stderr: str(r['stderr']), interrupted: r['interrupted'] === true };
  }
  switch (name) {
    case 'Read': {
      const f = asObj(r['file']);
      if (r['type'] === 'image' && f && str(f['base64'])) return { type: 'image', src: `data:${str(f['type']) || 'image/png'};base64,${str(f['base64'])}` };
      if (r['type'] === 'image' && f && f['omitted'] === true) return { type: 'text', text: omittedImage(f['bytes']) };
      if (f && typeof f['content'] === 'string') {
        const path = str(f['filePath']);
        const lang = langOf(path);
        return { type: 'text', text: f['content'], ...(lang ? { lang } : {}) };
      }
      break;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const p = editPatch(name, input, result);
      if (p) return { type: 'patch', patch: p };
      break;
    }
    case 'Glob':
      if (Array.isArray(r['filenames'])) {
        const files = (r['filenames'] as unknown[]).map(str);
        return { type: 'files', files, total: typeof r['numFiles'] === 'number' ? r['numFiles'] : files.length, truncated: r['truncated'] === true };
      }
      break;
    case 'Grep':
      if (typeof r['content'] === 'string' && r['content'] !== '') return { type: 'text', text: r['content'] };
      if (Array.isArray(r['filenames'])) {
        const files = (r['filenames'] as unknown[]).map(str);
        return { type: 'files', files, total: typeof r['numFiles'] === 'number' ? r['numFiles'] : files.length, truncated: false };
      }
      break;
    case 'Task':
    case 'Agent':
      if (Array.isArray(r['content'])) {
        const v = fromContentBlocks(r['content'] as unknown[]);
        if (v && v.type === 'text') return { ...v, markdown: true };
        if (v) return v;
      }
      break;
    case 'WebFetch':
      if (typeof r['result'] === 'string') return { type: 'text', text: r['result'], markdown: true };
      break;
    case 'AskUserQuestion': {
      const answers = asObj(r['answers']);
      if (answers) return { type: 'answers', pairs: Object.entries(answers).map(([q, a]) => ({ q, a: Array.isArray(a) ? a.join(', ') : String(a) })) };
      break;
    }
    case 'TodoWrite': {
      const todos = Array.isArray(r['newTodos']) ? r['newTodos'] : null;
      if (todos) return { type: 'todos', items: (todos as Array<Record<string, unknown>>).map((t) => ({ text: str(t['content']), status: str(t['status']) })) };
      break;
    }
    default:
      break;
  }
  if (Array.isArray(r['content'])) {
    const v = fromContentBlocks(r['content'] as unknown[]);
    if (v) return v;
  }
  return { type: 'text', text: compactJson(result), lang: 'json', error: isError };
}

/** Изменения строк по вызову (для счётчиков хода/сессии); null — не правка файла. */
export function editStats(name: string, input: unknown, result: unknown): { added: number; removed: number; path: string } | null {
  const p = editPatch(name, input, result);
  return p ? { added: p.added, removed: p.removed, path: p.path } : null;
}

// ─── контекст ───────────────────────────────────────────────────────────────

export interface CtxView {
  pct: number;
  used?: number;
  max?: number;
  parts: Array<{ name: string; tokens: number; kind: string }>;
}

/** Снимок getContextUsage (SDK: percentage/totalTokens/maxTokens/categories); старые имена — запасной путь. */
export function ctxView(d: Record<string, unknown> | undefined): CtxView | null {
  if (!d) return null;
  const used = typeof d['totalTokens'] === 'number' ? d['totalTokens'] : undefined;
  const max = typeof d['maxTokens'] === 'number' ? d['maxTokens'] : undefined;
  let pct = typeof d['percentage'] === 'number' ? d['percentage'] : undefined;
  if (pct === undefined && used !== undefined && max) pct = (used / max) * 100;
  if (pct === undefined) {
    const legacy = d['usedPercentage'] ?? d['used_percentage'];
    if (typeof legacy === 'number') pct = legacy;
  }
  if (pct === undefined) return null;
  const parts = Array.isArray(d['categories'])
    ? (d['categories'] as Array<Record<string, unknown>>)
        .filter((c) => typeof c['tokens'] === 'number' && (c['tokens'] as number) > 0)
        .map((c) => ({ name: str(c['name']), tokens: c['tokens'] as number, kind: str(c['kind']) || 'used' }))
    : [];
  return { pct: Math.max(0, Math.min(100, Math.round(pct))), ...(used !== undefined ? { used } : {}), ...(max !== undefined ? { max } : {}), parts };
}

// ─── числа ──────────────────────────────────────────────────────────────────

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${Math.round(s - m * 60)} с`;
}

export function fmtCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Байты по-человечески: 512 МБ, 3.2 ГБ. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} ГБ`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} МБ`;
  return `${Math.round(n / 1024)} КБ`;
}

/** JSON для показа: компактно, с обрезкой. */
export function compactJson(v: unknown, max = 4000): string {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? ''; } catch { s = String(v); }
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
}
