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

describe('booleanFromEnv: OFFICE_IMAGE_FALLBACK_ENABLED — выключаемый kill-switch', () => {
  it('не задан → дефолт true', () => {
    const cfg = configMod.loadConfig({ ...BASE_ENV });
    expect(cfg.officeImageFallback.enabled).toBe(true);
  });

  it('="false" → ВЫКЛючает (регресс z.coerce.boolean, где "false"→true)', () => {
    const cfg = configMod.loadConfig({ ...BASE_ENV, OFFICE_IMAGE_FALLBACK_ENABLED: 'false' });
    expect(cfg.officeImageFallback.enabled).toBe(false);
  });

  it('="0" / "off" / "no" → false', () => {
    for (const v of ['0', 'off', 'no', 'FALSE']) {
      const cfg = configMod.loadConfig({ ...BASE_ENV, OFFICE_IMAGE_FALLBACK_ENABLED: v });
      expect(cfg.officeImageFallback.enabled).toBe(false);
    }
  });

  it('="true" / "1" → true', () => {
    for (const v of ['true', '1']) {
      const cfg = configMod.loadConfig({ ...BASE_ENV, OFFICE_IMAGE_FALLBACK_ENABLED: v });
      expect(cfg.officeImageFallback.enabled).toBe(true);
    }
  });
});

// Регресс: раньше 13 булевых флагов сидели на z.coerce.boolean() → "false"
// давало true, и, напр., YANDEX_DISABLE_FOR_PII=false НЕ выключал PII-гард
// (CMR/ТТН упорно не шли в Yandex Vision). Мигрированы на booleanFromEnv.
describe('booleanFromEnv migration: yandex-флаги честно читают "false"', () => {
  it('YANDEX_DISABLE_FOR_PII="false" → disableForPii=false (гард выключается)', () => {
    const cfg = configMod.loadConfig({ ...BASE_ENV, YANDEX_DISABLE_FOR_PII: 'false' });
    expect(cfg.yandex.disableForPii).toBe(false);
  });

  it('YANDEX_DISABLE_FOR_PII="true" → disableForPii=true', () => {
    const cfg = configMod.loadConfig({ ...BASE_ENV, YANDEX_DISABLE_FOR_PII: 'true' });
    expect(cfg.yandex.disableForPii).toBe(true);
  });

  it('YANDEX_PREFER_FOR_SCANS="false" → preferForScans=false', () => {
    const cfg = configMod.loadConfig({ ...BASE_ENV, YANDEX_PREFER_FOR_SCANS: 'false' });
    expect(cfg.yandex.preferForScans).toBe(false);
  });

  // Крэш-регресс: пустой env-var ("") ронял boot (preprocess→undefined мимо
  // .default() → z.boolean() Required). Теперь "" → дефолт, конфиг грузится.
  it('пустая строка ("") → дефолт, а не крэш z.boolean Required', () => {
    expect(() =>
      configMod.loadConfig({ ...BASE_ENV, YANDEX_DISABLE_FOR_PII: '', ALLOW_NO_AUTH: '' }),
    ).not.toThrow();
    const cfg = configMod.loadConfig({ ...BASE_ENV, YANDEX_DISABLE_FOR_PII: '' });
    expect(cfg.yandex.disableForPii).toBe(false); // дефолт
  });
});

// audit растровых падений: tesseract зовётся напрямую с timeout+SIGKILL, OMP-
// лимитом и потолком страниц, чтобы зависший скан не держал слот воркера. Здесь
// фиксируем дефолты и то, что env их переопределяет.
describe('tesseract robustness knobs (audit растровых падений)', () => {
  it('дефолты: 90с timeout, без потолка страниц (0), 2 OMP-потока', () => {
    const cfg = configMod.loadConfig({ ...BASE_ENV });
    expect(cfg.tesseractTimeoutMs).toBe(90_000);
    expect(cfg.tesseractMaxPages).toBe(0);
    expect(cfg.tesseractOmpThreads).toBe(2);
  });

  it('env переопределяет timeout / потолок страниц / OMP-потоки', () => {
    const cfg = configMod.loadConfig({
      ...BASE_ENV,
      TESSERACT_TIMEOUT_MS: '45000',
      TESSERACT_MAX_PAGES: '20',
      TESSERACT_OMP_THREADS: '1',
    });
    expect(cfg.tesseractTimeoutMs).toBe(45_000);
    expect(cfg.tesseractMaxPages).toBe(20);
    expect(cfg.tesseractOmpThreads).toBe(1);
  });

  it('visionPageParallelism: дефолт 1 (последовательно), env поднимает под vLLM', () => {
    expect(configMod.loadConfig({ ...BASE_ENV }).visionPageParallelism).toBe(1);
    expect(
      configMod.loadConfig({ ...BASE_ENV, VISION_PAGE_PARALLELISM: '4' }).visionPageParallelism,
    ).toBe(4);
  });
});

// DEEP-PASS (docs/DEEP-PASS-SPEC.md): второй ярус выключен по умолчанию —
// дополнительный LLM/VL-вызов на каждый unknown-док включает владелец.
describe('deepPass config', () => {
  it('дефолты: выключен, 8000 символов текста, порог vision 300, imageUncertainConf 0.85', () => {
    const cfg = configMod.loadConfig({ ...BASE_ENV });
    expect(cfg.deepPass.enabled).toBe(false);
    expect(cfg.deepPass.textChars).toBe(8000);
    expect(cfg.deepPass.minTextForTextPath).toBe(300);
    expect(cfg.deepPass.imageUncertainConf).toBe(0.85);
  });

  it('env включает и переопределяет', () => {
    const cfg = configMod.loadConfig({
      ...BASE_ENV,
      DEEP_PASS_ENABLED: 'true',
      DEEP_PASS_TEXT_CHARS: '4000',
      DEEP_PASS_MIN_TEXT: '100',
      DEEP_PASS_IMAGE_UNCERTAIN_CONF: '0.6',
    });
    expect(cfg.deepPass.enabled).toBe(true);
    expect(cfg.deepPass.textChars).toBe(4000);
    expect(cfg.deepPass.minTextForTextPath).toBe(100);
    expect(cfg.deepPass.imageUncertainConf).toBe(0.6);
  });

  it('imageUncertainConf вне 0..1 → падение на boot (это доля, не проценты)', () => {
    expect(() =>
      configMod.loadConfig({ ...BASE_ENV, DEEP_PASS_IMAGE_UNCERTAIN_CONF: '85' }),
    ).toThrow(/between 0 and 1/);
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
