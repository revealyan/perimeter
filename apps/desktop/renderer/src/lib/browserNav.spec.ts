import { describe, expect, it } from 'vitest';
import {
  EMPTY_HISTORY, back, canBack, canForward, currentUrl, displayUrl, forward, navigate, normalizeBrowserState,
  normalizeUrl, portOf, portSuggestions, previewPlan, procName, rebase,
} from './browserNav';

describe('история панели', () => {
  it('назад/вперёд, переход отбрасывает «вперёд», повтор адреса не растит историю', () => {
    let h = navigate(EMPTY_HISTORY, 'a');
    h = navigate(h, 'b');
    h = navigate(h, 'b');
    expect(h.list).toEqual(['a', 'b']);
    h = back(h);
    expect(currentUrl(h)).toBe('a');
    expect(canBack(h)).toBe(false);
    expect(canForward(h)).toBe(true);
    h = navigate(h, 'c');
    expect(h.list).toEqual(['a', 'c']);
    expect(canForward(h)).toBe(false);
    expect(forward(h)).toBe(h);
    expect(currentUrl(EMPTY_HISTORY)).toBeNull();
  });

  it('битое состояние из localStorage — по умолчанию, индекс в границах', () => {
    expect(normalizeBrowserState(null)).toEqual({ history: { list: [], index: -1 }, device: 'desktop' });
    expect(normalizeBrowserState({ history: { list: ['a', 1, 'b'], index: 9 }, device: 'phone' })).toEqual({ history: { list: ['a', 'b'], index: 1 }, device: 'phone' });
  });
});

describe('адресная строка', () => {
  it('порт и путь → localhost', () => {
    expect(normalizeUrl('5173')).toBe('http://localhost:5173/');
    expect(normalizeUrl(':3000/api?x=1')).toBe('http://localhost:3000/api?x=1');
    expect(normalizeUrl('70000')).toBeNull();
  });
  it('схема по умолчанию: локальные — http, домены — https', () => {
    expect(normalizeUrl('localhost:5173/x')).toBe('http://localhost:5173/x');
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('http://localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('два слова')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
  it('показ и порт', () => {
    expect(displayUrl('http://localhost:5173/')).toBe('localhost:5173');
    expect(displayUrl('http://localhost:5173/a/')).toBe('localhost:5173/a/');
    expect(displayUrl('https://example.com/')).toBe('https://example.com/');
    expect(portOf('http://localhost:5173/')).toBe(5173);
    expect(portOf('http://localhost/')).toBe(80);
    expect(portOf('нет')).toBeNull();
  });
});

describe('как открыть превью', () => {
  it('VPS: локальный порт — через туннель, если умеем; иначе напрямую', () => {
    expect(previewPlan('http://localhost:5173/', 'vps', true)).toEqual({ kind: 'forward', port: 5173 });
    expect(previewPlan('http://127.0.0.1:3000/x', 'vps', false)).toEqual({ kind: 'direct', reason: 'no-tunnel' });
    expect(previewPlan('http://localhost:5173/', 'local', true)).toEqual({ kind: 'direct', reason: 'local' });
    expect(previewPlan('https://example.com/', 'vps', true)).toEqual({ kind: 'direct', reason: 'external' });
  });
  it('rebase сохраняет путь, запрос и якорь', () => {
    expect(rebase('http://localhost:5173/a/b?x=1#h', 'http://127.0.0.1:51234')).toBe('http://127.0.0.1:51234/a/b?x=1#h');
  });
});

describe('подсказки портов', () => {
  it('без дублей, системных, исключённых и явно не dev-процессов; с известным процессом — первыми', () => {
    const out = portSuggestions([
      { port: 22, host: '0.0.0.0', process: 'sshd' },
      { port: 8790, host: '127.0.0.1', process: 'node' },
      { port: 6379, host: '127.0.0.1', process: 'redis-server' },
      { port: 5040, host: '0.0.0.0', process: 'svchost.exe' },
      { port: 9000, host: '0.0.0.0' },
      { port: 5173, host: '::1' },
      { port: 5173, host: '127.0.0.1', process: 'C:\\Program Files\\nodejs\\node.exe' },
      { port: 3000, host: '0.0.0.0', process: 'python3.12' },
    ], [8790]);
    expect(out.map((p) => p.port)).toEqual([3000, 5173, 9000]);
    expect(procName(out[1]!.process)).toBe('node');
  });
});
