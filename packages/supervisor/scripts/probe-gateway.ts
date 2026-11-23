// Живая проверка через подставной шлюз: настоящий Claude Code (CLI из Agent SDK) + наш sdkFactory.
// Печатает, что уходит в API: max_tokens, thinking, усилие, инструменты задач.
// Запуск: npx tsx packages/supervisor/scripts/probe-gateway.ts [сценарий]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session/manager.js';
import { sdkFactory, type SdkSessionOptions } from '../src/session/sdk.js';
import { startFakeGateway, type CapturedRequest } from './fake-gateway.js';

export async function probe(
  opts: Omit<SdkSessionOptions, 'cwd' | 'env'> & { env?: Record<string, string> },
  steps: Array<{ send?: string; flags?: Record<string, unknown> }>,
): Promise<CapturedRequest[]> {
  const gw = await startFakeGateway();
  const home = mkdtempSync(join(tmpdir(), 'pm-probe-'));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: 'fake-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    ...(opts.env ?? {}),
  };
  const m = new SessionManager();
  let turns = 0;
  m.subscribe((e) => {
    if (e.type === 'event:turn.result') turns++;
    if (e.type === 'event:error') console.error('ERR', e.code, e.message.slice(0, 200));
  });
  const id = m.create({ name: 'probe', cwd: home, factory: sdkFactory({ ...opts, cwd: home, env, includePartialMessages: false }) });
  const wait = async (n: number) => { const t0 = Date.now(); while (turns < n && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 100)); };
  let want = 0;
  for (const s of steps) {
    if (s.flags) await m.setFlags(id, s.flags as never);
    if (s.send) { m.send(id, s.send); want++; await wait(want); }
  }
  await m.stop(id);
  await gw.close();
  rmSync(home, { recursive: true, force: true });
  return gw.requests.filter((r) => r.path.endsWith('/v1/messages'));
}

const show = (rs: CapturedRequest[]) => rs.map((r) => ({
  model: r.model, max_tokens: r.maxTokens, thinking: JSON.stringify(r.thinking), extra: JSON.stringify(r.extra),
  todo: r.tools.filter((t) => /Todo|Task/.test(t)).join(','), tools: r.tools.length,
}));

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv[2] ?? 'base';
  const model = process.env.PROBE_MODEL ?? 'glm-5.4';
  if (which === 'base') {
    console.table(show(await probe({ model }, [{ send: 'привет' }])));
  } else if (which === 'effort') {
    console.table(show(await probe({ model, effort: 'xhigh' }, [{ send: 'привет' }])));
  } else if (which === 'max') {
    console.table(show(await probe({ model, effort: 'xhigh', env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000' } }, [{ send: 'привет' }])));
  } else if (which === 'todo') {
    console.table(show(await probe({ model, env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } }, [{ send: 'привет' }])));
  } else if (which === 'opus') {
    console.table(show(await probe({ model: 'claude-opus-5-5', effort: 'xhigh' }, [{ send: 'привет' }])));
  }
  process.exit(0);
}
