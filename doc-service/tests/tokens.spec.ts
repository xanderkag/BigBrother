/**
 * Pure-функции `TokensRepo.isExpired` + `toApi` маски.
 *
 * Lifecycle-тесты (create → findByHash → touchLastUsed → revoke) и
 * auth-fallback к legacy `users.api_token_hash` — требуют живой БД и
 * относятся к интеграционному уровню; здесь только unit'ы.
 */

import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { TokensRepo, tokensRepo, type TokenRow } from '../src/storage/tokens.js';

function row(overrides: Partial<TokenRow> = {}): TokenRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    user_id: '00000000-0000-0000-0000-000000000002',
    name: 'ci',
    token_hash: 'h'.repeat(64),
    expires_at: null,
    last_used_at: null,
    created_at: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  };
}

describe('TokensRepo.isExpired', () => {
  it('null expires_at → бессрочный, не expired', () => {
    expect(TokensRepo.isExpired(row({ expires_at: null }))).toBe(false);
  });

  it('expires_at в будущем → не expired', () => {
    const future = new Date(Date.now() + 60_000);
    expect(TokensRepo.isExpired(row({ expires_at: future }))).toBe(false);
  });

  it('expires_at в прошлом → expired', () => {
    const past = new Date(Date.now() - 60_000);
    expect(TokensRepo.isExpired(row({ expires_at: past }))).toBe(true);
  });

  it('expires_at прямо сейчас → expired (граничный случай)', () => {
    const now = new Date();
    expect(TokensRepo.isExpired(row({ expires_at: now }))).toBe(true);
  });
});

describe('tokensRepo.toApi', () => {
  it('никогда не возвращает token_hash', () => {
    const api = tokensRepo.toApi(row({ token_hash: 'SECRET-HASH' }));
    expect('token_hash' in api).toBe(false);
    expect(JSON.stringify(api)).not.toContain('SECRET-HASH');
  });

  it('даты → ISO строки', () => {
    const api = tokensRepo.toApi(row({
      expires_at: new Date('2026-12-31T23:59:59Z'),
      last_used_at: new Date('2026-05-01T12:00:00Z'),
    }));
    expect(api.expires_at).toBe('2026-12-31T23:59:59.000Z');
    expect(api.last_used_at).toBe('2026-05-01T12:00:00.000Z');
    expect(api.created_at).toBe('2026-05-01T00:00:00.000Z');
  });

  it('null даты остаются null', () => {
    const api = tokensRepo.toApi(row({ expires_at: null, last_used_at: null }));
    expect(api.expires_at).toBeNull();
    expect(api.last_used_at).toBeNull();
  });

  it('is_expired флаг вычисляется', () => {
    expect(tokensRepo.toApi(row({ expires_at: null })).is_expired).toBe(false);
    expect(tokensRepo.toApi(row({ expires_at: new Date(Date.now() - 1000) })).is_expired).toBe(true);
  });
});
