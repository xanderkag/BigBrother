/**
 * ParsersFactory dispatch + GenericLlmParser tests.
 *
 * Covers два кейса, которых не было раньше:
 *   - Builtin slug → типизированный парсер (InvoiceParser и т.д.) — должен
 *     быть мемоизирован, повторный вызов отдаёт ту же ссылку.
 *   - Custom slug → GenericLlmParser, который при `isAvailable()` LLM-клиента
 *     отдаёт пустую extraction (без падения) и принимает override-схему.
 */

import { describe, it, expect, vi } from 'vitest';

// Минимум env для транзитивного config.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { ParsersFactory } from '../src/pipeline/parsers/index.js';
import { GenericLlmParser } from '../src/pipeline/parsers/generic-llm.js';
import { InvoiceParser } from '../src/pipeline/parsers/invoice.js';
import { UpdParser } from '../src/pipeline/parsers/upd.js';
import { TtnParser } from '../src/pipeline/parsers/ttn.js';
import { CmrParser } from '../src/pipeline/parsers/cmr.js';
import { AktParser } from '../src/pipeline/parsers/akt.js';
import { NullLlmClient } from '../src/pipeline/llm/null-client.js';
import { isBuiltinDocumentType } from '../src/types/documents.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';

function mockLlm(extracted: Record<string, unknown>, confidence: number): LlmClient {
  return {
    isAvailable: () => true,
    supportsVision: async () => false,
    classify: vi.fn(),
    classifyWithCatalog: vi.fn(),
    extract: vi.fn().mockResolvedValue({ extracted, confidence, issues: [] }),
    visionOcr: vi.fn(),
    verify: vi.fn(),
  };
}

describe('isBuiltinDocumentType', () => {
  it.each(['invoice', 'factInvoice', 'UPD', 'TTN', 'CMR', 'AKT'])(
    'recognises %s as builtin',
    (slug) => {
      expect(isBuiltinDocumentType(slug)).toBe(true);
    },
  );

  it('rejects unknown slugs', () => {
    expect(isBuiltinDocumentType('commercial_invoice')).toBe(false);
    expect(isBuiltinDocumentType('')).toBe(false);
    expect(isBuiltinDocumentType('Invoice')).toBe(false); // case-sensitive
  });
});

describe('ParsersFactory.get', () => {
  it('returns typed parser for each builtin slug', () => {
    const factory = new ParsersFactory(new NullLlmClient());
    expect(factory.get('invoice')).toBeInstanceOf(InvoiceParser);
    expect(factory.get('factInvoice')).toBeInstanceOf(UpdParser);
    expect(factory.get('UPD')).toBeInstanceOf(UpdParser);
    expect(factory.get('TTN')).toBeInstanceOf(TtnParser);
    expect(factory.get('CMR')).toBeInstanceOf(CmrParser);
    expect(factory.get('AKT')).toBeInstanceOf(AktParser);
  });

  it('returns the SAME instance on repeated calls (builtins built once at construction)', () => {
    const factory = new ParsersFactory(new NullLlmClient());
    const a = factory.get('invoice');
    const b = factory.get('invoice');
    expect(a).toBe(b);
  });

  it('returns GenericLlmParser for custom slug', () => {
    const factory = new ParsersFactory(new NullLlmClient());
    const p = factory.get('commercial_invoice');
    expect(p).toBeInstanceOf(GenericLlmParser);
    expect(p.type).toBe('commercial_invoice');
  });

  it('memoizes generic parsers per slug', () => {
    const factory = new ParsersFactory(new NullLlmClient());
    const a = factory.get('packing_list');
    const b = factory.get('packing_list');
    expect(a).toBe(b);
    const c = factory.get('different_slug');
    expect(c).not.toBe(a);
  });
});

describe('GenericLlmParser', () => {
  it('returns empty extraction when LLM is not available', async () => {
    const parser = new GenericLlmParser(new NullLlmClient(), 'commercial_invoice');
    const result = await parser.parse('any text', {
      expectedFields: ['invoice_number', 'date', 'total'],
      llmSchema: { type: 'object' },
    });
    expect(result.extracted).toEqual({});
    expect(result.confidence).toBe(0);
    // expectedFields → все попадают в missing
    expect(result.missing).toEqual(['invoice_number', 'date', 'total']);
  });

  it('forwards schema and hint to LLM /extract', async () => {
    const customSchema = {
      type: 'object',
      properties: { tracking_number: { type: 'string' } },
    };
    const llm = mockLlm({ tracking_number: 'AWB-12345' }, 0.95);
    const parser = new GenericLlmParser(llm, 'air_waybill');
    const result = await parser.parse('AWB scan text', {
      expectedFields: ['tracking_number'],
      llmSchema: customSchema,
    });
    expect(result.extracted).toEqual({ tracking_number: 'AWB-12345' });
    expect(result.confidence).toBe(0.95);
    expect(result.missing).toEqual([]);

    // LLM получил slug как hint и нашу схему.
    const callArg = (llm.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.hint).toBe('air_waybill');
    expect(callArg.schema).toEqual(customSchema);
  });

  it('works without override — пустые fields/schema, не падает', async () => {
    const llm = mockLlm({ some_field: 'value' }, 0.5);
    const parser = new GenericLlmParser(llm, 'minimal_type');
    const result = await parser.parse('text', undefined);
    expect(result.extracted).toEqual({ some_field: 'value' });
    // expectedFields = [] → ничего не missing
    expect(result.missing).toEqual([]);

    const callArg = (llm.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.schema).toEqual({}); // дефолт пустая схема
  });

  it('type property exposes the slug — оркестратор использует его как label', () => {
    const parser = new GenericLlmParser(new NullLlmClient(), 'my_custom_slug');
    expect(parser.type).toBe('my_custom_slug');
  });
});
