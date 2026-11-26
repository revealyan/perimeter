// Демо-supervisor для ручной проверки UI без claude и без токенов:
// настоящие WssServer + SessionManager + профили/проекты, но вместо субпроцесса — сценарный движок.
// Сценарии пишут фейковый транскрипт (ресинк из транскрипта тоже проверяется).
//
// Запуск: npx tsx packages/supervisor/scripts/demo-server.ts   (порт PERIMETER_PORT, по умолчанию 8790)
// Сценарий выбирается словом в сообщении:
//   «разреш» — карточка разрешения · «вопрос» — AskUserQuestion · «ошибк» — упавшая команда
//   «картин» — картинка в результате · «субагент» — ветка Task · «делегир» — воркер на другом аккаунте · «долго» — длинный ход (проверка Stop)
//   «задач» — список задач (TaskCreate/TaskUpdate), ход висит минуту
//   иначе — обзорный ход: thinking, Glob, Read, Grep, Bash, Edit (патч), Write, маркдаун, итог хода.
//
// Панели (файлы/git/терминал) работают по-настоящему: все сессии демо получают cwd внутри DEMO_ROOT
// (env; по умолчанию — корень этого репозитория). Пути вне DEMO_ROOT (/opt/perimeter, /root, папка
// проекта из UI) подменяются на DEMO_ROOT — на стенде их может не быть.
//
// Удалённый браузер (rb.*) тоже настоящий: WssServer поднимает headless Chromium/Edge этой машины
// (PERIMETER_CHROMIUM или автопоиск). Не нашёлся — rb.open отвечает RB_UNAVAILABLE с понятным текстом.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { SessionManager, type SessionCreateOptions } from '../src/session/manager.js';
import { isInside } from '../src/panels/paths.js';
import { findChromium } from '../src/panels/rbrowser.js';
import { WssServer } from '../src/wss.js';
import { ProfileRegistry } from '../src/profiles.js';
import { ProjectStore } from '../src/projects.js';
import { realGit, type GitRunner } from '../src/storage.js';
import { transcriptPath } from '../src/transcript.js';
import type { EngineHooks } from '../src/session/engine.js';
import type { QueryLike, SdkMsg, SdkUserInput } from '../src/session/types.js';
import type { ModelInfoFrame } from '@perimeter/protocol';

const port = Number(process.env.PERIMETER_PORT ?? 8790);
const root = mkdtempSync(join(tmpdir(), 'perimeter-demo-'));
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude'); // транскрипты — сюда (их читает cmd:transcript.get)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── корень панелей стенда ──────────────────────────────────────────────────

const DEMO_ROOT = resolve(process.env.DEMO_ROOT ?? fileURLToPath(new URL('../../..', import.meta.url)));
if (!existsSync(DEMO_ROOT)) {
  console.error(`DEMO_ROOT не существует: ${DEMO_ROOT}`);
  process.exit(1);
}
/** Папка демо внутри DEMO_ROOT: существующая подпапка — как есть, иначе сам DEMO_ROOT. */
const demoDir = (...sub: string[]): string => {
  const p = join(DEMO_ROOT, ...sub);
  return existsSync(p) ? p : DEMO_ROOT;
};
/** cwd сессии на стенде: всё, что не внутри DEMO_ROOT (или не существует), подменяется на DEMO_ROOT. */
const demoCwd = (cwd: string | undefined): string => {
  if (cwd === undefined) return DEMO_ROOT;
  const abs = resolve(cwd);
  return existsSync(abs) && isInside(DEMO_ROOT, abs) ? abs : DEMO_ROOT;
};

/** Менеджер стенда: сессии из UI (session.new, проекты, форк) тоже получают cwd внутри DEMO_ROOT. */
class DemoSessionManager extends SessionManager {
  override create(opts: SessionCreateOptions): string {
    return super.create({ ...opts, cwd: demoCwd(opts.cwd) });
  }
}

// ─── сценарный движок ───────────────────────────────────────────────────────

/** Пробуждение остывшей на стенде (respawn): процесс «поднимается» дольше — видно «просыпается…» (DEMO_WAKE_MS). */
const DEMO_WAKE_MS = Number(process.env['DEMO_WAKE_MS'] ?? 1500);
/** id транскрипта сессии стенда — тот же после пробуждения (resume), иначе ресинк потерял бы историю */
const demoClaudeIds = new Map<string, string>();

