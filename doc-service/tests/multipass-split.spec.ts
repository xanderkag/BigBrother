/**
 * SPEED-1 (2026-07-21): нарезка Pass 2 по бюджету ВЫХОДНЫХ токенов
 * (табличным строкам), а не только входным байтам + честный флаг обреза
 * хвоста за maxPasses (раньше — молчаливая потеря товарных строк).
 */
import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { splitForItems, MultiPassLlmParser } from '../src/pipeline/parsers/multipass-llm.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';

const csvRow = (i: number) =>
  `CHINA,PART-${i},Power board for UPS model ${i},2,145.50,291.00,POWERMAN LIMITED`;

describe('splitForItems — режим по табличным строкам', () => {
  it('90 CSV-строк при target=30 → ровно 3 куска по 30 строк', () => {
    const text = Array.from({ length: 90 }, (_, i) => csvRow(i)).join('\n');
    const chunks = splitForItems(text, 1_000_000, 30);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(c.split('\n').filter((l) => l.trim()).length).toBe(30);
    }
  });

  it('строки без разделителей (проза) не считаются табличными — режет по байтам', () => {
    const prose = Array.from({ length: 50 }, (_, i) => `Абзац текста номер ${i} без запятых`).join(
      '\n',
    );
    const chunks = splitForItems(prose, 400, 5);
    // ни одна строка не row-like → куски закрываются только по 400 байт
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(440);
  });

  it('гигантская строка без \\n режется жёстко по chunkBytes (регресс-гард)', () => {
    const blob = 'x'.repeat(1000);
    const chunks = splitForItems(blob, 200, 30);
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
  });

  it('порядок текста сохраняется, ничего не теряется', () => {
    const text = Array.from({ length: 45 }, (_, i) => csvRow(i)).join('\n');
    const chunks = splitForItems(text, 1_000_000, 20);
    expect(chunks.join('\n')).toBe(text);
  });

  it('targetRows=0 — прежняя байтовая нарезка', () => {
    const text = Array.from({ length: 40 }, (_, i) => csvRow(i)).join('\n');
    const one = splitForItems(text, 1_000_000, 0);
    expect(one).toHaveLength(1);
  });
});

describe('MultiPassLlmParser — честный обрез за maxPasses', () => {
  it('хвост за maxPasses даёт _truncated + issue, а не молчание', async () => {
    const llm: LlmClient = {
      isAvailable: () => true,
      supportsVision: async () => false,
      classify: vi.fn(),
      classifyWithCatalog: vi.fn(),
      extract: vi.fn(async (input: { schema?: { properties?: Record<string, unknown> } }) => {
        const props = input.schema?.properties ?? {};
        if ('items' in props) {
          return { extracted: { items: [{ name: 'x', quantity: 1 }] }, confidence: 0.8, issues: [] };
        }
        return { extracted: { number: 'INV-3' }, confidence: 0.7, issues: [] };
      }),
      visionOcr: vi.fn(),
      verify: vi.fn(),
    } as never;
    const parser = new MultiPassLlmParser(llm, 'invoice', {
      headerHeadBytes: 10,
      headerTailBytes: 10,
      chunkSizeBytes: 1_000_000,
      maxPasses: 2, // документ ниже даст 3 куска → 1 отрезан
      maxItemsTotal: 1000,
      itemsParallelism: 1,
      targetRowsPerChunk: 10,
    });
    const text = Array.from({ length: 30 }, (_, i) => csvRow(i)).join('\n');
    const result = await parser.parse(text, {
      llmSchema: { type: 'object', properties: { number: {}, items: {} } },
    });
    expect(result.extracted._truncated).toBe(true);
    const issues = (result.extracted._issues ?? []) as string[];
    expect(issues.some((s) => s.startsWith('multipass_chunks_truncated'))).toBe(true);
  });
});
