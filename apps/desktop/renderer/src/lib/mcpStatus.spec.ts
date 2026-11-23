import { describe, expect, it } from 'vitest';
import type { McpShared, McpSharedRow } from '../supervisor';
import { keepKnownStatuses } from './mcpStatus';

const row = (name: string, on: McpSharedRow['on'], target = `https://${name}.example/mcp`): McpSharedRow => ({
  name, transport: 'http', target, accountKey: false, stored: true, on,
});
const list = (...servers: McpSharedRow[]): McpShared => ({ targets: [{ id: 'a', profiles: ['a'] }, { id: 'b', profiles: ['b'] }], servers, other: [] });
const st = (status: McpSharedRow['on'][string]['status']) => ({ status, statusText: '' });

describe('keepKnownStatuses', () => {
  it('быстрый ответ без проверки не сбрасывает известные статусы', () => {
    const prev = list(row('web', { a: st('connected'), b: st('failed') }));
    const next = list(row('web', { a: st('unknown'), b: st('unknown') }));
    expect(keepKnownStatuses(prev, next).servers[0]!.on).toEqual({ a: st('connected'), b: st('failed') });
  });

  it('новый статус с проверкой важнее старого', () => {
    const prev = list(row('web', { a: st('connected') }));
    const next = list(row('web', { a: st('needs-auth') }));
    expect(keepKnownStatuses(prev, next).servers[0]!.on['a']).toEqual(st('needs-auth'));
  });

  it('сервер с другим адресом — статус не переносится (это уже другой сервер)', () => {
    const prev = list(row('web', { a: st('connected') }, 'https://old/mcp'));
    const next = list(row('web', { a: st('unknown') }, 'https://new/mcp'));
    expect(keepKnownStatuses(prev, next).servers[0]!.on['a']).toEqual(st('unknown'));
  });

  it('только что включённая цель — без выдуманного статуса; выключенная — пропадает', () => {
    const prev = list(row('web', { a: st('connected') }));
    const next = list(row('web', { b: st('unknown') }));
    expect(keepKnownStatuses(prev, next).servers[0]!.on).toEqual({ b: st('unknown') });
  });

  it('без прошлого списка — как есть', () => {
    const next = list(row('web', { a: st('unknown') }));
    expect(keepKnownStatuses(null, next)).toBe(next);
  });
});
