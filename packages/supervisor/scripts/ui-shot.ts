// Скриншоты стенда без панели браузера: Chrome без окна по CDP открывает адрес, выполняет сценарий
// (JS-файл — тело async-функции, может кликать и ждать), снимает PNG. Только для разработки.
//
//   npx tsx packages/supervisor/scripts/ui-shot.ts <url> <сценарий.js|-> <out.png> [ширина] [высота]
//
// В сценарии доступны sleep(ms) и setv(input, value) (ввод в управляемые React-поля).
import { readFileSync, writeFileSync } from 'node:fs';
import { Cdp, chromiumLauncher, findChromium } from '../src/panels/rbrowser.js';

const [url, scriptPath, out, w = '1440', h = '900'] = process.argv.slice(2);
if (!url || !scriptPath || !out) {
  console.error('ui-shot <url> <сценарий.js|-> <out.png> [ширина] [высота]');
  process.exit(2);
}
const width = Number(w);
const height = Number(h);
const script = scriptPath === '-' ? '' : readFileSync(scriptPath, 'utf8');

const browser = await chromiumLauncher(findChromium(), { display: 'headless' })();
try {
  const cdp = await Cdp.connect(browser.wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await new Promise((r) => setTimeout(r, 1500));
  // SHOT_LS='{"ключ":"значение"}' — выставить localStorage (подключения стенда) и перезагрузить
  const ls = process.env['SHOT_LS'];
  if (ls) {
    await cdp.send('Runtime.evaluate', { expression: `(() => { const o = ${ls}; for (const [k, v] of Object.entries(o)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); })()` }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
  }
  await new Promise((r) => setTimeout(r, 2500));
  if (script) {
    const expr = `(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const setv = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      ${script}
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (r.exceptionDetails) console.error('сценарий упал:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    else if (r.result?.value !== undefined) console.log('сценарий:', JSON.stringify(r.result.value));
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId) as { data: string };
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`снимок: ${out}`);
  cdp.close();
} finally {
  browser.kill();
}
process.exit(0);
