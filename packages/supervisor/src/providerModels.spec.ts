// Список моделей у провайдера (/v1/models) и запуск с [1m] по настройке аккаунта.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_API, fetchProviderModels, providerAccess, providerHeaders, toModel, type FetchLike } from './providerModels.js';
import { ProfileRegistry, accountEnv } from './profiles.js';
import { customModelId, parseCustomModelId } from '@perimeter/protocol';
import { flagSettings } from './session/sdk.js';

const OPUS = {
  type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1_000_000, max_tokens: 128_000,
  capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } },
};
const HAIKU45 = { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000, capabilities: { effort: { supported: false } } };

describe('доступ к провайдеру', () => {
  it('ключ API → x-api-key; токен шлюза → Bearer; токен подписки → Bearer + бета oauth; без ключа — null', () => {
    expect(providerAccess({ ANTHROPIC_API_KEY: 'sk-ant-1' })).toEqual({ baseUrl: ANTHROPIC_API, kind: 'x-api-key', key: 'sk-ant-1' });
    expect(providerAccess({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic/', ANTHROPIC_AUTH_TOKEN: 'zk' }))
      .toEqual({ baseUrl: 'https://api.z.ai/api/anthropic', kind: 'bearer', key: 'zk' });
    expect(providerAccess({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' })).toMatchObject({ kind: 'oauth' });
    expect(providerAccess({ PATH: '/bin' })).toBeNull();
    expect(providerHeaders({ baseUrl: '', kind: 'x-api-key', key: 'k' })).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    expect(providerHeaders({ baseUrl: '', kind: 'bearer', key: 'k' })).toMatchObject({ authorization: 'Bearer k' });
    expect(providerHeaders({ baseUrl: '', kind: 'oauth', key: 'k' })).toMatchObject({ authorization: 'Bearer k', 'anthropic-beta': 'oauth-2025-04-20' });
  });

  it('окружение аккаунта supervisor’а — с settings.json и процессом; профиль со своим env — свой ключ', () => {
    const saved = process.env['ANTHROPIC_AUTH_TOKEN'];
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'из-процесса';
    try {
      expect(accountEnv({ name: 'default' })['ANTHROPIC_AUTH_TOKEN']).toBe('из-процесса');
      expect(accountEnv({ name: 'zai', env: { ANTHROPIC_AUTH_TOKEN: 'свой' } })['ANTHROPIC_AUTH_TOKEN']).toBe('свой');
      expect(accountEnv({ name: 'sub', configDir: '/нет/такой' })['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env['ANTHROPIC_AUTH_TOKEN']; else process.env['ANTHROPIC_AUTH_TOKEN'] = saved;
    }
  });
});

describe('ответ /v1/models', () => {
  it('id как есть, название — пояснением, окно контекста и усилия из capabilities', () => {
    expect(toModel(OPUS)).toEqual({ id: 'claude-opus-5-5', description: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], ctx: 1_000_000 });
    expect(toModel(HAIKU45)).toEqual({ id: 'claude-haiku-4-5', description: 'Claude Haiku 4.5', efforts: [], ctx: 200_000 });
    // шлюз без capabilities и без названия (z.ai)
    expect(toModel({ id: 'glm-5.3' })).toEqual({ id: 'glm-5.3', efforts: [] });
    expect(toModel({ id: '' })).toBeNull();
  });

  it('страницы по after_id, без повторов; заголовки с ключом', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      const page = url.includes('after_id') ? { data: [HAIKU45, OPUS], has_more: false } : { data: [OPUS], has_more: true, last_id: 'claude-opus-5-5' };
      return { ok: true, status: 200, json: async () => page };
    };
    const list = await fetchProviderModels({ baseUrl: ANTHROPIC_API, kind: 'x-api-key', key: 'sk' }, f);
    expect(list.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5']);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(calls[1]!.url).toContain('after_id=claude-opus-5-5');
    expect(calls[0]!.headers['x-api-key']).toBe('sk');
  });

  it('ошибки: HTTP с пояснением, не тот ответ, пустой список; ключа в тексте нет', async () => {
    const a = { baseUrl: 'https://gw.example', kind: 'bearer' as const, key: 'SECRET-KEY-1' };
    const reply = (status: number, body: unknown): FetchLike => async () => ({ ok: status < 400, status, json: async () => body });
    await expect(fetchProviderModels(a, reply(404, {}))).rejects.toThrow(/404 — списка моделей у него нет/);
    await expect(fetchProviderModels(a, reply(401, {}))).rejects.toThrow(/ключ не подходит/);
    await expect(fetchProviderModels(a, reply(200, { models: [] }))).rejects.toThrow(/не похож/);
    await expect(fetchProviderModels(a, reply(200, { data: [] }))).rejects.toThrow(/пустой/);
    await expect(fetchProviderModels(a, reply(500, {}))).rejects.not.toThrow(/SECRET/);
  });
});

describe('контекст 1M по настройке аккаунта', () => {
  it('launchModel добавляет [1m] только включённым моделям; уже с [1m] — как есть; аккаунт supervisor’а — тоже', () => {
    const reg = new ProfileRegistry([{ name: 'zai', env: { ANTHROPIC_AUTH_TOKEN: 'k' }, long: ['glm-5.3'] }, { name: 'default', long: ['claude-opus-5-5'] }]);
    expect(reg.launchModel('zai', 'glm-5.3')).toBe('glm-5.3[1m]');
    expect(reg.launchModel('zai', 'glm-5.3-flash')).toBe('glm-5.3-flash');
    expect(reg.launchModel('zai', 'glm-5.3[1m]')).toBe('glm-5.3[1m]');
    expect(reg.launchModel('zai', undefined)).toBeUndefined();
    expect(reg.launchModel(undefined, 'claude-opus-5-5')).toBe('claude-opus-5-5[1m]'); // без профиля = default
    expect(reg.info('zai')).toMatchObject({ long: ['glm-5.3'] });
  });

  it('правка long из UI: список целиком, пустой — хранится (1M выключен у всех); повторы схлопываются', () => {
    const reg = new ProfileRegistry([{ name: 'zai', env: { ANTHROPIC_AUTH_TOKEN: 'k' } }]);
    reg.update('zai', { long: ['glm-5.3', 'glm-5.3'] });
    expect(reg.get('zai')?.long).toEqual(['glm-5.3']);
    reg.update('zai', { long: [] });
    expect(reg.get('zai')?.long).toEqual([]);
  });

  it('long не задан — из настроек Claude Code аккаунта ([1m] в model и ANTHROPIC_*_MODEL); заданный, даже пустой, важнее', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-long-'));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      model: 'glm-5.3[1m]',
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7' },
    }));
    const reg = new ProfileRegistry([{ name: 'gw', configDir: dir }, { name: 'plain', env: { ANTHROPIC_AUTH_TOKEN: 'k' } }]);
    expect(reg.info('gw')?.long).toEqual(['glm-5.3', 'glm-5.3-flash']);
    expect(reg.launchModel('gw', 'glm-5.3')).toBe('glm-5.3[1m]');
    expect(reg.launchModel('gw', 'glm-4.7')).toBe('glm-4.7');
    expect(reg.info('plain')?.long).toBeUndefined();
    reg.update('gw', { long: [] });
    expect(reg.launchModel('gw', 'glm-5.3')).toBe('glm-5.3');
    expect(reg.info('gw')?.long).toBeUndefined();
  });

  it('кэш помнит, кто отдал список: provider / claude-code', () => {
    const reg = new ProfileRegistry([{ name: 'zai', env: { ANTHROPIC_AUTH_TOKEN: 'k' } }]);
    reg.setAutoModels('zai', [{ id: 'glm-5.3', efforts: [] }], 1, 'provider');
    expect(reg.info('zai')).toMatchObject({ modelsSource: 'auto', modelsFrom: 'provider', models: [{ id: 'glm-5.3' }] });
  });
});

describe('свои модели: база + окно контекста', () => {
  it('id самоописывающий: glm-5.3@400k; окно вне 100K–1M и даты Vertex (@20250514) — не своя модель', () => {
    expect(customModelId('glm-5.3', 400_000)).toBe('glm-5.3@400k');
    expect(parseCustomModelId('glm-5.3@400k')).toEqual({ base: 'glm-5.3', ctx: 400_000 });
    expect(parseCustomModelId('claude-opus-5-5@1000k')).toEqual({ base: 'claude-opus-5-5', ctx: 1_000_000 });
    expect(parseCustomModelId('glm-5.3@50k')).toBeNull();
    expect(parseCustomModelId('glm-5.3@2000k')).toBeNull();
    expect(parseCustomModelId('claude-opus-4@20250514')).toBeNull();
    expect(parseCustomModelId('glm-5.3')).toBeNull();
  });

  it('запуск: больше 200K — с [1m]; окно, кроме 1M; удалённая своя модель запускается так же; обычная — как раньше', () => {
    const reg = new ProfileRegistry([{ name: 'zai', env: { ANTHROPIC_AUTH_TOKEN: 'k' }, long: ['glm-5.3'] }]);
    expect(reg.launch('zai', 'glm-5.3@400k')).toEqual({ model: 'glm-5.3[1m]', window: 400_000 });
    expect(reg.launch('zai', 'glm-5.3@1000k')).toEqual({ model: 'glm-5.3[1m]' });
    expect(reg.launch('zai', 'glm-5.3@150k')).toEqual({ model: 'glm-5.3', window: 150_000 });
    expect(reg.launch('zai', 'glm-5.3[1m]@300k')).toEqual({ model: 'glm-5.3[1m]', window: 300_000 });
    expect(reg.launch('zai', 'glm-5.3')).toEqual({ model: 'glm-5.3[1m]' });
    expect(reg.launch('zai', undefined)).toEqual({});
    expect(flagSettings({ window: 400_000 })).toEqual({ autoCompactWindow: 400_000 });
    expect(flagSettings({})).toBeUndefined();
  });

  it('правка: id всегда из базы и окна, повторы схлопываются, пустой список убирает; усилия — как у базы', () => {
    const reg = new ProfileRegistry([{ name: 'a' }]);
    reg.update('a', { custom: [{ id: 'что-угодно', base: 'claude-opus-5-5', ctx: 300_000, label: 'Opus коротко' }, { id: 'x', base: 'claude-opus-5-5', ctx: 300_000 }] });
    expect(reg.get('a')?.custom).toEqual([{ id: 'claude-opus-5-5@300k', base: 'claude-opus-5-5', ctx: 300_000, label: 'Opus коротко' }]);
    expect(reg.info('a')?.custom?.map((c) => c.id)).toEqual(['claude-opus-5-5@300k']);
    reg.setAutoModels('a', [{ id: 'claude-opus-5-5', efforts: ['low', 'max'] }]);
    expect(reg.effortsFor('a', 'claude-opus-5-5@300k')).toEqual(['low', 'max']);
    reg.update('a', { custom: [] });
    expect(reg.get('a')?.custom).toBeUndefined();
  });
});
