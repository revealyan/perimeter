// Инварианты протокола (docs/p0-design.md §5: п.5 — схема и прямая совместимость)
import { describe, expect, it } from 'vitest';
import {
  CmdSchema, EventSchema, KNOWN_CMD_TYPES, KNOWN_EVENT_TYPES,
  PROTOCOL_VERSION, isCmd, isEvent, makeAck, makeErr, parseFrame,
} from './frames.js';

const ts = 1794200000000;
const sid = '4265f11d-e860-47ad-9b54-306e22e68390';

const cmdSamples = [
  { v: PROTOCOL_VERSION, ts, id: 'c1', type: 'cmd:hello', lastSeq: { [sid]: 42 } },
  { v: PROTOCOL_VERSION, ts, id: 'c2', type: 'cmd:session.list' },
  { v: PROTOCOL_VERSION, ts, id: 'c3', type: 'cmd:session.new', name: 'прогон', model: 'glm-5.3[1m]' },
  { v: PROTOCOL_VERSION, ts, id: 'c4', type: 'cmd:session.open', sessionId: sid },
  { v: PROTOCOL_VERSION, ts, id: 'c5', sessionId: sid, type: 'cmd:message.send', text: 'погнали' },
  { v: PROTOCOL_VERSION, ts, id: 'c6', type: 'cmd:permission.respond', requestId: 'p1', behavior: 'allow' },
  { v: PROTOCOL_VERSION, ts, id: 'c7', sessionId: sid, type: 'cmd:interrupt' },
  { v: PROTOCOL_VERSION, ts, id: 'c10', sessionId: sid, type: 'cmd:session.fork' },
  { v: PROTOCOL_VERSION, ts, id: 'c8', type: 'cmd:transcript.get', afterUuid: 'u-1' },
  { v: PROTOCOL_VERSION, ts, id: 'c9', sessionId: sid, type: 'cmd:session.stop' },
  { v: PROTOCOL_VERSION, ts, id: 'c9w', sessionId: sid, type: 'cmd:session.wake' },
  { v: PROTOCOL_VERSION, ts, id: 'k1', type: 'cmd:keys.list' },
  { v: PROTOCOL_VERSION, ts, id: 'k2', type: 'cmd:keys.create' },
  { v: PROTOCOL_VERSION, ts, id: 'k3', type: 'cmd:keys.check' },
  { v: PROTOCOL_VERSION, ts, id: 'm1', type: 'cmd:migrate.inventory' },
] as const;

const eventSamples = [
  { v: PROTOCOL_VERSION, ts, seq: 0, type: 'event:hello', server: { version: '0.1.0', uptimeMs: 5 }, sessions: [{ id: sid, name: 'сессия', state: 'idle' }] },
  { v: PROTOCOL_VERSION, ts, seq: 1, sessionId: sid, type: 'event:session.state', state: 'working' },
  { v: PROTOCOL_VERSION, ts, seq: 0, type: 'event:session.created', session: { id: sid, name: 'сабагент · прогон', state: 'creating', profile: 'zai', parentSessionId: sid, agentOf: 'delegate_to_agent' } },
  { v: PROTOCOL_VERSION, ts, seq: 2, sessionId: sid, type: 'event:session.init', tools: ['Bash'], mcpServers: [{ name: 'serena', status: 'pending' }], model: 'glm-5.3[1m]', permissionMode: 'auto' },
  { v: PROTOCOL_VERSION, ts, seq: 3, sessionId: sid, type: 'event:message.assistant', messageId: 'msg_1', block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } } },
  { v: PROTOCOL_VERSION, ts, seq: 4, sessionId: sid, type: 'event:stream.delta', kind: 'text', delta: 'при' },
  { v: PROTOCOL_VERSION, ts, seq: 5, sessionId: sid, type: 'event:message.user', toolUseId: 't1', toolName: 'Bash', result: { stdout: 'a\nb', exitCode: 0 } },
  { v: PROTOCOL_VERSION, ts, seq: 6, sessionId: sid, type: 'event:permission.request', requestId: 'p1', toolName: 'Bash', input: { command: 'rm -rf /' } },
  { v: PROTOCOL_VERSION, ts, seq: 7, sessionId: sid, type: 'event:permission.result', requestId: 'p1', behavior: 'deny' },
  { v: PROTOCOL_VERSION, ts, seq: 8, sessionId: sid, type: 'event:turn.result', subtype: 'success', totalCostUsd: 0.02, numTurns: 3, modelUsage: { 'glm-5.3[1m]': { inputTokens: 100, outputTokens: 50 } } },
  { v: PROTOCOL_VERSION, ts, seq: 9, sessionId: sid, type: 'event:subagent.start', parentToolUseId: 't2', agentType: 'Explore' },
  { v: PROTOCOL_VERSION, ts, seq: 10, sessionId: sid, type: 'event:subagent.message', parentToolUseId: 't2', kind: 'text' },
  { v: PROTOCOL_VERSION, ts, seq: 11, sessionId: sid, type: 'event:subagent.stop', parentToolUseId: 't2' },
  { v: PROTOCOL_VERSION, ts, seq: 12, sessionId: sid, type: 'event:error', code: 'RESYNC_NEEDED', message: 'дыра глубже ринг-буфера' },
] as const;

