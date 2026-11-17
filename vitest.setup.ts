// Тесты не должны зависеть от настроек Claude Code на машине разработчика (~/.claude/settings.json,
// транскрипты): каталог конфигурации по умолчанию — пустая временная папка.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['CLAUDE_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'cc-test-claude-'));
delete process.env['ANTHROPIC_BASE_URL'];
