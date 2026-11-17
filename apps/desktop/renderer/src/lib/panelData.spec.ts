import { describe, expect, it } from 'vitest';
import { panelErrorText, parseFsList, parseFsRead, parseGitStatus, parseNetPorts, parseTermInfo, parseTermList } from './panelData';

describe('разбор ack панелей', () => {
  it('пустой ack (сервер не знает команду) → null', () => {
    for (const p of [parseFsList, parseFsRead, parseGitStatus, parseNetPorts, parseTermInfo, parseTermList]) {
      expect(p(undefined)).toBeNull();
      expect(p({})).toBeNull();
    }
  });

  it('fs.list: мусорные записи отбрасываются, kind по умолчанию — file', () => {
    expect(parseFsList({ root: '/opt/x', path: '', entries: [{ name: 'a', kind: 'dir' }, { name: '' }, { name: '..', kind: 'dir' }, { name: 'b.ts', size: 12 }, null] })).toEqual({
      root: '/opt/x', path: '', entries: [{ name: 'a', kind: 'dir', size: 0, mtimeMs: 0 }, { name: 'b.ts', kind: 'file', size: 12, mtimeMs: 0 }], truncated: false, total: 2,
    });
    expect(parseFsList({ entries: [], truncated: true, total: 5000 })).toMatchObject({ truncated: true, total: 5000 });
  });

  it('fs.read: бинарный без content — тоже ответ', () => {
    expect(parseFsRead({ path: 'a.png', size: 2048, truncated: false, binary: true, content: '' })?.binary).toBe(true);
    expect(parseFsRead({ path: 'a.png', size: 2048, binary: true })?.content).toBe('');
    expect(parseFsRead({ path: 'a.ts', content: 'x', truncated: true })).toEqual({ path: 'a.ts', size: 1, truncated: true, binary: false, content: 'x' });
  });

  it('git.status: пустая ветка → null', () => {
    expect(parseGitStatus({ root: '/r', branch: '', files: [{ path: 'a', status: 'M' }, { status: '??' }] })).toEqual({ root: '/r', branch: null, files: [{ path: 'a', status: 'M' }] });
  });

  it('net.ports: невалидные порты отбрасываются', () => {
    expect(parseNetPorts({ ports: [{ port: 5173, host: '::1', process: 'node' }, { port: 0 }, { port: 'x' }, { port: 3000, host: '0.0.0.0' }] })).toEqual([
      { port: 5173, host: '::1', process: 'node' }, { port: 3000, host: '0.0.0.0' },
    ]);
  });

  it('term: режим по умолчанию pty, alive по умолчанию true, scrollback — если есть', () => {
    expect(parseTermInfo({ termId: 't1', mode: 'pipe', shell: 'bash', cwd: '/x', scrollback: 'hi' })).toEqual({ termId: 't1', mode: 'pipe', shell: 'bash', cwd: '/x', alive: true, scrollback: 'hi' });
    expect(parseTermList({ terms: [{ termId: 't1', alive: false, exitCode: 3 }, { shell: 'x' }] })).toEqual([{ termId: 't1', mode: 'pty', shell: '', cwd: '', alive: false, exitCode: 3 }]);
  });

  it('тексты ошибок', () => {
    const err = (code: string, message = '') => Object.assign(new Error(message), { code });
    expect(panelErrorText(err('OFFLINE', 'x'))).toBe('нет связи с supervisor');
    expect(panelErrorText(err('OUTSIDE_ROOT'))).toBe('путь вне папки сессии');
    expect(panelErrorText(err('UNSUPPORTED', 'сервер не поддерживает терминал'))).toBe('сервер не поддерживает терминал');
    expect(panelErrorText(err('EACCES', 'нет доступа'))).toBe('нет доступа');
  });
});
