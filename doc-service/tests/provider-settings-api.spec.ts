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

import { providerSettingsRepo, type ProviderSettingRow } from '../src/storage/provider-settings.js';

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
});
