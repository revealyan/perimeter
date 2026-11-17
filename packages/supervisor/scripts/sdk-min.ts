// Минимальный прогон SDK без нашего движка: СТРИМИНГОВЫЙ вход, печать всех сообщений.
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

async function* input(): AsyncIterable<SDKUserMessage> {
  console.log('input: ждём 1.5с перед первым сообщением');
  await new Promise((r) => setTimeout(r, 1500));
  console.log('input: отдаём сообщение');
  yield { type: 'user', message: { role: 'user', content: 'Ответь одним словом: ок' } };
}

const q = query({
  prompt: input(),
  options: {
    model: 'glm-5.3[1m]',
    cwd: process.env.TEMP ?? '.',
    permissionMode: 'acceptEdits',
    stderr: (m: string) => console.error('[stderr]', m),
  },
});

for await (const m of q) {
  console.log('MSG', m.type, 'subtype' in m ? m.subtype : '');
}
console.log('DONE');
process.exit(0);
