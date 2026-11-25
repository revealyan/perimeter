// Supervisor на серверах обновляется за приложением: при подключении, без идущих ходов, один раз на версию.
import { describe, expect, it } from 'vitest';
import { ServerAutoUpdate } from './server-autoupdate.mjs';

function harness({ statuses, packaged = true, enabled = true }) {
  const events = [];
  const installs = [];
  const timers = [];
  let n = 0;
  const au = new ServerAutoUpdate({
    installer: {
      status: async () => statuses[Math.min(n++, statuses.length - 1)],
      install: async (c) => { installs.push(c.id); return { ok: true, message: 'готово: 0.1.0-new' }; },
    },
    config: (id) => ({ id }),
    enabled: () => enabled,
    packaged,
    onEvent: (e) => events.push(e),
    setTimer: (f, ms) => timers.push({ f, ms }),
    settleMs: 1,
  });
  const fire = async () => { const t = timers.shift(); await t.f(); return t.ms; };
  return { au, events, installs, timers, fire };
}

const st = (over = {}) => ({ ok: true, managed: true, plan: 'update', busy: 0, appVersion: '0.1.0-new', ...over });
const up = [{ id: 'v', enabled: true, status: 'подключён' }];

describe('автообновление supervisor на сервере', () => {
  it('подключились, версия старее, ходов нет — обновляем один раз; переподключение той же версии — не трогаем', async () => {
    const h = harness({ statuses: [st(), st()] });
    h.au.onConnections(up);
    await h.fire();
    expect(h.installs).toEqual(['v']);
    expect(h.events.map((e) => e.state)).toEqual(['updating', 'done']);
    h.au.onConnections([{ ...up[0], status: 'подключаюсь…' }]);
    h.au.onConnections(up);
    await h.fire();
    expect(h.installs).toEqual(['v']);
  });

  it('идут ходы — ждём (одно сообщение) и пробуем снова через 2 мин; закончились — обновляем', async () => {
    const h = harness({ statuses: [st({ busy: 2 }), st({ busy: 1 }), st({ busy: 0 })] });
    h.au.onConnections(up);
    await h.fire();
    expect(await h.fire()).toBe(120_000);
    await h.fire();
    expect(h.installs).toEqual(['v']);
    expect(h.events.map((e) => e.state)).toEqual(['waiting', 'updating', 'done']);
  });

  it('не ставим: та же версия, не установщиком, выключено настройкой, сборка для разработки', async () => {
    for (const h of [harness({ statuses: [st({ plan: 'ok' })] }), harness({ statuses: [st({ managed: false })] }), harness({ statuses: [st()], enabled: false }), harness({ statuses: [st()], packaged: false })]) {
      h.au.onConnections(up);
      await h.fire();
      expect(h.installs).toEqual([]);
    }
  });
});
