// Подставной Anthropic-совместимый шлюз для живых проверок без токенов и сети: настоящий Claude Code ходит сюда
// (ANTHROPIC_BASE_URL), каждый запрос /v1/messages записывается — видно, что реально уходит в API: max_tokens,
// thinking, effort, список инструментов. Отвечает коротким текстом (стрим SSE или JSON).
import { createServer, type IncomingMessage } from 'node:http';

export interface CapturedRequest {
  path: string;
  model?: string;
  maxTokens?: number;
  thinking?: unknown;
  /** всё про усилие/вывод, что нашлось в теле (output_config, effort и т. п.) */
  extra: Record<string, unknown>;
  tools: string[];
  stream: boolean;
  betas: string;
  body: Record<string, unknown>;
}

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => resolve(s));
});

export async function startFakeGateway(opts: { reply?: string; /** перед текстом — блок размышлений с подписью */ thinking?: string; /** доп. заголовки ответа /v1/messages (лимиты подписки и т. п.) */ headers?: Record<string, string> } = {}): Promise<{ url: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const reply = opts.reply ?? 'ок';
  const srv = createServer(async (req, res) => {
    const raw = await readBody(req);
    const path = (req.url ?? '').split('?')[0] ?? '';
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw || '{}') as Record<string, unknown>; } catch { /* не JSON */ }
    if (path.endsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (!path.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: path } }));
      return;
    }
    const extra: Record<string, unknown> = {};
    for (const k of Object.keys(body)) if (/effort|output_config|reasoning/i.test(k)) extra[k] = body[k];
    const tools = Array.isArray(body['tools']) ? (body['tools'] as Array<{ name?: string }>).map((t) => t.name ?? '?') : [];
    const stream = body['stream'] === true;
    requests.push({
      path,
      ...(typeof body['model'] === 'string' ? { model: body['model'] } : {}),
      ...(typeof body['max_tokens'] === 'number' ? { maxTokens: body['max_tokens'] } : {}),
      ...(body['thinking'] !== undefined ? { thinking: body['thinking'] } : {}),
      extra, tools, stream,
      betas: String(req.headers['anthropic-beta'] ?? ''),
      body,
    });
    const id = `msg_fake_${requests.length}`;
    const model = String(body['model'] ?? 'fake');
    const usage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json', ...(opts.headers ?? {}) });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(opts.headers ?? {}) });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
    let idx = 0;
    if (opts.thinking !== undefined) {
      send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: `${opts.thinking} #${requests.length}` } });
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: `sig-fake-${requests.length}-${'x'.repeat(40)}` } });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
      idx++;
    }
    send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: reply } });
    send('content_block_stop', { type: 'content_block_stop', index: idx });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}
