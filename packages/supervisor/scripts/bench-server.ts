// Бенчмарк-сервер: WSS + менеджер с мок-фабрикой, льёт BENCH_COUNT событий подряд.
import { SessionManager } from '../src/session/manager.js';
import { WssServer } from '../src/wss.js';
import type { EngineHooks } from '../src/session/engine.js';
import type { QueryLike, SdkMsg, SdkUserInput } from '../src/session/types.js';

const port = Number(process.env.BENCH_PORT ?? 8799);
const count = Number(process.env.BENCH_COUNT ?? 5000);
const text = process.env.BENCH_TEXT ?? 'a'.repeat(200);

const sessionFactory = (): ((input: AsyncIterable<SdkUserInput>, hooks: EngineHooks) => QueryLike) =>
  (input: AsyncIterable<SdkUserInput>): QueryLike => {
    void (async () => { for await (const _ of input) void _; })().catch(() => undefined);
    const g = (async function* (): AsyncGenerator<SdkMsg> {
      yield { type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-000000000001', tools: [], mcp_servers: [], model: 'bench', permissionMode: 'auto' } as SdkMsg;
      for (let i = 0; i < count; i++) {
        yield { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: `${text} #${i}` }] } } as SdkMsg;
      }
      await new Promise(() => undefined); // держим процесс
    })();
    return { [Symbol.asyncIterator]: () => g, interrupt: async () => undefined };
  };

const manager = new SessionManager(0);
const server = new WssServer(manager, {
  port,
  host: '127.0.0.1',
  ringCapacity: 5000,
  sessionFactory,
});
const actualPort = await server.start();
console.log(`bench-server: ws://127.0.0.1:${actualPort} (${count} событий)`);
process.on('SIGTERM', () => { void server.stop().finally(() => process.exit(0)); });
