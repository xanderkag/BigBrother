/**
 * MultiPassLlmParser — дедуп позиций при склейке кусков Pass 2.
 *
 * Прод-кейс: длинный счёт (OCR-текст 15-24KB) бьётся на 2-3 куска; OCR
 * повторяет табличный блок постранично, модель ре-эмитит одни и те же строки
 * в каждом куске → extracted.items раздувается (9 позиций × 3 = 27). При
 * раздутом items срабатывает пересчёт _totals_recomputed. Фикс: дедуп по
 * подписи содержимого (code|name|qty|price) при merge.
 */

import { describe, it, expect, vi } from 'vitest';

// Минимум env для транзитивного config.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { MultiPassLlmParser } from '../src/pipeline/parsers/multipass-llm.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';

/**
 * Mock LLM: Pass 1 (header, схема без items) возвращает шапку; каждый
 * Pass-2 кусок (схема с items) возвращает ОДИН И ТОТ ЖЕ набор из 3 позиций —
 * симулируем постранично повторённую таблицу.
 */
function mockLlm(): { llm: LlmClient; extractCalls: number } {
  const sample = [
    { code: 'A-1', name: 'Болт М6', quantity: 10, price: 5.5 },
    { code: 'A-2', name: 'Гайка М6', quantity: 20, price: 2.25 },
    { code: 'A-3', name: 'Шайба', quantity: 30, price: 0.75 },
  ];
  const state = { extractCalls: 0 };
  const llm: LlmClient = {
    isAvailable: () => true,
    supportsVision: async () => false,
    classify: vi.fn(),
    extract: vi.fn(async (input: { schema?: { properties?: Record<string, unknown> } }) => {
      state.extractCalls++;
      const props = input.schema?.properties ?? {};
      if ('items' in props) {
        // Pass 2: каждый кусок отдаёт полный набор (имитация повтора таблицы).
        return { extracted: { items: sample.map((s) => ({ ...s })) }, confidence: 0.8, issues: [] };
      }
      // Pass 1: header.
      return { extracted: { number: 'INV-1' }, confidence: 0.7, issues: [] };
    }),
    visionOcr: vi.fn(),
    verify: vi.fn(),
  };
  return { llm, extractCalls: state.extractCalls };
}

describe('MultiPassLlmParser dedups repeated items on merge', () => {
  it('collapses the same 3 items emitted across 3 chunks into 3 (not 9)', async () => {
    const { llm } = mockLlm();
    const parser = new MultiPassLlmParser(llm, 'invoice', {
      headerHeadBytes: 10,
      headerTailBytes: 10,
      chunkSizeBytes: 20, // мелкий chunk → несколько кусков из текста ниже
      maxPasses: 10,
      maxItemsTotal: 1000,
      itemsParallelism: 1,
    });
    // ~120 символов / 20 = ~6 кусков, каждый вернёт одни и те же 3 позиции.
    const longText = ('строка таблицы товаров; '.repeat(5)).slice(0, 120);
    const result = await parser.parse(longText, {
      llmSchema: { type: 'object', properties: { number: {}, items: {} } },
    });

    const items = result.extracted.items as unknown[];
    expect(Array.isArray(items)).toBe(true);
    // Без дедупа было бы 3 × (число кусков) ≥ 6; с дедупом — ровно 3.
    expect(items).toHaveLength(3);
    const issues = result.extracted._issues as string[] | undefined;
    expect(issues?.some((i) => i.startsWith('multipass_items_deduped:'))).toBe(true);
  });

  it('keeps genuinely distinct items', async () => {
    const distinct = [
      { code: 'B-1', name: 'Кабель', quantity: 1, price: 100 },
      { code: 'B-2', name: 'Разъём', quantity: 4, price: 25 },
    ];
    let call = 0;
    const llm: LlmClient = {
      isAvailable: () => true,
      supportsVision: async () => false,
      classify: vi.fn(),
      extract: vi.fn(async (input: { schema?: { properties?: Record<string, unknown> } }) => {
        const props = input.schema?.properties ?? {};
        if ('items' in props) {
          // Каждый кусок отдаёт РАЗНУЮ позицию — дедуп не должен их схлопнуть.
          const item = distinct[call % distinct.length]!;
          call++;
          return { extracted: { items: [{ ...item }] }, confidence: 0.8, issues: [] };
        }
        return { extracted: { number: 'INV-2' }, confidence: 0.7, issues: [] };
      }),
      visionOcr: vi.fn(),
      verify: vi.fn(),
    };
    const parser = new MultiPassLlmParser(llm, 'invoice', {
      headerHeadBytes: 10,
      headerTailBytes: 10,
      chunkSizeBytes: 40,
      maxPasses: 10,
      maxItemsTotal: 1000,
      itemsParallelism: 1,
    });
    const longText = 'a'.repeat(100);
    const result = await parser.parse(longText, {
      llmSchema: { type: 'object', properties: { number: {}, items: {} } },
    });
    const items = result.extracted.items as unknown[];
    expect(items.length).toBeGreaterThanOrEqual(2);
  });
});
