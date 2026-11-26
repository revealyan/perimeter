import { describe, expect, it } from 'vitest';
import { activityText, nextActivity, queuedTailStart } from './activity';

describe('строка активности', () => {
  it('кадры потока копятся по виду; имя инструмента — из первого кадра вызова', () => {
    let a = nextActivity(undefined, 'thinking', 'хм', undefined, 1);
    a = nextActivity(a, 'thinking', 'мм', undefined, 2);
    expect(a).toEqual({ kind: 'thinking', chars: 4, at: 2 });
    a = nextActivity(a, 'input_json', '', 'Write', 3);
    a = nextActivity(a, 'input_json', '{"file_path":', undefined, 4);
    expect(a).toEqual({ kind: 'tool', tool: 'Write', chars: 13, at: 4 });
    a = nextActivity(a, 'input_json', '', 'Bash', 5); // новый вызов — счёт заново
    expect(a).toEqual({ kind: 'tool', tool: 'Bash', chars: 0, at: 5 });
  });

  it('подписи: готовит/пишет/размышляет/выполняет; тишина дольше 20 с — видна', () => {
    expect(activityText({ kind: 'tool', tool: 'Write', chars: 12_400, at: 0 }, null, 5000)).toBe('готовит Write · 12 тыс. символов…');
    expect(activityText({ kind: 'text', chars: 10, at: 0 }, null, 1000)).toBe('пишет ответ…');
    expect(activityText(undefined, 'Bash', 0)).toBe('выполняет Bash…');
    expect(activityText(undefined, null, 0)).toBe('думает…');
    expect(activityText({ kind: 'tool', tool: 'Edit', chars: 1, at: 0 }, null, 0)).toBe('готовит Edit · 1 символ…');
    expect(activityText({ kind: 'thinking', chars: 1500, at: 0 }, null, 45_000)).toBe('размышляет · 1,5 тыс. символов… · 45 с без новых данных');
  });

  it('хвост очереди: строка встаёт перед репликами «в очереди» в конце ленты', () => {
    const u = (queued: boolean) => ({ kind: 'user', item: { data: queued ? { queued: true } : {} } });
    expect(queuedTailStart([u(false), { kind: 'agent' }, u(true), u(true)])).toBe(2);
    expect(queuedTailStart([u(false), { kind: 'agent' }])).toBe(2);
    expect(queuedTailStart([u(true), { kind: 'agent' }])).toBe(2);
  });
});