function scriptedFactory(sess: { cwd?: string; model?: string; permissionMode?: string; projectId?: string }, sessionId?: string) {
  return (input: AsyncIterable<SdkUserInput>, hooks: EngineHooks): QueryLike => {
    const resumed = sessionId !== undefined && demoClaudeIds.has(sessionId);
    const claudeId = (sessionId !== undefined ? demoClaudeIds.get(sessionId) : undefined) ?? randomUUID();
    if (sessionId !== undefined) demoClaudeIds.set(sessionId, claudeId);
    // как у настоящего CLI: initialize отвечен, когда процесс поднялся; после resume init — только с первым ходом
    const readyMs = resumed ? DEMO_WAKE_MS : 700;
    // тот же cwd, что видит менеджер (DemoSessionManager) — иначе ресинк не найдёт транскрипт
    const cwd = demoCwd(sess.cwd);
    const tpath = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, claudeId);
    mkdirSync(dirname(tpath), { recursive: true });
    const log = (o: unknown) => appendFileSync(tpath, `${JSON.stringify(o)}\n`);
    let model = sess.model ?? 'claude-sonnet-5-5';
    let mode = sess.permissionMode ?? 'acceptEdits';
    let interrupted = false;
    let ctxTokens = 21_800;

    async function* run(): AsyncGenerator<SdkMsg> {
      await sleep(readyMs); // «стартует»: скелетон ленты
      if (!resumed) yield { type: 'system', subtype: 'init', session_id: claudeId, tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'AskUserQuestion', 'WebFetch'], mcp_servers: [{ name: 'serena', status: 'connected' }], model, permissionMode: mode } as SdkMsg;
      for await (const m of input) {
        log({ type: 'user', message: m.message });
        interrupted = false;
        const c = m.message.content;
        const text = typeof c === 'string' ? c : c.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n');
        const started = Date.now();
        let turns = 0;

        // ── примитивы сценария ──
        const assistant = (content: unknown[], parent: string | null = null): SdkMsg => {
          const msg = { type: 'assistant', message: { id: `msg_${randomUUID().slice(0, 8)}`, content }, parent_tool_use_id: parent } as SdkMsg;
          if (!parent) log(msg);
          return msg;
        };
        async function* say(t: string, speed = 14): AsyncGenerator<SdkMsg> {
          for (let i = 0; i < t.length; i += 6) {
            if (interrupted) return;
            yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t.slice(i, i + 6) } } } as SdkMsg;
            await sleep(speed);
          }
          yield assistant([{ type: 'text', text: t }]);
        }
        async function* tool(name: string, toolInput: unknown, output: unknown, opts: { isError?: boolean; delay?: number; ask?: boolean; streamMs?: number } = {}): AsyncGenerator<SdkMsg> {
          if (interrupted) return;
          turns += 1;
          const id = `toolu_${randomUUID().slice(0, 12)}`;
          if (opts.streamMs) {
            // как настоящая модель: вход инструмента приходит кусками (длинный Write — минуты), строка активности это видит
            yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } } as SdkMsg;
            const json = JSON.stringify(toolInput);
            for (let i = 0; i < json.length && !interrupted; i += 60) {
              yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 60) } } } as SdkMsg;
              await sleep(opts.streamMs);
            }
          }
          yield assistant([{ type: 'tool_use', id, name, input: toolInput }]);
          let out = output;
          let isError = opts.isError === true;
          if (opts.ask || mode === 'default' && (name === 'Bash' || name === 'Edit' || name === 'Write')) {
            const r = await hooks.canUseTool(name, toolInput);
            if (r.behavior === 'deny') { out = `Пользователь отклонил: ${r.message ?? ''}`; isError = true; }
            else if (r.updatedInput !== undefined && name === 'AskUserQuestion') out = { ...(r.updatedInput as object), answers: (r.updatedInput as { answers?: unknown }).answers };
          }
          await sleep(opts.delay ?? 450);
          const u = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: typeof out === 'string' ? out : JSON.stringify(out) }] }, toolUseResult: out } as SdkMsg;
          log(u);
          yield u;
          ctxTokens += 1_900;
        }
        const result = (subtype = 'success'): SdkMsg => ({
          type: 'result', subtype, total_cost_usd: 0.0123 * Math.max(turns, 1), num_turns: turns + 1, duration_ms: Date.now() - started,
          usage: { input_tokens: 4200, output_tokens: 980, cache_read_input_tokens: 17_400 },
        } as SdkMsg);

        // ── сценарии ──
        if (/задач/i.test(text)) {
          // список задач (TaskCreate/TaskUpdate), как в Claude Code Desktop: полоска над полем ввода и панель «Задачи»
          yield* say('Разобью работу на задачи.');
          yield* tool('TaskCreate', { subject: 'Найти, где теряется ризонинг', description: '…', activeForm: 'Ищу, где теряется ризонинг' }, { task: { id: '1', subject: 'Найти, где теряется ризонинг' } }, { delay: 250 });
          yield* tool('TaskCreate', { subject: 'Сохранять текст размышлений', description: '…', activeForm: 'Сохраняю текст размышлений' }, { task: { id: '2', subject: 'Сохранять текст размышлений' } }, { delay: 250 });
          yield* tool('TaskCreate', { subject: 'Проверить на подставном шлюзе', description: '…', activeForm: 'Проверяю на подставном шлюзе' }, { task: { id: '3', subject: 'Проверить на подставном шлюзе' } }, { delay: 250 });
          yield* tool('TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true, taskId: '1', updatedFields: ['status'] }, { delay: 250 });
          yield* tool('TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'] }, { delay: 250 });
          yield* tool('TaskUpdate', { taskId: '2', status: 'in_progress' }, { success: true, taskId: '2', updatedFields: ['status'] }, { delay: 250 });
          yield* say('Первая готова, берусь за вторую.');
          // «долго» — ход висит, полоску видно в процессе
          for (let i = 0; i < 600 && !interrupted; i++) await sleep(100);
        } else if (/разреш/i.test(text)) {
          yield* say('Пересоберу клиент начисто — для этого нужно удалить старую сборку.');
          yield* tool('Bash', { command: 'rm -rf apps/desktop/dist-renderer && npm run build -w @perimeter/desktop', description: 'Удалить старую сборку и собрать клиент заново' },
            { stdout: 'vite v8.3.6 building client environment for production...\n✓ 49 modules transformed.\ndist-renderer/index.html   0.37 kB\n✓ built in 1.60s', stderr: '', interrupted: false }, { ask: true, delay: 900 });
          yield* say('Сборка прошла, бандл 391 КБ (117 КБ gzip).');
        } else if (/вопрос/i.test(text)) {
          yield* say('Прежде чем менять лейаут, уточню пару вещей.');
          yield* tool('AskUserQuestion', {
            questions: [
              { question: 'Где показывать диф правок?', header: 'Диф', multiSelect: false, options: [
                { label: 'В карточке', description: 'разворачивается прямо в ленте' },
                { label: 'В правой панели', description: 'лента остаётся компактной' },
                { label: 'Отдельной вкладкой', description: 'как в редакторе' },
              ] },
              { question: 'Какие уведомления включить?', header: 'Уведомления', multiSelect: true, options: [
                { label: 'Ход завершён' }, { label: 'Ждёт разрешения' }, { label: 'Ошибка сессии' },
              ] },
            ],
          }, 'ответ получен', { ask: true });
          yield* say('Принято, делаю так.');
        } else if (/ошибк/i.test(text)) {
          yield* tool('Bash', { command: 'npm run typecheck', description: 'Проверить типы' },
            { stdout: '> tsc -p tsconfig.json --noEmit\n', stderr: "apps/desktop/renderer/src/components/RightRail.tsx(70,73): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.", interrupted: false }, { isError: true });
          yield* say('Проверка типов упала на `RightRail.tsx:70` — `--p` ждёт число. Исправлю приведение и перезапущу.');
        } else if (/картин/i.test(text)) {
          yield* tool('Read', { file_path: '/opt/perimeter/docs/screens/three-pane.png' },
            { type: 'image', file: { base64: demoPng(), type: 'image/png', originalSize: 2048 } });
          yield* say('На скриншоте трёхпанельный лейаут: сайдбар 240 px, лента, правая панель 280 px.');
        } else if (/субагент/i.test(text)) {
          turns += 1;
          const taskId = `toolu_${randomUUID().slice(0, 12)}`;
          yield assistant([{ type: 'tool_use', id: taskId, name: 'Task', input: { description: 'Найти все места, где клиент читает getContextUsage', subagent_type: 'Explore', prompt: '…' } }]);
          for (const t of ['Ищу вызовы requestContext…', 'Нашёл: App.tsx и RightRail.tsx']) {
            await sleep(500);
            yield assistant([{ type: 'text', text: t }], taskId);
          }
          await sleep(400);
          const u = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: taskId, content: 'ok' }] }, toolUseResult: { status: 'completed', content: [{ type: 'text', text: 'Контекст запрашивается в App.tsx:47, разбирается в RightRail.tsx:5.' }], totalDurationMs: 1300, totalTokens: 5400, totalToolUseCount: 3 } } as SdkMsg;
          log(u);
          yield u;
          yield* say('Субагент нашёл два места — оба поправлю.');
        } else if (/делегир/i.test(text)) {
          const childId = randomUUID();
          yield* say('Механическую часть отдам воркеру на z.ai — сам займусь решением.');
          // настоящая дочерняя сессия: реестр, своя лента, event:session.created — UI видит всё живьём
          manager.create({
            id: childId, name: 'разведка GLM', cwd: sess.cwd, permissionMode: 'default', profile: 'zai',
            ...(sess.projectId !== undefined ? { projectId: sess.projectId } : {}),
            parentSessionId: sessionId, agentOf: 'delegate_to_agent',
            factory: scriptedFactory({ model: 'glm-5.3', permissionMode: 'acceptEdits', ...(sess.projectId !== undefined ? { projectId: sess.projectId } : {}) }, childId),
          });
          await sleep(500);
          manager.send(childId, 'Сделай обзор клиента');
          yield* tool('mcp__perimeter__delegate_to_agent', { account: 'zai', prompt: 'Сделай обзор клиента', name: 'разведка GLM' },
            { content: [{ type: 'text', text: 'Воркер «разведка GLM» запущен на аккаунте zai. Не жди его в этом ходе: продолжай свою работу — результат придёт отдельным сообщением.' }] },
            { ask: true, delay: 600 });
          yield* say('Не жду воркера — продолжаю своё, итог придёт сообщением.');
          await sleep(9000); // воркер работает в своей сессии (видно вложенной строкой и врезкой)
          if (sessionId !== undefined) {
            manager.send(sessionId, `[воркер «разведка GLM» · zai · 10 с · ходов 2 · сессия ${childId}]\nОбзор готов: три панели (лента, сайдбар, правая панель), кольцо контекста читается в App.tsx.`);
          }
        } else if (/файл/i.test(text)) {
          yield* say('Запишу новый модуль целиком.');
          const body = Array.from({ length: 160 }, (_, i) => `export const step${i} = (x: number): number => x * ${i + 1}; // шаг ${i}`).join('\n');
          yield* tool('Write', { file_path: `${cwd}/packages/supervisor/src/steps.ts`, content: body }, { type: 'create', filePath: `${cwd}/packages/supervisor/src/steps.ts` }, { streamMs: 25 });
          yield* say('Готово: модуль записан.');
        } else if (/долго/i.test(text)) {
          yield* say('Это длинный ответ, чтобы было время нажать Stop. '.repeat(40), 60);
        } else {
          yield assistant([{ type: 'thinking', thinking: 'Пользователь просит обзор клиента. Сначала найду компоненты, потом посмотрю, как разбирается снимок контекста — подозреваю несовпадение имён полей с SDK.' }]);
          yield* say('Посмотрю, как устроен клиент.');
          yield* tool('Glob', { pattern: 'apps/desktop/renderer/src/**/*.tsx' },
            { durationMs: 12, numFiles: 8, truncated: false, filenames: ['App.tsx', 'main.tsx', 'components/Sidebar.tsx', 'components/Feed.tsx', 'components/Composer.tsx', 'components/RightRail.tsx', 'components/SessionHeader.tsx', 'components/CreateDialog.tsx'].map((f) => `${cwd}/apps/desktop/renderer/src/${f}`) });
          yield* tool('Read', { file_path: `${cwd}/apps/desktop/renderer/src/components/RightRail.tsx`, limit: 12 },
            { type: 'text', file: { filePath: `${cwd}/apps/desktop/renderer/src/components/RightRail.tsx`, content: "import { useState } from 'react';\nimport type { SessionView, SupervisorClient } from '../supervisor';\n\n/** Извлечь проценты/токены из снимка getContextUsage */\nfunction ctxNumbers(d: Record<string, unknown> | undefined) {\n  if (!d) return null;\n  const pctRaw = d['usedPercentage'] ?? d['used_percentage'];\n  if (typeof pctRaw === 'number') return { pct: Math.round(pctRaw) };\n  return null;\n}\n", numLines: 10, startLine: 1, totalLines: 109 } });
          yield* tool('Grep', { pattern: 'percentage', path: 'packages/supervisor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', output_mode: 'content' },
            { mode: 'content', numFiles: 1, filenames: [], content: '4122:    percentage: number;\n4141:    rawMaxTokens: number;', numLines: 2 });
          yield* tool('Bash', { command: 'npm test', description: 'Прогнать тесты' },
            { stdout: ' ✓ packages/protocol/src/frames.spec.ts (7 tests) 13ms\n ✓ packages/supervisor/src/wss.spec.ts (4 tests) 1500ms\n\n Test Files  10 passed (10)\n      Tests  39 passed (39)', stderr: '', interrupted: false }, { delay: 1200 });
          const oldS = "  const pctRaw = d['usedPercentage'] ?? d['used_percentage'];\n  if (typeof pctRaw === 'number') return { pct: Math.round(pctRaw) };";
          const newS = "  const pct = d['percentage'];\n  if (typeof pct === 'number') return { pct: Math.round(pct) };";
          yield* tool('Edit', { file_path: `${cwd}/apps/desktop/renderer/src/components/RightRail.tsx`, old_string: oldS, new_string: newS },
            { filePath: `${cwd}/apps/desktop/renderer/src/components/RightRail.tsx`, oldString: oldS, newString: newS, originalFile: null, userModified: false, replaceAll: false,
              structuredPatch: [{ oldStart: 5, oldLines: 5, newStart: 5, newLines: 5, lines: [
                ' function ctxNumbers(d: Record<string, unknown> | undefined) {',
                '   if (!d) return null;',
                "-  const pctRaw = d['usedPercentage'] ?? d['used_percentage'];",
                "-  if (typeof pctRaw === 'number') return { pct: Math.round(pctRaw) };",
                "+  const pct = d['percentage'];",
                "+  if (typeof pct === 'number') return { pct: Math.round(pct) };",
                '   return null;',
              ] }] });
          yield* tool('Write', { file_path: `${cwd}/docs/notes.md`, content: '# Заметки\n\n- кольцо контекста: поле percentage\n- результаты инструментов: форматировать по типу\n' },
            { type: 'create', filePath: `${cwd}/docs/notes.md`, content: '# Заметки\n', structuredPatch: [] });
          yield* say([
            '## Итог',
            '',
            'Нашёл причину: клиент ищет `usedPercentage`, а SDK отдаёт **`percentage`**, `totalTokens` и `maxTokens`.',
            '',
            '- поправил разбор снимка в `RightRail.tsx`',
            '- записал заметки в `docs/notes.md`',
            '- тесты зелёные: **39/39**',
            '',
            '```ts',
            "const pct = d['percentage'];",
            "if (typeof pct === 'number') return { pct: Math.round(pct) };",
            '```',
            '',
            'Дальше можно заняться форматированием результатов инструментов.',
          ].join('\n'));
        }
        if (interrupted) { yield result('error_during_execution'); continue; }
        yield result();
      }
    }

    const g = run();
    return {
      [Symbol.asyncIterator]: () => g,
      interrupt: async () => { interrupted = true; },
      close: async () => { await g.return(undefined); },
      initializationResult: () => sleep(readyMs).then(() => ({})),
      setModel: async (m: string) => { model = m; },
      setPermissionMode: async (m: string) => { mode = m; },
      // усилие/ultracode на лету: на стенде просто принимаем (видно по ack и event:hello)
      applyFlagSettings: async () => undefined,
      getContextUsage: async () => ({
        totalTokens: ctxTokens, maxTokens: 200_000, rawMaxTokens: 200_000,
        percentage: (ctxTokens / 200_000) * 100, model,
        categories: [
          { id: 'system_prompt', name: 'System prompt', tokens: 3_100, color: '', kind: 'used' },
          { id: 'system_tools', name: 'System tools', tokens: 11_900, color: '', kind: 'used' },
          { id: 'mcp_tools', name: 'MCP tools', tokens: 2_400, color: '', kind: 'used' },
          { id: 'messages', name: 'Messages', tokens: ctxTokens - 17_400, color: '', kind: 'used' },
          { id: 'free_space', name: 'Free space', tokens: 200_000 - ctxTokens - 33_000, color: '', kind: 'free' },
          { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33_000, color: '', kind: 'buffer' },
        ],
      }),
    };
  };
}

