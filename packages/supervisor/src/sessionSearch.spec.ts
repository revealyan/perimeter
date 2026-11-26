// Поиск сессий (как /resume): название из ai-title → последняя реплика → первая; служебное — не реплика;
// пустые не показываем; кэш по mtime/size; поиск по словам — в шапке и в тексте (со снипетом).
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionIndex, parseTranscript, searchSessions } from './sessionSearch.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ss-')); dirs.push(d); return d; };
const L = (o: unknown) => JSON.stringify(o);
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

describe('поиск сессий', () => {
  it('разбор: служебное (caveat, вывод команд, результаты инструментов) — не реплика; название — ai-title', () => {
    const t = [
      L({ type: 'user', isMeta: true, cwd: '/p', entrypoint: 'cli', message: { role: 'user', content: '<local-command-caveat>…' } }),
      L({ type: 'user', message: { role: 'user', content: 'почини КАШТАН в сборке' }, gitBranch: 'main' }),
      L({ type: 'assistant', message: { content: [{ type: 'text', text: 'ок' }] } }),
      L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } }),
      L({ type: 'last-prompt', lastPrompt: 'и тесты' }),
      L({ type: 'ai-title', aiTitle: 'Починка сборки' }),
    ].join('\n');
    expect(parseTranscript(t, ID1, 5, 9)).toEqual({ claudeSessionId: ID1, cwd: '/p', title: 'Починка сборки', firstPrompt: 'почини КАШТАН в сборке', updatedAt: 5, bytes: 9, messages: 2, gitBranch: 'main', entrypoint: 'cli' });
    expect(parseTranscript(L({ type: 'user', message: { content: 'просто вопрос' } }), ID1, 0, 0).title).toBe('просто вопрос');
  });

  it('скан: свежие сверху, пустые — нет, папка у двух аккаунтов — один раз; повтор — из кэша, изменённый — перечитан', () => {
    const cfg = tmp();
    const p = join(cfg, 'projects', '-p');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, `${ID1}.jsonl`), L({ type: 'user', cwd: '/p', message: { content: 'старая' } }));
    writeFileSync(join(p, `${ID2}.jsonl`), L({ type: 'user', cwd: '/p', message: { content: 'новая' } }));
    writeFileSync(join(p, `${ID3}.jsonl`), L({ type: 'queue-operation' }));
    mkdirSync(join(p, ID1, 'subagents'), { recursive: true });
    utimesSync(join(p, `${ID1}.jsonl`), 1000, 1000);
    const idx = new SessionIndex();
    const r = idx.scan([{ account: 'zai', configDir: cfg }, { account: 'default', configDir: cfg }]);
    expect(r.map((x) => [x.firstPrompt, x.account])).toEqual([['новая', 'zai'], ['старая', 'zai']]);
    writeFileSync(join(p, `${ID1}.jsonl`), `${L({ type: 'user', cwd: '/p', message: { content: 'старая' } })}\n${L({ type: 'ai-title', aiTitle: 'Переименована' })}`);
    expect(idx.scan([{ account: 'zai', configDir: cfg }]).find((x) => x.claudeSessionId === ID1)?.title).toBe('Переименована');
  });

  it('поиск: все слова; в шапке — без снипета, в тексте — со снипетом из исходного регистра', () => {
    const cfg = tmp();
    const p = join(cfg, 'projects', '-p');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, `${ID1}.jsonl`), [L({ type: 'user', cwd: '/srv/app', message: { content: 'разберись с деплоем' } }), L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Нашёл: Redis падает по таймауту' }] } })].join('\n'));
    writeFileSync(join(p, `${ID2}.jsonl`), L({ type: 'user', cwd: '/srv/web', message: { content: 'вёрстка шапки' } }));
    const all = new SessionIndex().scan([{ account: 'zai', configDir: cfg }]);
    expect(searchSessions(all, '').length).toBe(2);
    expect(searchSessions(all, 'шапки web').map((x) => [x.firstPrompt, x.match])).toEqual([['вёрстка шапки', undefined]]);
    const r = searchSessions(all, 'redis деплоем');
    expect(r).toHaveLength(1);
    expect(r[0]!.match).toContain('Redis падает');
    expect(searchSessions(all, 'нет-такого')).toEqual([]);
  });
});
