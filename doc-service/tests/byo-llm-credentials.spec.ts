/**
 * EXT-B (Q11): per-request BYO LLM credentials via X-LLM-* headers.
 *
 * Покрытие:
 *   (a) headers present + enabled → inline-provider используется: ad-hoc
 *       HttpLlmClient шлёт запрос на header-supplied base_url с header-model и
 *       header-key, НЕ на default LLM_INFERENCE_URL / default-model.
 *   (b) ключ НИКОГДА не светится: encrypt → opaque envelope (без ключа);
 *       strip убирает _inline_llm_creds из metadata; last_llm_call-трасса
 *       (по структуре) не содержит api_key. Сериализуем и grep'аем.
 *   (c) флаг off → заголовки не принимаются (route отдаёт 400; здесь проверяем
 *       gating-выражение + что readInlineCredHeaders сам по себе детектит).
 *   (d) обе метрики инкрементятся.
 *
 * Сети не касаемся — undici.request замокан. БД/Redis не нужны (юнит-уровень,
 * как profile-enforcement.spec).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// undici.request замокан — перехватываем URL/headers/body без сети.
const requestMock = vi.fn(async () => ({
  statusCode: 200,
  body: {
    json: async () => ({ type: 'invoice', confidence: 0.9 }),
    text: async () => '',
  },
}));
vi.mock('undici', () => ({ request: (...a: unknown[]) => requestMock(...a) }));

import {
  readInlineCredHeaders,
  encryptInlineCredentials,
  decryptInlineCredentials,
  stripInlineCredentials,
  classifyLlmError,
  INLINE_CREDS_METADATA_KEY,
  type InlineLlmCredentials,
} from '../src/pipeline/llm/inline-credentials.js';
import { dynamicLlm } from '../src/pipeline/llm/provider-resolver.js';
import { loadConfig } from '../src/config.js';
import {
  registry,
  llmCredentialsSuppliedTotal,
  llmProviderErrorsTotal,
} from '../src/metrics.js';

const SECRET_KEY = 'sk-byo-super-secret-key-1234567890';

const CREDS: InlineLlmCredentials = {
  provider: 'openai_compatible',
  apiKey: SECRET_KEY,
  model: 'byo-model-xl',
  baseUrl: 'http://byo-endpoint.example:1234',
};

beforeEach(() => {
  requestMock.mockClear();
});

describe('readInlineCredHeaders', () => {
  it('returns present=false when no X-LLM-* headers', () => {
    const r = readInlineCredHeaders({ 'content-type': 'x' } as never);
    expect(r.present).toBe(false);
    expect(r.creds).toBeNull();
  });

  it('parses a complete header set', () => {
    const r = readInlineCredHeaders({
      'x-llm-provider': 'claude',
      'x-llm-api-key': SECRET_KEY,
      'x-llm-model': 'claude-3-7',
      'x-llm-base-url': 'http://x:1',
    });
    expect(r.present).toBe(true);
    expect(r.creds).toEqual({
      provider: 'claude',
      apiKey: SECRET_KEY,
      model: 'claude-3-7',
      baseUrl: 'http://x:1',
    });
  });

  it('present but incomplete (no api-key) → creds=null (route → 400)', () => {
    const r = readInlineCredHeaders({ 'x-llm-provider': 'claude' });
    expect(r.present).toBe(true);
    expect(r.creds).toBeNull();
  });

  it('present but incomplete (no provider) → creds=null', () => {
    const r = readInlineCredHeaders({ 'x-llm-api-key': SECRET_KEY });
    expect(r.present).toBe(true);
    expect(r.creds).toBeNull();
  });
});

describe('(c) flag off → gating', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgres://t:t@localhost/t',
    REDIS_URL: 'redis://localhost:6379',
    STORAGE_DIR: '/tmp/x',
    WEBHOOK_HMAC_SECRET: 'x',
  };

  it('loadConfig defaults byoLlmEnabled to false when env unset (fail-closed)', () => {
    expect(loadConfig({ ...baseEnv }).byoLlmEnabled).toBe(false);
  });

  it('loadConfig honours BYO_LLM_ENABLED=true', () => {
    expect(loadConfig({ ...baseEnv, BYO_LLM_ENABLED: 'true' }).byoLlmEnabled).toBe(true);
  });

  it('route gating expression: present && !enabled → reject (400 BYO_LLM_DISABLED)', () => {
    const present = readInlineCredHeaders({ 'x-llm-api-key': SECRET_KEY, 'x-llm-provider': 'claude' }).present;
    const enabled = false;
    expect(present && !enabled).toBe(true);
  });
});

describe('(b) redaction — key never serialized', () => {
  it('encrypt produces an opaque envelope that does NOT contain the key', () => {
    const env = encryptInlineCredentials(CREDS);
    expect(env.startsWith('v1:')).toBe(true);
    expect(env).not.toContain(SECRET_KEY);
    expect(JSON.stringify(env)).not.toContain(SECRET_KEY);
  });

  it('decrypt roundtrips the creds', () => {
    const env = encryptInlineCredentials(CREDS);
    expect(decryptInlineCredentials(env)).toEqual(CREDS);
  });

  it('decrypt fails-soft to null on garbage / tampering', () => {
    expect(decryptInlineCredentials('not-an-envelope')).toBeNull();
    expect(decryptInlineCredentials('v1:Zm9vYmFy')).toBeNull();
    expect(decryptInlineCredentials(undefined)).toBeNull();
    expect(decryptInlineCredentials(42)).toBeNull();
  });

  it('strip removes _inline_llm_creds from metadata before it goes outbound', () => {
    const env = encryptInlineCredentials(CREDS);
    const metadata = { foo: 'bar', [INLINE_CREDS_METADATA_KEY]: env };
    const stripped = stripInlineCredentials(metadata);
    expect(stripped).toEqual({ foo: 'bar' });
    expect(JSON.stringify(stripped)).not.toContain(env);
    expect(JSON.stringify(stripped)).not.toContain(SECRET_KEY);
  });

  it('strip is a no-op for null / arrays / object without the key', () => {
    expect(stripInlineCredentials(null)).toBeNull();
    expect(stripInlineCredentials({ a: 1 })).toEqual({ a: 1 });
    expect(stripInlineCredentials([1, 2])).toEqual([1, 2]);
  });

  it('a serialized job-payload (queue/DB shape) never exposes the plaintext key', () => {
    // Mirror what the route stashes into metadata + what the queue carries.
    const env = encryptInlineCredentials(CREDS);
    const queuePayload = { jobId: 'job-1', requestId: 'req-1' };
    const jobRowMetadata = { redact_pii: true, [INLINE_CREDS_METADATA_KEY]: env };
    const blob = JSON.stringify({ queuePayload, jobRowMetadata });
    // The encrypted envelope may be present in the DB row (that's allowed —
    // it's opaque ciphertext), but the PLAINTEXT key must never be.
    expect(blob).not.toContain(SECRET_KEY);
  });

  it('classifyLlmError never echoes the raw message (no key leak path)', () => {
    const codes = [
      classifyLlmError(new Error(`LLM /v1/extract 401: invalid key ${SECRET_KEY}`)),
      classifyLlmError(new Error('LLM /v1/extract 503: upstream down')),
      classifyLlmError(new Error('connect ECONNREFUSED 1.2.3.4:1234')),
      classifyLlmError(new Error('Headers Timeout Error')),
      classifyLlmError(new Error('weird')),
    ];
    expect(codes).toEqual(['http_4xx', 'http_5xx', 'network', 'timeout', 'unknown']);
    for (const c of codes) expect(c).not.toContain(SECRET_KEY);
  });
});

describe('(a) inline provider is used (not default) under withInlineCredentials', () => {
  it('routes classify to header base_url with header model + key', async () => {
    await dynamicLlm.withInlineCredentials(CREDS, async () => {
      await dynamicLlm.classify('some document text');
    });

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [url, opts] = requestMock.mock.calls[0] as [string, Record<string, unknown>];

    // Hit the BYO base_url, NOT the default LLM_INFERENCE_URL.
    expect(url).toBe('http://byo-endpoint.example:1234/v1/classify');
    expect(url).not.toContain('default-inference');

    const headers = opts.headers as Record<string, string>;
    // MTI-3 «PR 2» (2026-07-23): Authorization больше НЕ несёт LLM-ключ.
    // interServiceKey не задан в тесте → заголовка Authorization нет вовсе.
    // LLM-ключ уходит только в body.api_key (проверка ниже).
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    // Header-supplied model wins.
    expect(body.model).toBe('byo-model-xl');
    expect(body.text).toBe('some document text');
    // LLM-ключ в body.api_key — inference читает его в BackendOverrideMixin
    // (VANGA-LLM-2) → resolve_backend() → ephemeral SDK-клиент под этот ключ.
    expect(body.api_key).toBe(SECRET_KEY);
  });

  it('the ad-hoc inline client is scoped — gone outside withInlineCredentials', async () => {
    // No default LLM configured in the test env, so outside the BYO ALS scope
    // the resolver yields the NullLlmClient (throws "not configured"). This
    // proves the header-supplied client lived ONLY inside the context and the
    // key/endpoint did not leak into the cached default delegate.
    dynamicLlm.invalidate();
    await expect(dynamicLlm.classify('text')).rejects.toThrow('not configured');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('(d) metrics increment', () => {
  async function counterValue(name: string, labels: Record<string, string>): Promise<number> {
    const metrics = await registry.getMetricsAsJSON();
    const m = metrics.find((x) => x.name === name);
    if (!m) return 0;
    const sample = (m.values as Array<{ value: number; labels: Record<string, string> }>).find(
      (v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val),
    );
    return sample?.value ?? 0;
  }

  it('credentials_supplied_total increments by provider', async () => {
    const before = await counterValue(
      'docservice_extractor_llm_credentials_supplied_total',
      { provider: 'openai_compatible' },
    );
    llmCredentialsSuppliedTotal.inc({ provider: 'openai_compatible' });
    const after = await counterValue(
      'docservice_extractor_llm_credentials_supplied_total',
      { provider: 'openai_compatible' },
    );
    expect(after).toBe(before + 1);
  });

  it('provider_errors_total increments by provider + redacted code', async () => {
    const before = await counterValue(
      'docservice_extractor_llm_provider_errors_total',
      { provider: 'claude', code: 'http_4xx' },
    );
    llmProviderErrorsTotal.inc({ provider: 'claude', code: classifyLlmError(new Error('LLM /v1/extract 401: bad')) });
    const after = await counterValue(
      'docservice_extractor_llm_provider_errors_total',
      { provider: 'claude', code: 'http_4xx' },
    );
    expect(after).toBe(before + 1);
  });
});
