// Локальный supervisor: один запуск, даже если окно просит «запустить» на каждое изменение статуса (23.11 — бесконечное
// моргание «запускается…/упал» из-за дублей процесса); события чужого процесса не трогают текущий.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { LocalSupervisor } from './local-sup.mjs';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

function harness({ prepareMs = 0, failPrepare = false } = {}) {
  const spawned = [];
  const killed = [];
  const statuses = [];
  let release;
  const gate = prepareMs > 0 ? new Promise((r) => { release = r; }) : Promise.resolve();
  const sup = new LocalSupervisor({
    prepare: async (onStatus) => {
      onStatus('докачиваю движок: 1/2 · 5 МБ');
      await gate;
      if (failPrepare) throw new Error('загрузка встала');
      return { args: ['supervisor.mjs'], cwd: '/x', env: {} };
    },
    spawnProc: () => { const c = fakeChild(); spawned.push(c); return c; },
    killTree: (c) => killed.push(c),
    onStatus: (s) => statuses.push(s),
  });
  return { sup, spawned, killed, statuses, release: () => release?.() };
}

describe('локальный supervisor', () => {
  it('пять «запустить» во время докачки — один процесс', async () => {
    const h = harness({ prepareMs: 1 });
    const calls = [h.sup.start(), h.sup.start(), h.sup.start(), h.sup.start(), h.sup.start()];
    h.release();
    await Promise.all(calls);
    expect(h.spawned).toHaveLength(1);
    // уже запущен — новые просьбы ничего не делают
    await h.sup.start();
    expect(h.spawned).toHaveLength(1);
  });

  it('статус: подготовка → запускается → запущен по строке ws://', async () => {
    const h = harness();
    await h.sup.start();
    h.spawned[0].stdout.emit('data', 'perimeter-supervisor v0.2.0: ws://127.0.0.1:8791');
    expect(h.statuses).toEqual(['докачиваю движок: 1/2 · 5 МБ', 'запускается…', 'запущен']);
  });

  it('упал — статус с причиной; следующий «запустить» поднимает заново', async () => {
    const h = harness();
    await h.sup.start();
    h.spawned[0].stderr.emit('data', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:8791');
    h.spawned[0].emit('exit', 1);
    expect(h.sup.status).toBe('упал (код 1): Error: listen EADDRINUSE: address already in use 127.0.0.1:8791');
    await h.sup.start();
    expect(h.spawned).toHaveLength(2);
  });

  it('остановленный процесс, выходя, не пишет «упал» и не трогает новый', async () => {
    const h = harness();
    await h.sup.start();
    const old = h.spawned[0];
    h.sup.stop();
    expect(h.killed).toEqual([old]);
    await h.sup.start();
    old.emit('exit', 1); // старый процесс вышел уже после нового запуска
    expect(h.sup.status).toBe('запускается…');
    expect(h.sup.proc).toBe(h.spawned[1]);
  });

  it('«стоп» во время докачки — процесс не запускается', async () => {
    const h = harness({ prepareMs: 1 });
    const p = h.sup.start();
    h.sup.stop();
    h.release();
    await p;
    expect(h.spawned).toHaveLength(0);
    expect(h.sup.status).toBe('остановлен');
  });

  it('докачка не удалась — понятный статус, повтор возможен', async () => {
    const h = harness({ failPrepare: true });
    await h.sup.start();
    expect(h.sup.status).toBe('движок не установился: загрузка встала');
    expect(h.spawned).toHaveLength(0);
  });
});