describe('протокол v1', () => {
  it('все образцы команд проходят валидацию', () => {
    for (const s of cmdSamples) {
      const r = parseFrame(s);
      expect(r.ok && !('unknownType' in r) && isCmd(r.frame!)).toBe(true);
    }
    expect(cmdSamples.every((s) => CmdSchema.safeParse(s).success)).toBe(true);
  });

  it('все образцы событий проходят валидацию', () => {
    for (const s of eventSamples) {
      const r = parseFrame(s);
      expect(r.ok && !('unknownType' in r) && isEvent(r.frame!)).toBe(true);
    }
    expect(eventSamples.every((s) => EventSchema.safeParse(s).success)).toBe(true);
  });

  it('ack/err парсятся как ответы', () => {
    expect(parseFrame(makeAck('c1', { ok: 1 })).ok).toBe(true);
    const e = parseFrame(makeErr('c2', 'SESSION_NOT_FOUND', 'нет такой сессии'));
    expect(e.ok).toBe(true);
  });

  it('неизвестный type не роняет парсер (прямая совместимость)', () => {
    const r = parseFrame({ v: PROTOCOL_VERSION, ts, seq: 99, type: 'event:из-будущего' });
    expect(r.ok && 'unknownType' in r && r.unknownType).toBe('event:из-будущего');
  });

  it('чужая версия протокола → VERSION', () => {
    const r = parseFrame({ v: 2, ts, type: 'cmd:session.list', id: 'x' });
    expect(!r.ok && r.code === 'VERSION').toBe(true);
  });

  it('сабагентские поля: summary принимает, кривой parentSessionId — нет', () => {
    // hello с дочерней сессией проходит
    const ok = EventSchema.parse({
      v: PROTOCOL_VERSION, ts, seq: 0, type: 'event:hello',
      server: { version: '0.1.0', uptimeMs: 1 },
      sessions: [{ id: sid, name: 'воркер', state: 'idle', profile: 'zai', parentSessionId: sid, agentOf: 'delegate_to_agent' }],
    });
    expect(ok.type === 'event:hello' && ok.sessions[0]!.parentSessionId).toBe(sid);
    // не-uuid в parentSessionId роняет схему — сервер обязан валидировать перед отправкой
    const bad = EventSchema.safeParse({
      v: PROTOCOL_VERSION, ts, seq: 0, type: 'event:session.created',
      session: { id: sid, name: 'воркер', state: 'idle', parentSessionId: 'не-uuid' },
    });
    expect(bad.success).toBe(false);
  });

  it('delegate у профиля: cmd:profile.update и profileInfo принимают', () => {
    expect(parseFrame({ v: PROTOCOL_VERSION, ts, id: 'c20', type: 'cmd:profile.update', profile: 'yan', delegate: true }).ok).toBe(true);
  });

  it('битой схеме — SCHEMA, не исключение', () => {
    // у события нет обязательного seq
    const r = parseFrame({ v: PROTOCOL_VERSION, ts, sessionId: sid, type: 'event:session.state', state: 'idle' });
    expect(!r.ok && r.code === 'SCHEMA').toBe(true);
    expect(parseFrame('мусор').ok).toBe(false);
  });

  it('KNOWN-списки совпадают с дискриминантами союзов (схема не разъехалась)', () => {
    const cmdTypes = (CmdSchema as unknown as { options: Array<{ shape: { type: { value: string } } }> })
      .options.map((o) => o.shape.type.value).sort();
    const eventTypes = (EventSchema as unknown as { options: Array<{ shape: { type: { value: string } } }> })
      .options.map((o) => o.shape.type.value).sort();
    expect(cmdTypes).toEqual([...KNOWN_CMD_TYPES].sort());
    expect(eventTypes).toEqual([...KNOWN_EVENT_TYPES].sort());
  });
});
