// Мультиакк: загрузка profiles.json, слияние профиля в параметры фабрики,.unknown профиль отклоняется.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyProfile, ProfileRegistry } from './profiles.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('ProfileRegistry', () => {
  it('загрузка файла и get по имени', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-prof-')); dirs.push(dir);
    const f = join(dir, 'profiles.json');
    writeFileSync(f, JSON.stringify({
      version: 1,
      profiles: [
        { name: 'yan', model: 'sonnet' },
        { name: 'zai', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'x' }, model: 'glm-5.3[1m]' },
        { name: 'acc2', configDir: '/home/yan/.perimeter/accounts/acc2/.claude', description: 'вторая подписка' },
      ],
    }), 'utf8');
    const reg = ProfileRegistry.load(f);
    expect(reg.list()).toHaveLength(3);
    expect(reg.get('zai')?.env?.['ANTHROPIC_BASE_URL']).toContain('z.ai');
    expect(reg.get('нетакого')).toBeUndefined();
    expect(reg.get(undefined)).toBeUndefined();
  });

  it('нет файла/битый/не тот version — пустой реестр', () => {
    expect(ProfileRegistry.load(undefined).list()).toEqual([]);
    expect(ProfileRegistry.load(join(tmpdir(), 'нет.json')).list()).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'cc-prof-')); dirs.push(dir);
    const f = join(dir, 'p.json');
    writeFileSync(f, '{{{', 'utf8');
    expect(ProfileRegistry.load(f).list()).toEqual([]);
    writeFileSync(f, JSON.stringify({ version: 2, profiles: [] }), 'utf8');
    expect(ProfileRegistry.load(f).list()).toEqual([]);
  });
});

describe('ProfileRegistry: ручные правки profiles.json', () => {
  it('поля не той формы отбрасываются (иначе event:hello не проходит схему и UI не подключается)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-prof-')); dirs.push(dir);
    const f = join(dir, 'profiles.json');
    writeFileSync(f, JSON.stringify({ version: 1, profiles: [
      { name: 'yan', displayName: 5, model: null, description: 'ok', configDir: 7, env: 'не объект' },
    ] }), 'utf8');
    const p = ProfileRegistry.load(f).get('yan');
    expect(p).toEqual({ name: 'yan', description: 'ok' });
  });
});

describe('ProfileRegistry: делегирование (delegate)', () => {
  it('по умолчанию выключено; включается файлом и правкой из UI; info отдаёт всегда', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-prof-')); dirs.push(dir);
    const f = join(dir, 'profiles.json');
    writeFileSync(f, JSON.stringify({ version: 1, profiles: [{ name: 'yan', delegate: true }, { name: 'zai', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }] }), 'utf8');
    const reg = ProfileRegistry.load(f);
    expect(reg.delegateAllowed('yan')).toBe(true);
    expect(reg.delegateAllowed('zai')).toBe(false);
    expect(reg.delegateAllowed(undefined)).toBe(false); // аккаунт supervisor — тоже явно
    expect(reg.info('yan')?.delegate).toBe(true);
    expect(reg.info('zai')?.delegate).toBe(false);

    reg.update('zai', { delegate: true });
    expect(reg.delegateAllowed('zai')).toBe(true);
    reg.update('yan', { delegate: false });
    expect(reg.delegateAllowed('yan')).toBe(false);

    // нативные субагенты: Claude — да, шлюз — нет; правка из UI перекрывает умолчание
    expect(reg.nativeAgentsAllowed('yan')).toBe(true); // не шлюз
    expect(reg.nativeAgentsAllowed('zai')).toBe(false); // шлюз без записи
    expect(reg.info('zai')?.nativeAgents).toBe(false);
    expect(reg.info('yan')?.nativeAgents).toBe(true);
    reg.update('zai', { nativeAgents: true });
    expect(reg.nativeAgentsAllowed('zai')).toBe(true);
    reg.update('yan', { nativeAgents: false });
    expect(reg.nativeAgentsAllowed('yan')).toBe(false);
    // битое значение в файле отбрасывается
    writeFileSync(f, JSON.stringify({ version: 1, profiles: [{ name: 'zai', delegate: 'да' }] }), 'utf8');
    expect(ProfileRegistry.load(f).delegateAllowed('zai')).toBe(false);
  });
});

describe('applyProfile', () => {
  it('env профиля + CLAUDE_CONFIG_DIR поверх базового; модель из профиля если не задана в сессии', () => {
    const p = { name: 'acc2', configDir: '/a/.claude', model: 'opus', env: { FOO: '1' } };
    const r = applyProfile(p, { model: 'sonnet' });
    expect(r.model).toBe('sonnet'); // сессионная модель важнее профильной
    expect(r.env).toMatchObject({ FOO: '1', CLAUDE_CONFIG_DIR: '/a/.claude' });

    const r2 = applyProfile(p, {});
    expect(r2.model).toBe('opus');
  });

  it('env профиля поверх окружения supervisor’а: Options.env SDK заменяет окружение целиком (PATH/HOME не теряются)', () => {
    const r = applyProfile({ name: 'zai', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }, {});
    const keys = Object.keys(r.env ?? {}).map((k) => k.toUpperCase());
    expect(keys).toContain('PATH');
    expect(r.env?.['ANTHROPIC_BASE_URL']).toBe('https://api.z.ai/api/anthropic');
  });

  it('без профиля — база как есть', () => {
    expect(applyProfile(undefined, { model: 'sonnet' })).toEqual({ model: 'sonnet' });
  });
});

describe('аккаунт по умолчанию, не вошедший', () => {
  it('на сервере прячем (пустая карточка ни к чему); на своём компьютере — показываем: это Claude Code пользователя, войти надо здесь', () => {
    const server = new ProfileRegistry([]);
    server.setAuth('default', { loggedIn: false });
    expect(server.publicList().map((p) => p.name)).toEqual([]);
    const local = new ProfileRegistry([]);
    local.keepBase = true;
    local.setAuth('default', { loggedIn: false });
    expect(local.publicList().map((p) => p.name)).toEqual(['default']);
    expect(local.info('default')?.auth).toEqual({ loggedIn: false });
  });
});
