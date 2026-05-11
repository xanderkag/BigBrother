/**
 * Tests for `_computeDiffForTesting` — pure diff helper in audit-log repo.
 *
 * computeDiff производит структуру `{ field: { from, to } }`, удобную для
 * подсветки в UI. DB-touching код не задействован — здесь только логика
 * сравнения объектов.
 */

import { describe, it, expect } from 'vitest';

// Минимум env чтобы транзитивный config.ts не упал при импорте репо.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { _computeDiffForTesting as computeDiff } from '../src/storage/audit-log.js';

describe('audit-log computeDiff', () => {
  it('returns null when both sides null/empty', () => {
    expect(computeDiff(null, null)).toBeNull();
    expect(computeDiff({}, {})).toBeNull();
  });

  it('create: every after-field becomes "from null → to value"', () => {
    const diff = computeDiff(null, { slug: 'invoice', is_active: true });
    expect(diff).toEqual({
      slug: { from: null, to: 'invoice' },
      is_active: { from: null, to: true },
    });
  });

  it('delete: every before-field becomes "from value → to null"', () => {
    const diff = computeDiff({ slug: 'invoice', is_active: true }, null);
    expect(diff).toEqual({
      slug: { from: 'invoice', to: null },
      is_active: { from: true, to: null },
    });
  });

  it('update: only changed fields appear', () => {
    const before = { display_name: 'Old', is_active: true, expected_fields: ['number'] };
    const after = { display_name: 'New', is_active: true, expected_fields: ['number'] };
    expect(computeDiff(before, after)).toEqual({
      display_name: { from: 'Old', to: 'New' },
    });
  });

  it('deep equality for arrays — same content is not a diff', () => {
    const before = { expected_fields: ['a', 'b'] };
    const after = { expected_fields: ['a', 'b'] };
    expect(computeDiff(before, after)).toBeNull();
  });

  it('deep equality for arrays — different order IS a diff (intentional, simple JSON.stringify)', () => {
    const before = { expected_fields: ['a', 'b'] };
    const after = { expected_fields: ['b', 'a'] };
    const diff = computeDiff(before, after);
    expect(diff).not.toBeNull();
    expect(diff!.expected_fields).toBeDefined();
  });

  it('handles missing keys on one side (treats as null)', () => {
    const before = { only_in_before: 'x' };
    const after = { only_in_after: 'y' };
    expect(computeDiff(before, after)).toEqual({
      only_in_before: { from: 'x', to: null },
      only_in_after: { from: null, to: 'y' },
    });
  });
});
