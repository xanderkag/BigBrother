/**
 * Config startup validation — fail-closed hardening (audit H1 / M1).
 *
 *   - loadConfig(env) accepts an explicit env map, so bounds (M1) are tested
 *     in isolation without mutating process.env.
 *   - assertRuntimeConfig is a pure guard over the resolved config (H1).
 *
 * Minimal required env so the base schema parses (these have no defaults).
 */

import { describe, it, expect, beforeAll } from 'vitest';

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://test:test@localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_DIR: '/tmp/docsvc-test',
  WEBHOOK_HMAC_SECRET: 'test',
  API_KEY: 'test-secret-key-12345',
};

let configMod: typeof import('../src/config.js');

beforeAll(async () => {
  // Ensure the module-level loadConfig() at import time succeeds.
  for (const [k, v] of Object.entries(BASE_ENV)) {
    process.env[k] = process.env[k] ?? (v as string);
  }
  configMod = await import('../src/config.js');
});

describe('M1: confidence/threshold env bounds (0..1)', () => {
  it('accepts an in-range HYBRID_VISION_CONF_THRESHOLD', () => {
    const cfg = configMod.loadConfig({ ...BASE_ENV, HYBRID_VISION_CONF_THRESHOLD: '0.7' });
    expect(cfg.hybridRouting.visionConfThreshold).toBe(0.7);
  });

  it('rejects HYBRID_VISION_CONF_THRESHOLD > 1 (e.g. 70 meant as 0.7)', () => {
    expect(() =>
      configMod.loadConfig({ ...BASE_ENV, HYBRID_VISION_CONF_THRESHOLD: '70' }),
    ).toThrow(/between 0 and 1/);
  });

  it('rejects a negative HYBRID_VISION_CONF_THRESHOLD', () => {
    expect(() =>
      configMod.loadConfig({ ...BASE_ENV, HYBRID_VISION_CONF_THRESHOLD: '-0.1' }),
    ).toThrow(/between 0 and 1/);
  });

  it('rejects ASR_CONFIDENCE_DEFAULT out of range', () => {
    expect(() =>
      configMod.loadConfig({ ...BASE_ENV, ASR_CONFIDENCE_DEFAULT: '5' }),
    ).toThrow(/between 0 and 1/);
  });

  it('accepts bounds 0 and 1 inclusive', () => {
    const cfg = configMod.loadConfig({
      ...BASE_ENV,
      HYBRID_VISION_CONF_THRESHOLD: '0',
      ASR_CONFIDENCE_DEFAULT: '1',
    });
    expect(cfg.hybridRouting.visionConfThreshold).toBe(0);
    expect(cfg.asr.confidenceDefault).toBe(1);
  });
});

describe('H1: assertRuntimeConfig fail-closed cross-validation', () => {
  const base = {
    byoLlmEnabled: false,
    secretsEncryptionKey: '',
    asr: { enabled: false, timeoutMs: 1000, confidenceDefault: 0.8 },
    llm: { url: undefined as string | undefined, timeoutMs: 1000 },
  };

  it('passes when nothing risky is enabled', () => {
    expect(() => configMod.assertRuntimeConfig(base)).not.toThrow();
  });

  it('throws: BYO LLM enabled but SECRETS_ENCRYPTION_KEY empty', () => {
    expect(() =>
      configMod.assertRuntimeConfig({ ...base, byoLlmEnabled: true, secretsEncryptionKey: '' }),
    ).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it('passes: BYO LLM enabled with a non-empty key', () => {
    expect(() =>
      configMod.assertRuntimeConfig({
        ...base,
        byoLlmEnabled: true,
        secretsEncryptionKey: 'a'.repeat(64),
      }),
    ).not.toThrow();
  });

  it('throws: ASR enabled but LLM_INFERENCE_URL unset', () => {
    expect(() =>
      configMod.assertRuntimeConfig({
        ...base,
        asr: { ...base.asr, enabled: true },
        llm: { url: undefined, timeoutMs: 1000 },
      }),
    ).toThrow(/LLM_INFERENCE_URL/);
  });

  it('passes: ASR enabled with an inference URL set', () => {
    expect(() =>
      configMod.assertRuntimeConfig({
        ...base,
        asr: { ...base.asr, enabled: true },
        llm: { url: 'http://inference:8000', timeoutMs: 1000 },
      }),
    ).not.toThrow();
  });
});
