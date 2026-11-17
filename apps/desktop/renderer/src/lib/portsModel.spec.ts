import { describe, expect, it } from 'vitest';
import { autoForwardPlan, localAddress, portRows } from './portsModel';
import type { PortInfo } from './panelData';
import { cdpButton, cdpModifiers, fitFrame, keyInput, rbAddress, rbViewport, toFramePoint, wheelDelta } from './remoteBrowser';

const listening: PortInfo[] = [
  { port: 5173, host: '127.0.0.1', process: 'node' },
  { port: 3000, host: '127.0.0.1', process: 'python3' },
  { port: 22, host: '0.0.0.0' },
  { port: 8790, host: '127.0.0.1', process: 'node' }, // сам supervisor
  { port: 6379, host: '127.0.0.1', process: 'redis-server' },
  { port: 9000, host: '0.0.0.0' }, // чужой процесс — имени не видно
];

describe('порты подключения', () => {
  it('строки: проброшенные первыми, потом dev-серверы, потом остальные; свой порт supervisor-а скрыт', () => {
    const rows = portRows(listening, [{ connId: 'vps', remotePort: 3000, localPort: 3000, url: 'http://127.0.0.1:3000' }], 'vps', [8790]);
    expect(rows.map((r) => r.port)).toEqual([3000, 5173, 22, 6379, 9000]);
    expect(rows[0]!.forward?.localPort).toBe(3000);
    expect(rows.find((r) => r.port === 5173)!.dev).toBe(true);
    expect(rows.find((r) => r.port === 9000)!.dev).toBe(false); // процесс неизвестен — не автопробрасываем
    expect(rows.find((r) => r.port === 6379)!.dev).toBe(false);
  });

  it('проброс остался, а сервер на той стороне уже не слушает — строка «не слушает»', () => {
    const rows = portRows([], [{ connId: 'vps', remotePort: 4000, localPort: 4001, url: 'http://127.0.0.1:4001' }], 'vps');
    expect(rows).toEqual([{ port: 4000, listening: false, dev: false, forward: { connId: 'vps', remotePort: 4000, localPort: 4001, url: 'http://127.0.0.1:4001' } }]);
  });

  it('пробросы другого подключения не смешиваются', () => {
    const rows = portRows(listening, [{ connId: 'c-2', remotePort: 5173, localPort: 5174, url: 'http://127.0.0.1:5174' }], 'vps', [8790]);
    expect(rows.find((r) => r.port === 5173)!.forward).toBeUndefined();
  });

  it('автопроброс: новые dev-серверы, кроме проброшенных и снятых руками', () => {
    const rows = portRows(listening, [{ connId: 'vps', remotePort: 3000, localPort: 3000, url: 'http://127.0.0.1:3000' }], 'vps', [8790]);
    expect(autoForwardPlan(rows, new Set())).toEqual([5173]);
    expect(autoForwardPlan(rows, new Set([5173]))).toEqual([]);
  });

  it('адрес для показа', () => {
    expect(localAddress('http://127.0.0.1:5173')).toBe('localhost:5173');
    expect(localAddress('http://localhost:3000/')).toBe('localhost:3000');
  });
});

describe('браузер на сервере', () => {
  it('адресная строка: адрес как есть, иначе поиск', () => {
    expect(rbAddress('localhost:3000')).toBe('localhost:3000');
    expect(rbAddress('example.com/path')).toBe('example.com/path');
    expect(rbAddress('https://x.y')).toBe('https://x.y');
    expect(rbAddress('10.0.0.5:8080')).toBe('10.0.0.5:8080');
    expect(rbAddress('как работает ssh')).toBe(`https://duckduckgo.com/?q=${encodeURIComponent('как работает ssh')}`);
    expect(rbAddress('perimeter')).toBe('https://duckduckgo.com/?q=perimeter');
    expect(rbAddress('  ')).toBe('about:blank');
  });

  it('кадр вписывается без растяжения', () => {
    expect(fitFrame({ w: 400, h: 300 }, { w: 800, h: 600 })).toEqual({ w: 400, h: 300 });
    expect(fitFrame({ w: 1000, h: 1000 }, { w: 800, h: 600 })).toEqual({ w: 800, h: 600 });
    expect(fitFrame({ w: 400, h: 600 }, { w: 800, h: 600 })).toEqual({ w: 400, h: 300 });
  });

  it('точка на картинке → координаты страницы (с учётом масштаба и краёв)', () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 };
    expect(toFramePoint({ x: 300, y: 200 }, rect, { w: 800, h: 600 })).toEqual({ x: 400, y: 300 });
    expect(toFramePoint({ x: 0, y: 0 }, rect, { w: 800, h: 600 })).toEqual({ x: 0, y: 0 });
    expect(toFramePoint({ x: 900, y: 900 }, rect, { w: 800, h: 600 })).toEqual({ x: 800, y: 600 });
  });

  it('клавиши: печатаемые с текстом, Enter — «\\r», Ctrl+V — вставкой, модификаторы битами CDP', () => {
    const base = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, keyCode: 0 };
    expect(keyInput({ ...base, key: 'ы', code: 'KeyS', keyCode: 83 }, 'down')).toEqual({ kind: 'key', type: 'down', key: 'ы', code: 'KeyS', text: 'ы', keyCode: 83 });
    expect(keyInput({ ...base, key: 'Enter', code: 'Enter', keyCode: 13 }, 'down')!.text).toBe('\r');
    expect(keyInput({ ...base, key: 'a', code: 'KeyA', ctrlKey: true }, 'down')).toEqual({ kind: 'key', type: 'down', key: 'a', code: 'KeyA', modifiers: 2 });
    expect(keyInput({ ...base, key: 'м', code: 'KeyV', ctrlKey: true }, 'down')).toBeNull();
    expect(keyInput({ ...base, key: 'a', code: 'KeyA' }, 'up')!.text).toBeUndefined();
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(cdpButton(2)).toBe('right');
  });

  it('колесо в пикселях; размер окна в пределах протокола', () => {
    expect(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800)).toEqual({ deltaX: 0, deltaY: 48 });
    expect(wheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 800)).toEqual({ deltaX: 0, deltaY: 800 });
    expect(rbViewport(100, 5000)).toEqual({ width: 320, height: 1600 });
  });
});