/** Маленький PNG-градиент 96×64 (свой энкодер: без зависимостей). */
function demoPng(): string {
  const w = 96, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 40 + x * 2; raw[o + 1] = 60 + y * 2; raw[o + 2] = 140;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

// ─── сборка: профили, проекты, стартовые сессии ─────────────────────────────

const profilesFile = join(root, 'profiles.json');
// DEMO_LOGGED_OUT=1 — только аккаунт по умолчанию, не вошедший (свой компьютер, где есть лишь Claude Code Desktop)
writeFileSync(profilesFile, JSON.stringify({ version: 1, profiles: process.env['DEMO_LOGGED_OUT'] === '1' ? [] : [
  { name: 'yan', displayName: 'Claude · подписка', description: 'claude.ai', model: 'sonnet', defaultEffort: 'high', delegate: true },
  // шлюз z.ai: список моделей у провайдера (подделка ниже), 1M у GLM 5.3, усилия у GLM нет, ultracode выключен
  {
    name: 'zai', displayName: 'z.ai · GLM', description: 'api.z.ai', model: 'glm-5.3', long: ['glm-5.3'],
    ultracode: false,
    // демо-ключ (не настоящий): чтобы в настройках было видно поле «Ключ API» и подсказку «…demo»
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'demo-key-not-real-0000demo' },
  },
] }));
const profiles = ProfileRegistry.load(profilesFile);
// DEMO_LOGGED_OUT=1 — свой компьютер, где Claude Code не вошёл (как на маке с одним Claude Code Desktop):
// аккаунт по умолчанию виден «не вошёл», в сайдбаре — «Войти через claude.ai»
const demoLoggedOut = process.env['DEMO_LOGGED_OUT'] === '1';
if (demoLoggedOut) {
  profiles.keepBase = true;
  for (const p of [...profiles.list().map((x) => x.name), 'default']) profiles.setAuth(p, { loggedIn: false });
}
// MCP-серверы стенда (в памяти, см. accounts.mcpRun ниже)
const demoMcp = new Map<string, Record<string, unknown>>([
  ['context7', { type: 'http', url: 'https://mcp.context7.com/mcp' }],
  ['notion', { type: 'http', url: 'https://mcp.notion.com/mcp' }],
  ['broken', { type: 'http', url: 'https://down.example.com/mcp', headers: { Authorization: 'Bearer demo-secret' } }],
]);
const demoMcpAuthed = new Set<string>();
// «Claude Code» стенда: статичный список моделей вместо настоящего supportedModels()
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
// как ответил бы /v1/models: настоящие id, название провайдера, окно контекста, усилия
const demoModels: ModelInfoFrame[] = [
  { id: 'claude-opus-5-5', description: 'Claude Opus 5.5', efforts: [...ALL_EFFORTS], ctx: 1_000_000 },
  { id: 'claude-sonnet-5-5', description: 'Claude Sonnet 5.5', efforts: [...ALL_EFFORTS], ctx: 1_000_000 },
  { id: 'claude-haiku-5-5', description: 'Claude Haiku 5.5', efforts: [...ALL_EFFORTS], ctx: 1_000_000 },
  { id: 'claude-fable-5-2', description: 'Claude Fable 5.2', efforts: [...ALL_EFFORTS], ctx: 1_000_000 },
];
const demoGlm: ModelInfoFrame[] = [
  { id: 'glm-5.3', efforts: [] },
  { id: 'glm-5.3-flash', efforts: [] },
  { id: 'glm-4.7-air', efforts: [] },
];
// хранилище проектов стенда — временная папка; пара «ничьих» папок, чтобы в обзоре было что показать
const storageRoot = join(root, 'projects');
for (const d of ['scratch', 'old-bot']) mkdirSync(join(storageRoot, d), { recursive: true });
const projects = new ProjectStore(join(root, 'projects.json'), { defaultRoot: storageRoot });
// git стенда: клон — быстрый фейк (папка с .git и запомненным origin; адрес со словом fail — ошибка),
// остальное по склонированным фейком папкам — из памяти, по настоящим — настоящий git
const fakeOrigins = new Map<string, string>();
const gitOk = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });
const demoGit: GitRunner = async (args, opts) => {
  if (args[0] === 'clone') {
    const url = args[2] ?? '';
    const path = args[3] ?? '';
    await sleep(1200);
    if (/fail/i.test(url)) return { code: 128, stdout: '', stderr: `fatal: repository '${url}' not found`, timedOut: false };
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, 'README.md'), `# ${basename(path)}\n`);
    fakeOrigins.set(resolve(path), url);
    return gitOk('');
  }
  if (args[0] === '-C') {
    const origin = fakeOrigins.get(resolve(args[1] ?? ''));
    if (origin !== undefined) {
      const sub = args.slice(2).join(' ');
      if (sub === 'remote get-url origin') return gitOk(`${origin}\n`);
      if (sub === 'symbolic-ref --short HEAD') return gitOk('main\n');
      if (sub === 'status --porcelain') return gitOk('');
    }
  }
  return realGit(args, opts);
};
// DEMO_FLAVOR=local — играет «этот компьютер»: Windows-пути, свои сессии, только проект perimeter
const flavor = process.env.DEMO_FLAVOR === 'local' ? 'local' : 'vps';
// выпуск токена подписки на стенде: поддельный `claude setup-token` «возвращается из браузера» сам через секунду
process.env['FAKE_SETUP_AUTO'] ??= '1';
const manager = new DemoSessionManager(0);
const server = new WssServer(manager, {
  port, host: '127.0.0.1', profiles, projects, git: demoGit,
  // данные стенда (журнал, переезд) — во временной папке стенда, не в настоящем ~/.perimeter
  dataPaths: { thinkingFile: join(root, 'thinking.log'), rbProfileDir: join(root, 'rb-profile') },
  sessionFactory: (sess, id) => scriptedFactory(sess, id),
  modelsFetcher: async (name) => { await sleep(400); return { models: name === 'zai' ? demoGlm : demoModels, from: 'provider' as const }; },
  // лимиты стенда: z.ai — квота в кредитах, подписка — окна 5 часов и неделя (как из ответов API)
  usageFetcher: async (name) => {
    await sleep(300);
    const now = Date.now();
    if (name === 'zai') return { source: 'zai' as const, plan: 'max', at: now, windows: [
      { id: 'zai:5h', label: '5 часов', pct: 2, used: 780, limit: 28000, resetsAt: now + 3.2 * 3_600_000 },
      { id: 'zai:7d', label: 'неделя', pct: 25, used: 35455, limit: 140000, resetsAt: now + 4 * 86_400_000 },
    ] };
    return { source: 'claude' as const, plan: 'max', at: now, windows: [
      { id: 'five_hour', label: '5 часов', pct: 42, resetsAt: now + 2.4 * 3_600_000 },
      { id: 'seven_day', label: 'неделя', pct: 81, resetsAt: now + 3 * 86_400_000 },
      { id: 'seven_day_opus', label: 'неделя · Opus', pct: 93, resetsAt: now + 3 * 86_400_000 },
    ] };
  },
  // аккаунты из UI на стенде: вход — поддельный Claude Code (scripts/fake-claude.mjs; верный код goodcode#st1 —
  // перейдите во вкладке входа на https://platform.claude.com/oauth/code/callback?code=goodcode&state=st1),
  // проверка ключа — без сети: ключ со словом good — рабочий, иначе 429 · 1113 / 401
  accounts: {
    root: join(root, 'accounts'),
    login: { bin: [process.execPath, fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))], backend: 'pipe' },
    // MCP стенда: `claude mcp …` изображается в памяти — context7 подключён, notion ждёт входа (вход — поддельный
    // `claude mcp login`, адрес возврата с code=good), broken не подключается
    mcpRun: async (_bin, args, d) => {
      const dir = d ?? process.env.CLAUDE_CONFIG_DIR!;
      await sleep(args[1] === 'list' ? 900 : 300);
      // как настоящий Claude Code: серверы аккаунта — в .claude.json его папки (так UI отличает свои от чужих)
      mkdirSync(dir, { recursive: true });
      const file = join(dir, '.claude.json');
      let cur: { mcpServers?: Record<string, Record<string, unknown>> } = {};
      try { cur = JSON.parse(readFileSync(file, 'utf8')) as typeof cur; } catch { /* нет файла */ }
      if (!cur.mcpServers) cur.mcpServers = Object.fromEntries(demoMcp);
      const save = () => writeFileSync(file, JSON.stringify(cur, null, 2));
      if (args[1] === 'add-json') { cur.mcpServers[args[4]!] = JSON.parse(args[5]!) as Record<string, unknown>; save(); return { code: 0, out: 'Added' }; }
      if (args[1] === 'remove') { delete cur.mcpServers[args[4]!]; save(); return { code: 0, out: 'Removed' }; }
      save();
      const lines = Object.entries(cur.mcpServers).map(([n, c]) => {
        const st = n === 'broken' ? '✘ Failed to connect' : n === 'notion' && !demoMcpAuthed.has(n) && !existsSync(join(dir, `.mcp-auth-${n}`)) ? '! Needs authentication' : '✔ Connected';
        const target = (c['url'] as string | undefined) ?? [c['command'], ...((c['args'] as string[] | undefined) ?? [])].join(' ');
        return `${n}: ${target} (${c['url'] ? 'HTTP' : 'stdio'}) - ${st}`;
      });
      return { code: 0, out: ['Checking MCP server health…', '', ...lines, ''].join(String.fromCharCode(10)) };
    },
    checkKey: async (p) => {
      await sleep(500);
      if (/good/.test(p.apiKey)) return { ok: true, ms: 480, status: 200 };
      return p.baseUrl?.includes('z.ai')
        ? { ok: false, ms: 300, status: 429, message: '1113 Insufficient balance or no resource package' }
        : { ok: false, ms: 250, status: 401, message: 'authentication_error invalid x-api-key' };
    },
  },
});
const actualPort = await server.start();
void server.refreshStaleModels();
if (!demoLoggedOut) void server.refreshAuth();

