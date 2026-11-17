#!/usr/bin/env node
// Поддельный Claude Code для тестов и стенда (accounts.spec.ts, mcp.spec.ts, demo-server):
// - `auth login --claudeai` — ссылка с OSC 8 и \r, ожидание кода, файл входа в CLAUDE_CONFIG_DIR (верный код goodcode#st1);
// - `auth status --json` — вошёл ли (файл входа или токен подписки в CLAUDE_CODE_OAUTH_TOKEN);
// - `-p … --output-format json` — проверка токена подписки (верный начинается с sk-ant-oat-good); как настоящий:
//   subtype «success» и код 0 даже при отказе API, признак — только is_error;
// - `mcp login <имя> --no-browser` — ссылка авторизации, ожидание адреса возврата (верный содержит code=good);
// - `setup-token` — как вход, но в конце печатает токен подписки (верный код goodcode#st1); FAKE_SETUP_AUTO=1 —
//   «браузер вернулся сам» через секунду (стенд).
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dir = process.env.CLAUDE_CONFIG_DIR;
const creds = dir ? join(dir, '.credentials.json') : null;
const [cmd, sub, ...rest] = process.argv.slice(2);

if (cmd === '-p') {
  const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
  const ok = tok.startsWith('sk-ant-oat-good');
  const res = { type: 'result', subtype: 'success', is_error: !ok, ...(ok ? {} : { api_error_status: 401 }), result: ok ? 'ок' : 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' };
  process.stdout.write(`${JSON.stringify(res)}\n`);
  process.exit(0);
}

if (cmd === 'auth' && sub === 'status' && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }, null, 2)}\n`);
  process.exit(0);
}

if (cmd === 'auth' && sub === 'status') {
  const loggedIn = !!creds && existsSync(creds);
  const out = loggedIn
    ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'alex@example.com', subscriptionType: 'max' }
    : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

if (cmd === 'mcp' && sub === 'login') {
  const url = 'https://mcp.example.com/authorize?response_type=code&client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback&state=m1';
  process.stdout.write(`Starting authentication for "${rest[0]}"…\r\nVisit this URL to authorize:\r\n  ${url}\r\nWaiting for authorization… (^C to cancel)\r\nOr paste the redirect URL here: `);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const v = line.replace(/\r/g, '').trim();
    if (!v) return;
    if (v.includes('code=good')) {
      // отметка для стенда: вход в этот сервер выполнен (demo-server читает её в «claude mcp list»)
      if (dir) { try { writeFileSync(join(dir, `.mcp-auth-${rest[0]}`), '1'); } catch { /* папки нет — стенду не важно */ } }
      process.stdout.write('\r\nAuthentication successful.\r\n');
      process.exit(0);
    }
    process.stdout.write('\r\nAuthentication failed.\r\n');
    process.exit(1);
  });
} else if (cmd === 'setup-token') {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code'
    + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=st1';
  // «рабочий» для поддельной проверки (-p): начинается с sk-ant-oat-good
  const token = 'sk-ant-oat-good-setup_0123456789abcdefghijklmnopqrstuvwxyz-AAAA';
  const ok = () => {
    process.stdout.write(`\r\n\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n${token}\r\n\r\nStore this token securely.\r\n`);
    // настоящий Claude Code не выходит сам — ждёт; supervisor гасит процесс, поймав токен
    setInterval(() => undefined, 1000);
  };
  process.stdout.write('Opening browser to sign in…\r\n');
  process.stdout.write(`Browser didn't open? Use the url below to sign in: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\n`);
  process.stdout.write('Paste code here if prompted > ');
  if (process.env.FAKE_SETUP_AUTO) setTimeout(ok, 1000);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const code = line.replace(/\r/g, '').trim();
    if (!code) return;
    if (code === 'goodcode#st1') { ok(); return; }
    process.stdout.write('\r\nOAuth error: Invalid code\r\n');
    process.exit(1);
  });
} else if (cmd === 'auth' && sub === 'login') {
  if (process.env.FAKE_CLAUDE_NO_URL) {
    process.stdout.write('Something went wrong\r\n');
    process.exit(3);
  }
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code'
    + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=st1';
  process.stdout.write('Opening browser to sign in…\r\n');
  process.stdout.write(`If the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\n`);
  process.stdout.write('Paste code here if prompted > ');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const code = line.replace(/\r/g, '').trim();
    if (!code) return;
    if (code === 'goodcode#st1') {
      writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
      process.stdout.write('\r\nLogin successful.\r\n');
      process.exit(0);
    }
    process.stdout.write('\r\nOAuth error: Invalid code\r\n');
    process.exit(1);
  });
} else {
  process.stdout.write(`fake-claude: не знаю «${process.argv.slice(2).join(' ')}»\n`);
  process.exit(2);
}
