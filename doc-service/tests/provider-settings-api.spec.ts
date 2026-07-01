/**
 * Tests for `providerSettingsRepo.toApi` — verifies that the API-facing
 * shape never leaks the plaintext `api_key`. Pure transformation, no DB.
 */

import { describe, it, expect } from 'vitest';

// Minimum env so transitive config.ts loads.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import {
  providerSettingsRepo,
  _extraSecretsForTesting,
  type ProviderSettingRow,
} from '../src/storage/provider-settings.js';
import { isEncrypted } from '../src/storage/secrets.js';

function row(overrides: Partial<ProviderSettingRow> = {}): ProviderSettingRow {
  return {
    id: 'anthropic',
    kind: 'llm',
    display_name: 'Anthropic',
    description: null,
    base_url: null,
    api_key: null,
    model: 'claude-sonnet-4-5',
    is_active: true,
    is_default: false,
    extra: null,
    created_at: new Date('2026-05-01T00:00:00Z'),
    updated_at: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  };
}

describe('providerSettingsRepo.toApi', () => {
  it('never exposes the plaintext api_key', () => {
    const r = row({ api_key: 'sk-ant-very-secret-1234' });
    const api = providerSettingsRepo.toApi(r);
    expect('api_key' in api).toBe(false);
    expect(api.has_api_key).toBe(true);
    expect(api.api_key_masked).toBe('••••1234');
  });

  it('null api_key → masked null + has_api_key=false', () => {
    const r = row({ api_key: null });
    const api = providerSettingsRepo.toApi(r);
    expect(api.api_key_masked).toBeNull();
    expect(api.has_api_key).toBe(false);
  });

  it('short api_key (<=4 chars) is fully masked', () => {
    const r = row({ api_key: 'abcd' });
    const api = providerSettingsRepo.toApi(r);
    expect(api.api_key_masked).toBe('••••');
  });

  it('roundtrips all non-secret fields verbatim', () => {
    const r = row({
      id: 'qwen-local',
      kind: 'llm',
      display_name: 'Qwen 2.5',
      description: 'Local',
      base_url: 'http://localhost:8000',
      api_key: 'token1234',
      model: 'qwen2.5-vl',
      is_active: false,
      is_default: false,
      extra: { gpu: 0 },
    });
    const api = providerSettingsRepo.toApi(r);
    expect(api.id).toBe('qwen-local');
    expect(api.kind).toBe('llm');
    expect(api.display_name).toBe('Qwen 2.5');
    expect(api.description).toBe('Local');
    expect(api.base_url).toBe('http://localhost:8000');
    expect(api.model).toBe('qwen2.5-vl');
    expect(api.is_active).toBe(false);
    expect(api.is_default).toBe(false);
    expect(api.extra).toEqual({ gpu: 0 });
    expect(api.created_at).toBe('2026-05-01T00:00:00.000Z');
  });

  it('dadata: masks extra.secret_key and sets has_secret_key, never plaintext', () => {
    const r = row({
      id: 'dadata',
      kind: 'dadata',
      display_name: 'DaData',
      api_key: 'token-abcd1234',
      extra: { secret_key: 'secret-wxyz9876', region: 'ru' },
    });
    const api = providerSettingsRepo.toApi(r);
    expect(api.has_secret_key).toBe(true);
    // secret_key замаскирован — plaintext не утекает
    expect((api.extra as Record<string, unknown>).secret_key).toBe('••••9876');
    expect(JSON.stringify(api)).not.toContain('secret-wxyz9876');
    // non-secret поля extra проходят как есть
    expect((api.extra as Record<string, unknown>).region).toBe('ru');
    // api_key тоже только маска
    expect('api_key' in api).toBe(false);
    expect(api.api_key_masked).toBe('••••1234');
  });

  it('has_secret_key=false when no secret_key in extra', () => {
    const r = row({ kind: 'dadata', extra: { region: 'ru' } });
    const api = providerSettingsRepo.toApi(r);
    expect(api.has_secret_key).toBe(false);
  });

  it('extra.reasoning_effort passes through toApi verbatim (not masked)', () => {
    const r = row({
      id: 'qwen-thinking',
      kind: 'llm',
      model: 'qwen3.6:27b',
      extra: { reasoning_effort: 'none' },
    });
    const api = providerSettingsRepo.toApi(r);
    expect((api.extra as Record<string, unknown>).reasoning_effort).toBe('none');
  });
});

describe('provider extra: reasoning_effort round-trips intact and is NOT encrypted', () => {
  it('is not registered as a secret extra-key', () => {
    expect(_extraSecretsForTesting.secretKeys).not.toContain('reasoning_effort');
  });

  it('survives encrypt (write) untouched — stays plaintext, no v1: envelope', () => {
    const encrypted = _extraSecretsForTesting.encrypt({ reasoning_effort: 'medium' });
    // Значение НЕ шифруется — остаётся ровно тем, что положил админ.
    expect((encrypted as Record<string, unknown>).reasoning_effort).toBe('medium');
    expect(isEncrypted((encrypted as Record<string, string>).reasoning_effort)).toBe(false);
  });

  it('full write→read round-trip preserves reasoning_effort while encrypting secret_key', () => {
    const written = _extraSecretsForTesting.encrypt({
      reasoning_effort: 'high',
      secret_key: 'dadata-secret-1234',
    });
    // secret_key зашифрован envelope'ом, reasoning_effort — нет.
    expect(isEncrypted((written as Record<string, string>).secret_key)).toBe(true);
    expect((written as Record<string, unknown>).reasoning_effort).toBe('high');

    const readBack = _extraSecretsForTesting.decrypt(written);
    expect((readBack as Record<string, unknown>).reasoning_effort).toBe('high');
    expect((readBack as Record<string, unknown>).secret_key).toBe('dadata-secret-1234');
  });
});
