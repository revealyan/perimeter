// Docker для агентов без root (кнопка «Docker для агентов» в установщике): dockerd живёт службой systemd пользователя
// службы, сокет — /run/user/<uid>/docker.sock. Агентам (Bash в сессиях, терминал) нужен DOCKER_HOST — supervisor
// выставляет его сам, как только сокет появился: без перезапуска и без правки юнита.
import { existsSync } from 'node:fs';

/** Адрес rootless docker этого пользователя, если он есть и DOCKER_HOST не задан явно. */
export function rootlessDockerHost(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (env['DOCKER_HOST']) return undefined;
  if (uid === undefined) return undefined; // Windows — не наш случай
  const sock = `/run/user/${uid}/docker.sock`;
  return exists(sock) ? `unix://${sock}` : undefined;
}

/** Выставить DOCKER_HOST процессу supervisor'а (дети наследуют); true — только что появился (тёплым процессам — пересоздаться). */
export function ensureDockerHost(env: NodeJS.ProcessEnv = process.env, uid?: number, exists?: (p: string) => boolean): boolean {
  const host = rootlessDockerHost(env, uid ?? process.getuid?.(), exists);
  if (!host) return false;
  env['DOCKER_HOST'] = host;
  return true;
}
