import { describe, expect, it } from 'vitest';
import { ensureDockerHost, rootlessDockerHost } from './dockerEnv.js';

describe('docker для агентов: DOCKER_HOST', () => {
  it('сокет rootless есть — адрес; задан явно или сокета нет — не трогаем', () => {
    const has = (p: string) => p === '/run/user/1000/docker.sock';
    expect(rootlessDockerHost({}, 1000, has)).toBe('unix:///run/user/1000/docker.sock');
    expect(rootlessDockerHost({ DOCKER_HOST: 'tcp://x:2375' }, 1000, has)).toBeUndefined();
    expect(rootlessDockerHost({}, 1001, has)).toBeUndefined();
  });
  it('выставляет один раз: второй вызов — уже задан, false', () => {
    const env: NodeJS.ProcessEnv = {};
    const has = () => true;
    expect(ensureDockerHost(env, 1000, has)).toBe(true);
    expect(env['DOCKER_HOST']).toBe('unix:///run/user/1000/docker.sock');
    expect(ensureDockerHost(env, 1000, has)).toBe(false);
  });
});
