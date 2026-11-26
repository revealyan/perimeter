// Строка активности внизу ленты (владелец 2026-11-26: «подвис — выглядело, что ничего не происходит; разделитель
// как в Claude Code Desktop, что ты думаешь, — между твоими сообщениями и очередью моих»). Чистые функции.
import { countOf } from './ru';

/** Что модель шлёт прямо сейчас (по кадрам потока); сбрасывается готовым блоком и концом хода. */
export interface Activity {
  kind: 'thinking' | 'text' | 'tool';
  /** имя инструмента, вход которого пишется */
  tool?: string;
  /** сколько символов этого блока уже пришло */
  chars: number;
  /** последний кадр потока */
  at: number;
}

/** Кадр event:stream.delta → новая активность (тот же вид — копим символы). */
export function nextActivity(prev: Activity | undefined, kind: 'thinking' | 'text' | 'input_json', delta: string, tool: string | undefined, now: number): Activity {
  const k: Activity['kind'] = kind === 'input_json' ? 'tool' : kind;
  const same = prev !== undefined && prev.kind === k && (tool === undefined || prev.tool === tool);
  const name = tool ?? (same ? prev.tool : undefined);
  return { kind: k, ...(name !== undefined ? { tool: name } : {}), chars: (same ? prev.chars : 0) + delta.length, at: now };
}

const size = (chars: number): string => (chars < 1000
  ? countOf(chars, ['символ', 'символа', 'символов'])
  : `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0).replace('.', ',')} тыс. символов`);

/** Подпись строки: что делается и, если поток молчит, — сколько уже тишины. */
export function activityText(a: Activity | undefined, runningTool: string | null, now: number): string {
  let what: string;
  if (runningTool) what = `выполняет ${runningTool}`;
  else if (!a) what = 'думает';
  else if (a.kind === 'tool') what = `готовит ${a.tool ?? 'вызов'}${a.chars > 0 ? ` · ${size(a.chars)}` : ''}`;
  else if (a.kind === 'text') what = 'пишет ответ';
  else what = `размышляет${a.chars > 0 ? ` · ${size(a.chars)}` : ''}`;
  // модель молчит дольше 20 с (сеть, долгая генерация на стороне API) — видно, что ждём, а не зависли молча
  const quiet = a && !runningTool ? Math.floor((now - a.at) / 1000) : 0;
  return `${what}…${quiet >= 20 ? ` · ${quiet} с без новых данных` : ''}`;
}
