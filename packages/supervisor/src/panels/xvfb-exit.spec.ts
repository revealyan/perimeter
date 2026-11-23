// Виртуальный экран не переживает свой процесс: выход без закрытия браузера не оставляет сироту Xvfb.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findInPath } from './rbrowser.js';

const xvfb = process.platform === 'linux' ? findInPath('Xvfb') : null;

describe.skipIf(!xvfb)('Xvfb гасится при выходе процесса', () => {
  it('процесс поднял экран и вышел — экрана больше нет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-xvfb-'));
    try {
      const script = join(dir, 'run.mts');
      writeFileSync(script, `import { startXvfb } from ${JSON.stringify(new URL('./rbrowser.ts', import.meta.url).pathname)};
const s = await startXvfb(${JSON.stringify(xvfb)}); console.log(s.display); process.exit(0);\n`);
      const r = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 30_000 });
      const display = r.stdout.trim().split('\n').pop() ?? '';
      if (!/^:\d+$/.test(display)) console.error(r.stderr);
      expect(display).toMatch(/^:\d+$/);
      const sock = `/tmp/.X11-unix/X${display.slice(1)}`;
      for (let i = 0; i < 40 && existsSync(sock); i++) await new Promise((res) => setTimeout(res, 100));
      expect(existsSync(sock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
