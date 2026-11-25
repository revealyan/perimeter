// Браузер ищется при каждом запуске (а не раз при старте supervisor'а): поставили кнопкой «Браузер на сервере» —
// следующая вкладка его находит без перезапуска службы.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromiumLauncher } from './rbrowser.js';

const saved = process.env['PERIMETER_CHROMIUM'];
const dirs: string[] = [];
afterEach(() => {
  if (saved === undefined) delete process.env['PERIMETER_CHROMIUM']; else process.env['PERIMETER_CHROMIUM'] = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('поиск браузера при запуске', () => {
  it('первый запуск — браузера нет, после «установки» тот же launcher его находит', async () => {
    const launch = chromiumLauncher(undefined, { display: 'headless' });
    process.env['PERIMETER_CHROMIUM'] = '/nonexistent/chromium';
    await expect(launch()).rejects.toThrow();
    // «поставили»: поддельный браузер печатает адрес CDP, как настоящий
    const d = mkdtempSync(join(tmpdir(), 'pm-fakebr-')); dirs.push(d);
    const fake = join(d, 'chromium');
    writeFileSync(fake, '#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:9/devtools/browser/fake" >&2\nsleep 5\n');
    chmodSync(fake, 0o755);
    process.env['PERIMETER_CHROMIUM'] = fake;
    const b = await launch();
    expect(b.wsUrl).toBe('ws://127.0.0.1:9/devtools/browser/fake');
    b.kill();
  }, 20_000);
});
