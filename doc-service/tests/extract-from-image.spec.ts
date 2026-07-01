/**
 * extraction-from-image (item A) — doc-service side.
 *
 * Покрывает:
 *   1. Parser threading: override.imagePath доходит до LlmClient.extract.
 *   2. HttpLlmClient.supportsVision() отражает provider_settings.vision.
 *   3. HttpLlmClient.extract base64-кодирует файл в image_base64.
 *   4. Multipass: image идёт только в Pass 1 (header), не в items-chunks.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Минимум env для транзитивного config.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { GenericLlmParser } from '../src/pipeline/parsers/generic-llm.js';
import { TtnParser } from '../src/pipeline/parsers/ttn.js';
import { MultiPassLlmParser } from '../src/pipeline/parsers/multipass-llm.js';
import { HttpLlmClient } from '../src/pipeline/llm/http-client.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';

function mockLlm(): { llm: LlmClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const llm: LlmClient = {
    isAvailable: () => true,
    supportsVision: async () => true,
    classify: vi.fn(),
    classifyWithCatalog: vi.fn(),
    extract: vi.fn(async (input) => {
      calls.push(input as Record<string, unknown>);
      return { extracted: { ok: true }, confidence: 0.9, issues: [] };
    }),
    visionOcr: vi.fn(),
    verify: vi.fn(),
  };
  return { llm, calls };
}

describe('parsers thread override.imagePath into llm.extract', () => {
  it('GenericLlmParser forwards imagePath', async () => {
    const { llm, calls } = mockLlm();
    await new GenericLlmParser(llm, 'commercial_invoice').parse('text', {
      llmSchema: { type: 'object' },
      imagePath: '/tmp/page-1.png',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.imagePath).toBe('/tmp/page-1.png');
  });

  it('GenericLlmParser omits imagePath when not provided', async () => {
    const { llm, calls } = mockLlm();
    await new GenericLlmParser(llm, 'minimal').parse('text', { llmSchema: {} });
    expect(calls[0]!.imagePath).toBeUndefined();
  });

  it('TtnParser forwards imagePath', async () => {
    const { llm, calls } = mockLlm();
    await new TtnParser(llm).parse('ttn text', { imagePath: '/tmp/ttn.png' });
    expect(calls[0]!.imagePath).toBe('/tmp/ttn.png');
  });

  it('MultiPassLlmParser sends image only in the header pass', async () => {
    const { llm, calls } = mockLlm();
    const parser = new MultiPassLlmParser(llm, 'big_doc', {
      headerHeadBytes: 10,
      headerTailBytes: 10,
      chunkSizeBytes: 10,
      maxPasses: 5,
      maxItemsTotal: 100,
      itemsParallelism: 1,
    });
    // Длинный текст + items в схеме → будет Pass 2 (несколько кусков).
    const longText = 'x'.repeat(60);
    await parser.parse(longText, {
      llmSchema: { type: 'object', properties: { number: {}, items: {} } },
      imagePath: '/tmp/header.png',
    });
    // Header (Pass 1) — с image; все остальные (items chunks) — без.
    const withImage = calls.filter((c) => c.imagePath === '/tmp/header.png');
    const withoutImage = calls.filter((c) => c.imagePath === undefined);
    expect(withImage).toHaveLength(1);
    expect(withoutImage.length).toBeGreaterThan(0);
  });
});

describe('HttpLlmClient.supportsVision reflects provider vision flag', () => {
  it('true when vision=true', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000, vision: true });
    expect(await c.supportsVision()).toBe(true);
  });
  it('false when vision unset', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000 });
    expect(await c.supportsVision()).toBe(false);
  });
});

describe('HttpLlmClient.extract encodes image_base64 from imagePath', () => {
  it('reads the file and sends base64 image when imagePath provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docsvc-img-test-'));
    const imgPath = join(dir, 'page.png');
    const bytes = Buffer.from('FAKE-PNG-BYTES');
    await writeFile(imgPath, bytes);
    try {
      const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000, vision: true });
      // Перехватываем приватный post — проверяем тело запроса, не делая сети.
      const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).post = async (path: string, body: Record<string, unknown>) => {
        seen.push({ path, body });
        return { extracted: {}, confidence: 0, issues: [] };
      };
      await c.extract({ text: 't', schema: {}, hint: 'invoice', imagePath: imgPath });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body.image_base64).toBe(bytes.toString('base64'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits image_base64 when imagePath missing', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000, vision: true });
    const seen: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).post = async (_path: string, body: Record<string, unknown>) => {
      seen.push(body);
      return { extracted: {}, confidence: 0, issues: [] };
    };
    await c.extract({ text: 't', schema: {}, hint: 'invoice' });
    expect(seen[0]!.image_base64).toBeUndefined();
  });

  it('fails soft to text-only when the image file is unreadable', async () => {
    const c = new HttpLlmClient({ baseUrl: 'http://x', timeoutMs: 1000, vision: true });
    const seen: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).post = async (_path: string, body: Record<string, unknown>) => {
      seen.push(body);
      return { extracted: {}, confidence: 0, issues: [] };
    };
    await c.extract({ text: 't', schema: {}, hint: 'invoice', imagePath: '/nonexistent/page.png' });
    expect(seen[0]!.image_base64).toBeUndefined();
  });
});
