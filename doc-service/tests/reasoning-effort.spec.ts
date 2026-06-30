/**
 * reasoning_effort plumbing (FAST-mode для thinking-моделей, напр. qwen3.6).
 *
 * Покрывает doc-service-сторону: HttpLlmClient, получив reasoningEffort из
 * provider_settings.extra, кладёт `reasoning_effort` в тело КАЖДОГО вызова
 * (classify/extract/verify). Без опции — поле не появляется (phi4 и прочие
 * не-reasoning модели не затрагиваются).
 */

import { describe, it, expect } from 'vitest';

// Минимум env для транзитивного config.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { HttpLlmClient } from '../src/pipeline/llm/http-client.js';

function captureBody(c: HttpLlmClient): Array<{ path: string; body: Record<string, unknown> }> {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).post = async (path: string, body: Record<string, unknown>) => {
    seen.push({ path, body });
    return { type: null, confidence: 0, extracted: {}, issues: [] };
  };
  return seen;
}

describe('HttpLlmClient attaches reasoning_effort when configured', () => {
  it('extract body carries reasoning_effort', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000, reasoningEffort: 'none' });
    const seen = captureBody(c);
    await c.extract({ text: 't', schema: {}, hint: 'invoice' });
    expect(seen[0]!.body.reasoning_effort).toBe('none');
  });

  it('classify body carries reasoning_effort', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000, reasoningEffort: 'none' });
    const seen = captureBody(c);
    await c.classify('some text');
    expect(seen[0]!.body.reasoning_effort).toBe('none');
  });

  it('verify body carries reasoning_effort', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000, reasoningEffort: 'none' });
    const seen = captureBody(c);
    await c.verify({ extracted: {}, rawText: 'raw' });
    expect(seen[0]!.body.reasoning_effort).toBe('none');
  });

  it('coexists with model override', async () => {
    const c = new HttpLlmClient({
      baseUrl: 'http://x',
      timeoutMs: 1000,
      model: 'qwen3.6:27b',
      reasoningEffort: 'none',
    });
    const seen = captureBody(c);
    await c.extract({ text: 't', schema: {}, hint: 'invoice' });
    expect(seen[0]!.body.model).toBe('qwen3.6:27b');
    expect(seen[0]!.body.reasoning_effort).toBe('none');
  });
});

describe('HttpLlmClient omits reasoning_effort when not configured (phi4 unaffected)', () => {
  it('extract body has no reasoning_effort', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000, model: 'phi4' });
    const seen = captureBody(c);
    await c.extract({ text: 't', schema: {}, hint: 'invoice' });
    expect(seen[0]!.body.reasoning_effort).toBeUndefined();
    expect(seen[0]!.body.model).toBe('phi4');
  });

  it('classify body has no reasoning_effort', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000 });
    const seen = captureBody(c);
    await c.classify('text');
    expect(seen[0]!.body.reasoning_effort).toBeUndefined();
  });
});
