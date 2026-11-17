// Точка входа supervisor'а (systemd-юнит в T6).
// Запуск: PERIMETER_PORT=8790 tsx packages/supervisor/src/main.ts

import { startSupervisor } from './supervisor.js';
import { SUPERVISOR_VERSION } from './version.js';

const port = Number(process.env.PERIMETER_PORT ?? 8790);
const host = process.env.PERIMETER_HOST ?? '127.0.0.1';
const model = process.env.PERIMETER_MODEL ?? 'glm-5.3[1m]';
const permissionMode = (process.env.PERIMETER_PERMISSION_MODE ?? 'acceptEdits') as
  'acceptEdits' | 'default' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

const stateFile = process.env.PERIMETER_STATE;
const profilesFile = process.env.PERIMETER_PROFILES;
const projectsFile = process.env.PERIMETER_PROJECTS;
const idleTimeoutMs = Number(process.env.PERIMETER_IDLE_TIMEOUT_MS ?? 15 * 60_000); // 0 = выкл
const poolSize = Number(process.env.PERIMETER_POOL_SIZE ?? 1);
// тёплые процессы аккаунтов: «all» или «yan,zai»; по умолчанию — только аккаунт supervisor'а
const poolProfiles = process.env.PERIMETER_POOL_PROFILES;
const poolProfileSize = Number(process.env.PERIMETER_POOL_PROFILE_SIZE ?? 1);
const { stop } = await startSupervisor({
  port, host, model, permissionMode, idleTimeoutMs, poolSize, poolProfileSize,
  ...(poolProfiles ? { poolProfiles } : {}),
  ...(stateFile ? { stateFile } : {}),
  ...(profilesFile ? { profilesFile } : {}),
  ...(projectsFile ? { projectsFile } : {}),
});
console.log(`perimeter-supervisor v${SUPERVISOR_VERSION}: ws://${host}:${port} (только локально; снаружи — через SSH-туннель)`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`${sig} — останавливаемся`);
    void stop().finally(() => process.exit(0));
  });
}