const mk = (name: string, opts: { cwd: string; profile?: string; projectId?: string; model?: string; permissionMode?: string }) => {
  const id = randomUUID();
  return manager.create({ id, name, ...opts, factory: scriptedFactory(opts, id) });
};

// раньше здесь были /opt/perimeter, /root, C:\devs\revealyan\perimeter — теперь всё внутри DEMO_ROOT
if (flavor === 'local') {
  const local = DEMO_ROOT;
  const pLocal = projects.create({ name: 'perimeter', path: local });
  const l1 = mk('правка README', { cwd: local, projectId: pLocal.id });
  mk('эксперимент с пулом', { cwd: demoDir('packages', 'supervisor'), projectId: pLocal.id });
  await sleep(900);
  manager.send(l1, 'Сделай обзор клиента');
} else {
  const pCode = projects.create({ name: 'perimeter', path: DEMO_ROOT, profile: 'yan', model: 'sonnet' });
  projects.create({ name: 'конвейер', path: demoDir('packages', 'supervisor'), profile: 'zai' });
  const s1 = mk('редизайн клиента', { cwd: DEMO_ROOT, profile: 'yan', projectId: pCode.id, model: 'sonnet' });
  const s2 = mk('деплой на VPS', { cwd: DEMO_ROOT, profile: 'yan', projectId: pCode.id, model: 'sonnet' });
  mk('черновик идей', { cwd: demoDir('research'), profile: 'zai', model: 'glm-5.3[1m]' });
  const s4 = mk('старый эксперимент', { cwd: demoDir('docs') });
  manager.setArchived(s4, true);
  await sleep(900);
  manager.send(s1, 'Сделай обзор клиента и почини кольцо контекста');
  manager.send(s2, 'Пересобери клиент — нужно разрешение на удаление dist');
  // уснувшая сессия с историей: ход прошёл, процесс погашен — при выборе окно будит её заранее («просыпается…»)
  const s5 = mk('ночной рефакторинг', { cwd: DEMO_ROOT, profile: 'yan', projectId: pCode.id, model: 'sonnet' });
  manager.send(s5, 'Проверь типы — там ошибка');
  setTimeout(() => { void manager.stop(s5); }, 6000);
}

console.log(`demo-supervisor: ws://127.0.0.1:${actualPort} · данные ${root} · панели в ${DEMO_ROOT}`);
const chromium = findChromium();
console.log(chromium
  ? `удалённый браузер: ${chromium}`
  : 'удалённый браузер: Chromium/Chrome/Edge не найден — rb.open ответит RB_UNAVAILABLE (путь можно задать в PERIMETER_CHROMIUM)');
// server.stop гасит и терминалы панели
process.on('SIGINT', () => { void server.stop().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void server.stop().finally(() => process.exit(0)); });
