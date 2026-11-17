import { describe, expect, it } from 'vitest';
import { chunkInput, clampSize, termDir, termTitle } from './termModel';

describe('терминал', () => {
  it('подпись под-вкладки: cwd относительно корня сессии', () => {
    expect(termTitle({ shell: '/bin/bash', cwd: '' }, '/opt/perimeter')).toBe('bash · /opt/perimeter');
    expect(termTitle({ shell: '/bin/bash', cwd: 'apps/desktop' }, '/opt/perimeter')).toBe('bash · /opt/perimeter/apps/desktop');
    expect(termTitle({ shell: 'powershell.exe', cwd: 'apps' }, 'C:\\devs\\perimeter')).toBe('powershell · C:\\devs\\perimeter\\apps');
    expect(termTitle({ shell: 'C:\\Windows\\System32\\cmd.exe', cwd: '' })).toBe('cmd');
    expect(termTitle({ shell: '', cwd: 'x' })).toBe('shell · ./x');
  });

  it('папка терминала без известного корня', () => {
    expect(termDir('', null)).toBe('');
    expect(termDir('sub', null)).toBe('./sub');
    expect(termDir('', '/opt/p')).toBe('/opt/p');
  });

  it('ввод режется под лимит кадра, суррогатные пары не рвутся', () => {
    expect(chunkInput('')).toEqual([]);
    expect(chunkInput('abc', 2)).toEqual(['ab', 'c']);
    const smile = '😀'; // две половинки
    const parts = chunkInput(`a${smile}b`, 2);
    expect(parts).toEqual(['a', smile, 'b']);
    expect(parts.join('')).toBe(`a${smile}b`);
  });

  it('размер в границах схемы', () => {
    expect(clampSize(0, 9999)).toEqual({ cols: 1, rows: 500 });
    expect(clampSize(NaN, 30.4)).toEqual({ cols: 80, rows: 30 });
  });
});
