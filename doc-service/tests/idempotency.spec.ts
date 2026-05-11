/**
 * Tests for the Idempotency-Key parsing/validation helper and the
 * unique-violation detector used by the POST /jobs handler.
 *
 * Full route-level coverage (mocked repo + queue, Fastify inject) is a
 * separate spec — covered by routes-level integration plans in TECH_DEBT.
 * These unit tests are the cheap layer that keeps the parser honest.
 */

import { describe, it, expect } from 'vitest';

// Min env for config.ts import — readIdempotencyKey lives in routes/jobs.ts
// which transitively imports config. We don't actually use the DB here.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { readIdempotencyKey, isUniqueViolation } from '../src/routes/jobs.js';

describe('readIdempotencyKey', () => {
  it('returns null when header absent', () => {
    expect(readIdempotencyKey({})).toBeNull();
    expect(readIdempotencyKey({ 'idempotency-key': undefined as unknown as string })).toBeNull();
  });

  it('returns null on empty string (treated as absent)', () => {
    expect(readIdempotencyKey({ 'idempotency-key': '' })).toBeNull();
    expect(readIdempotencyKey({ 'idempotency-key': '   ' })).toBeNull();
  });

  it('accepts valid UUIDs', () => {
    const key = '550e8400-e29b-41d4-a716-446655440000';
    expect(readIdempotencyKey({ 'idempotency-key': key })).toBe(key);
  });

  it('accepts ULIDs and alphanumeric ids', () => {
    expect(readIdempotencyKey({ 'idempotency-key': '01HKQXY7T9Z3VBNS5W6P4F8K2J' })).toBe(
      '01HKQXY7T9Z3VBNS5W6P4F8K2J',
    );
    expect(readIdempotencyKey({ 'idempotency-key': 'order_42.v3' })).toBe('order_42.v3');
  });

  it('trims surrounding whitespace', () => {
    expect(readIdempotencyKey({ 'idempotency-key': '   abc-def   ' })).toBe('abc-def');
  });

  it('throws on overlong keys (>64)', () => {
    const tooLong = 'a'.repeat(65);
    expect(() => readIdempotencyKey({ 'idempotency-key': tooLong })).toThrow();
  });

  it('throws on unsafe characters', () => {
    expect(() => readIdempotencyKey({ 'idempotency-key': 'has space' })).toThrow();
    expect(() => readIdempotencyKey({ 'idempotency-key': 'newline\nbad' })).toThrow();
    expect(() => readIdempotencyKey({ 'idempotency-key': 'sql; --' })).toThrow();
    expect(() => readIdempotencyKey({ 'idempotency-key': 'юникод' })).toThrow();
  });

  it('throws when array (HTTP allows multi-header, we want a single value)', () => {
    expect(() => readIdempotencyKey({ 'idempotency-key': ['a', 'b'] as unknown as string })).toThrow();
  });

  it('error shape includes status and message for the route handler', () => {
    let thrown: unknown;
    try {
      readIdempotencyKey({ 'idempotency-key': 'a'.repeat(100) });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ status: 400 });
    expect((thrown as { message: string }).message).toMatch(/64/);
  });
});

describe('isUniqueViolation', () => {
  it('matches a Postgres 23505 error', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('does not match other Postgres codes', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false); // FK violation
    expect(isUniqueViolation({ code: '42P01' })).toBe(false); // undefined_table
  });

  it('does not match non-errors', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('not an error')).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
  });
});
