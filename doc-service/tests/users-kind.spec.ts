/**
 * Service accounts: `users.kind` (human/service).
 *
 * Здесь только pure-unit на `toApi` (маппинг row → API). Lifecycle
 * (create → list?kind= фильтр) требует живой БД и относится к
 * интеграционному уровню — см. tokens.spec.ts.
 */

import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { usersRepo, type UserRow } from '../src/storage/users.js';

function row(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'a@b.c',
    display_name: 'Acme',
    organization_id: null,
    role: 'manager',
    status: 'active',
    kind: 'human',
    api_token_hash: null,
    password_hash: null,
    last_seen_at: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('usersRepo.toApi kind', () => {
  it('human → kind=human', () => {
    expect(usersRepo.toApi(row({ kind: 'human' })).kind).toBe('human');
  });

  it('service → kind=service', () => {
    expect(usersRepo.toApi(row({ kind: 'service' })).kind).toBe('service');
  });

  it('service-аккаунт без email (login нет) маппится без ошибок', () => {
    const api = usersRepo.toApi(row({ kind: 'service', email: null }));
    expect(api.kind).toBe('service');
    expect(api.email).toBeNull();
  });
});
