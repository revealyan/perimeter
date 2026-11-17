// Фейковый CDP для тестов удалённого браузера (rbrowser.spec, wss-rb.spec): WebSocket-сервер,
// который отвечает на нужные команды и шлёт события вкладке. В рабочий код не входит.

import { WebSocketServer, type WebSocket } from 'ws';
import type { LaunchedBrowser } from './rbrowser.js';

export type Call = { method: string; params: Record<string, unknown>; sessionId?: string };

/** Фейковый CDP: отвечает на нужные команды, умеет слать события вкладке. */
export async function fakeCdp() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const port = (wss.address() as { port: number }).port;
  const calls: Call[] = [];
  let sock: WebSocket | null = null;
  let tabN = 0;
  const history: Array<{ id: number; url: string; title: string }> = [{ id: 1, url: 'about:blank', title: '' }];
  let cur = 0;
  wss.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
      calls.push({ method: m.method, params: m.params, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
      let result: Record<string, unknown> = {};
      switch (m.method) {
        case 'Target.createTarget': result = { targetId: `T${++tabN}` }; break;
        case 'Target.attachToTarget': result = { sessionId: `S-${String(m.params['targetId'])}` }; break;
        case 'Page.getNavigationHistory': result = { currentIndex: cur, entries: history }; break;
        case 'Page.navigate': {
          const url = String(m.params['url']);
          history.splice(cur + 1);
          history.push({ id: history.length + 1, url, title: `стр ${history.length + 1}` });
          cur = history.length - 1;
          setTimeout(() => {
            event('Page.frameNavigated', { frame: { id: 'f', url } }, m.sessionId);
            event('Page.loadEventFired', {}, m.sessionId);
          }, 5);
          break;
        }
        case 'Page.navigateToHistoryEntry': cur = history.findIndex((h) => h.id === m.params['entryId']); break;
      }
      ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    });
  });
  const event = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    sock?.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  let exit!: () => void;
  let killed = 0;
  const exited = new Promise<void>((r) => { exit = r; });
  const launched: LaunchedBrowser = { wsUrl: `ws://127.0.0.1:${port}/devtools/browser/x`, kill: () => { killed++; exit(); }, exited };
  return {
    calls, event, launcher: async () => launched, crash: () => { exit(); sock?.close(); },
    frame: (sessionId: string, ack: number, data = 'SlBFRw==') => event('Page.screencastFrame', { data, sessionId: ack, metadata: { deviceWidth: 800, deviceHeight: 600 } }, sessionId),
    killed: () => killed,
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
}

