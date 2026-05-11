/**
 * Tests for sanitizeMetadata — редакция секретов в client-supplied
 * `metadata` перед записью в БД и webhook'и.
 *
 * Покрывает обе стратегии (по имени ключа + по префиксу значения),
 * вложенные структуры, массивы, recursion limit, edge-cases с null/
 * boolean/number (не трогаем).
 */

import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { sanitizeMetadata } from '../src/storage/metadata-sanitizer.js';

describe('sanitizeMetadata — by key name', () => {
  it.each([
    ['password', 'mypass123'],
    ['Password', 'mypass123'],
    ['api_key', 'foo'],
    ['apikey', 'foo'],
    ['api-key', 'foo'],
    ['token', 'abc'],
    ['secret', 'abc'],
    ['authorization', 'Bearer xyz'],
    ['private_key', '-----BEGIN-----'],
    ['access_key', 'foo'],
    ['client_secret', 'foo'],
    ['refresh_token', 'foo'],
  ])('redacts value when key is "%s"', (key, value) => {
    const { sanitized, redactionsCount } = sanitizeMetadata({ [key]: value });
    expect(redactionsCount).toBe(1);
    expect((sanitized as Record<string, string>)[key]).toMatch(/REDACTED.*key=/);
  });

  it('leaves benign keys untouched', () => {
    const input = {
      batch_id: 'X-123',
      tags: ['foo', 'bar'],
      user_id: 'u-456',
      external_ref: 'ref-789',
    };
    const { sanitized, redactionsCount } = sanitizeMetadata(input);
    expect(redactionsCount).toBe(0);
    expect(sanitized).toEqual(input);
  });
});

describe('sanitizeMetadata — by value prefix', () => {
  it.each([
    ['sk-ant-api03-abcdefghijklmnop12345', 'Anthropic API key'],
    ['sk-abcdefghijklmnopqrstuv123456789', 'OpenAI / Stripe key'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS access key ID'],
    ['ya29.A0AfH6SMBabcdefghijklmnopqrst', 'Google OAuth token'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub personal token'],
    ['github_pat_11AYZ56IY0abcdefghi_jklmnopqrstuvwxyz0123', 'GitHub fine-grained PAT'],
    ['pdpat_abcdefghijklmnopqrstuvwxyz0123456789', 'parsdocs personal access token'],
    ['xoxb-1234567890-abcdefghijklmnop', 'Slack token'],
  ])('redacts value with known secret prefix: %s', (value, reason) => {
    const { sanitized, redactionsCount } = sanitizeMetadata({ arbitrary_key: value });
    expect(redactionsCount).toBe(1);
    expect((sanitized as Record<string, string>).arbitrary_key).toContain('[REDACTED');
    expect((sanitized as Record<string, string>).arbitrary_key).toContain(reason);
  });

  it('leaves short non-secret strings even if they start with sk-', () => {
    // sk- сам по себе слишком короток для секрета — наш паттерн требует ≥20 chars
    const { sanitized, redactionsCount } = sanitizeMetadata({ field: 'sk-short' });
    expect(redactionsCount).toBe(0);
    expect((sanitized as Record<string, string>).field).toBe('sk-short');
  });
});

describe('sanitizeMetadata — nested / arrays / edge cases', () => {
  it('walks nested objects', () => {
    const input = {
      provider: {
        name: 'anthropic',
        api_key: 'sk-ant-secret',
        timeout: 60000,
      },
    };
    const { sanitized, redactionsCount } = sanitizeMetadata(input);
    expect(redactionsCount).toBe(1);
    expect((sanitized as { provider: { name: string; api_key: string; timeout: number } }).provider.api_key).toMatch(/REDACTED/);
    expect((sanitized as { provider: { name: string } }).provider.name).toBe('anthropic');
    expect((sanitized as { provider: { timeout: number } }).provider.timeout).toBe(60000);
  });

  it('walks arrays', () => {
    const input = {
      providers: [
        { name: 'a', api_key: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { name: 'b', api_key: 'short' },
      ],
    };
    const { redactionsCount } = sanitizeMetadata(input);
    // Два API-ключа в массиве, оба под key-pattern → 2 редакции.
    expect(redactionsCount).toBe(2);
  });

  it('numbers, booleans, null остаются как есть', () => {
    const input = { count: 42, enabled: true, missing: null };
    const { sanitized, redactionsCount } = sanitizeMetadata(input);
    expect(redactionsCount).toBe(0);
    expect(sanitized).toEqual(input);
  });

  it('пустой объект и null входы', () => {
    expect(sanitizeMetadata({}).sanitized).toEqual({});
    expect(sanitizeMetadata(null).sanitized).toBeNull();
    expect(sanitizeMetadata(undefined).sanitized).toBeUndefined();
  });

  it('recursion limit — глубоко вложенные структуры не зацикливают', () => {
    // 20 уровней вложенности — выше MAX_DEPTH (8). Просто проверяем что
    // не падает и возвращает что-то.
    let deep: Record<string, unknown> = { token: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaa' };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(() => sanitizeMetadata(deep)).not.toThrow();
  });

  it('combined: key + value-prefix → одна редакция (короткое замыкание по key)', () => {
    // api_key сам по себе триггерит редакцию по имени; значение тоже
    // выглядит как секрет. Должна быть ровно одна редакция (key-стратегия
    // срабатывает первой).
    const { redactionsCount } = sanitizeMetadata({
      api_key: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(redactionsCount).toBe(1);
  });
});
