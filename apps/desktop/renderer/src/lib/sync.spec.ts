import { describe, expect, it } from 'vitest';
import { guessPath, splitPath } from './sync';

describe('синк проектов: догадка о папке', () => {
  it('splitPath понимает Windows и POSIX', () => {
    expect(splitPath('C:\\devs\\revealyan\\perimeter')).toEqual({ dir: 'C:\\devs\\revealyan', base: 'perimeter', sep: '\\' });
    expect(splitPath('/opt/pipeline')).toEqual({ dir: '/opt', base: 'pipeline', sep: '/' });
  });
  it('VPS-проект на Windows: рядом с известным локальным, с именем папки с VPS', () => {
    expect(guessPath({ otherPath: '/opt/pipeline' }, [{ path: 'C:\\devs\\revealyan\\perimeter' }])).toBe('C:\\devs\\revealyan\\pipeline');
  });
  it('локальный проект на VPS: рядом с известным серверным', () => {
    expect(guessPath({ otherPath: 'C:\\devs\\notes' }, [{ path: '/opt/perimeter' }])).toBe('/opt/notes');
  });
  it('нет ни одного проекта здесь — догадки нет (а не чужой путь)', () => {
    expect(guessPath({ otherPath: '/opt/pipeline' }, [])).toBe('');
  });
});
