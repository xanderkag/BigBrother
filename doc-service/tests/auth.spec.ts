/**
 * Auth tests.
 *
 * Two layers:
 *   1. Pure unit tests of the helpers (`extractBearerToken`,
 *      `constantTimeEqual`) — no Fastify, fast.
 *   2. Hook integration with a minimal Fastify app via `inject()`. We
 *      register `bearerAuthHook` against a dummy route and verify
 *      401/200 transitions across env states. This avoids touching the
 *      real `/api/v1/jobs` route, which depends on Postgres/Redis.
 *
 * The auth hook reads `config.apiKey` at request time, so we mutate the
 * config object directly via vi.mock to flip auth on/off per test.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Stub config BEFORE auth.ts is imported, so the module-level `config` ref
// inside auth.ts points at our mutable object. Vitest's vi.mock supports
// this pattern via the factory form; here we use a simpler env-based path
// since config.ts reads from process.env at import time.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';
// Start with auth ON for the integration tests; flip OFF in dedicated cases.
const TEST_KEY = 'test-secret-key-12345';
process.env.API_KEY = TEST_KEY;

let auth: typeof import('../src/auth.js');
let configMod: typeof import('../src/config.js');

beforeAll(async () => {
  auth = await import('../src/auth.js');
  configMod = await import('../src/config.js');
});

describe('extractBearerToken', () => {
  it('returns the token from a well-formed header', () => {
    expect(auth.extractBearerToken('Bearer abc')).toBe('abc');
    expect(auth.extractBearerToken('bearer XYZ-123')).toBe('XYZ-123');
    expect(auth.extractBearerToken('Bearer   spaces.tolerated')).toBe('spaces.tolerated');
  });

  it('returns null on missing/malformed headers', () => {
    expect(auth.extractBearerToken(undefined)).toBeNull();
    expect(auth.extractBearerToken('')).toBeNull();
    expect(auth.extractBearerToken('Basic abc')).toBeNull();
    expect(auth.extractBearerToken('Bearer')).toBeNull(); // no token after "Bearer"
    expect(auth.extractBearerToken(['Bearer abc'])).toBeNull(); // array form rejected
  });
});

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(auth.constantTimeEqual('abc', 'abc')).toBe(true);
    expect(auth.constantTimeEqual('', '')).toBe(true);
  });

  it('returns false for different lengths or contents', () => {
    expect(auth.constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(auth.constantTimeEqual('abc', 'abd')).toBe(false);
    expect(auth.constantTimeEqual('a', 'b')).toBe(false);
  });
});

describe('assertAuthConfigured — startup fail-closed guard', () => {
  const silent = { warn: () => undefined };

  it('throws when no API_KEY, no named keys, ALLOW_NO_AUTH unset', () => {
    expect(() =>
      configMod.assertAuthConfigured(
        { apiKey: '', apiKeysJson: {}, allowNoAuth: false },
        silent,
      ),
    ).toThrow(/Refusing to start/);
  });

  it('allows boot with loud warn when ALLOW_NO_AUTH=true', () => {
    let warned = '';
    expect(() =>
      configMod.assertAuthConfigured(
        { apiKey: '', apiKeysJson: {}, allowNoAuth: true },
        { warn: (m) => (warned = m) },
      ),
    ).not.toThrow();
    expect(warned).toMatch(/AUTH DISABLED/);
  });

  it('passes when a root API_KEY is set (ALLOW_NO_AUTH irrelevant)', () => {
    expect(() =>
      configMod.assertAuthConfigured(
        { apiKey: 'k', apiKeysJson: {}, allowNoAuth: false },
        silent,
      ),
    ).not.toThrow();
  });

  it('passes when only named keys are set', () => {
    expect(() =>
      configMod.assertAuthConfigured(
        { apiKey: '', apiKeysJson: { abc: 'erp' }, allowNoAuth: false },
        silent,
      ),
    ).not.toThrow();
  });
});

describe('bearerAuthHook — Fastify integration', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.addHook('onRequest', auth.bearerAuthHook);
    app.get('/protected', async () => ({ ok: true }));
    await app.ready();
  });

  it('rejects request without Authorization header (401)', async () => {
    // Ensure auth is on for this test.
    (configMod.config as { apiKey: string }).apiKey = TEST_KEY;

    const r = await app.inject({ method: 'GET', url: '/protected' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'Authorization: Bearer <token> required' });
  });

  it('rejects request with wrong token (401)', async () => {
    (configMod.config as { apiKey: string }).apiKey = TEST_KEY;

    const r = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'invalid api key' });
  });

  it('accepts request with correct token', async () => {
    (configMod.config as { apiKey: string }).apiKey = TEST_KEY;

    const r = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('is a no-op when API_KEY is empty AND ALLOW_NO_AUTH=true (dev mode)', async () => {
    (configMod.config as { apiKey: string }).apiKey = '';
    (configMod.config as { apiKeysJson: Record<string, string> }).apiKeysJson = {};
    (configMod.config as { allowNoAuth: boolean }).allowNoAuth = true;

    const r = await app.inject({ method: 'GET', url: '/protected' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });

    (configMod.config as { allowNoAuth: boolean }).allowNoAuth = false;
  });

  it('fails closed (500) when API_KEY empty and ALLOW_NO_AUTH unset', async () => {
    (configMod.config as { apiKey: string }).apiKey = '';
    (configMod.config as { apiKeysJson: Record<string, string> }).apiKeysJson = {};
    (configMod.config as { allowNoAuth: boolean }).allowNoAuth = false;

    const r = await app.inject({ method: 'GET', url: '/protected' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'server auth misconfigured' });

    (configMod.config as { apiKey: string }).apiKey = TEST_KEY;
  });

  it('rejects malformed header (Basic instead of Bearer)', async () => {
    (configMod.config as { apiKey: string }).apiKey = TEST_KEY;

    const r = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(r.statusCode).toBe(401);
  });
});
