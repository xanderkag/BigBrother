/**
 * llm_prompt override end-to-end (doc-service side).
 *
 * Покрывает три уровня:
 *   1. resolveConfigFromRow:   row.llm_prompt → ResolvedTypeConfig.llmPrompt.
 *   2. GenericLlmParser:       override.llmPrompt → LlmClient.extract({ promptOverride }).
 *   3. Phase 1/2 parsers:      override.llmPrompt доходит до LLM-fallback'а.
 */

import { describe, it, expect, vi } from 'vitest';

// Минимум env для транзитивного config.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { resolveConfigFromRow } from '../src/pipeline/document-type-resolver.js';
import type { DocumentTypeRow } from '../src/storage/document-types.js';
import { GenericLlmParser } from '../src/pipeline/parsers/generic-llm.js';
import { TtnParser } from '../src/pipeline/parsers/ttn.js';
import { InvoiceParser } from '../src/pipeline/parsers/invoice.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';

function row(overrides: Partial<DocumentTypeRow> = {}): DocumentTypeRow {
  return {
    slug: 'commercial_invoice',
    display_name: 'Commercial Invoice',
    description: null,
    is_active: true,
    is_builtin: false,
    parser_kind: 'llm_extract',
    llm_prompt: null,
    llm_schema: null,
    expected_fields: [],
    validators: [],
    confidence_threshold: null,
    regex_fallback_threshold: null,
    classification_keywords: [],
    metadata: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function mockLlm(): { llm: LlmClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const llm: LlmClient = {
    isAvailable: () => true,
    classify: vi.fn(),
    extract: vi.fn(async (input) => {
      calls.push(input as Record<string, unknown>);
      return { extracted: { ok: true }, confidence: 0.9, issues: [] };
    }),
    visionOcr: vi.fn(),
    verify: vi.fn(),
  };
  return { llm, calls };
}

describe('resolveConfigFromRow — llm_prompt', () => {
  it('returns null when row has no llm_prompt', () => {
    const cfg = resolveConfigFromRow('invoice', row({ llm_prompt: null }));
    expect(cfg.llmPrompt).toBeNull();
  });

  it('returns the prompt verbatim when set', () => {
    const cfg = resolveConfigFromRow(
      'commercial_invoice',
      row({ llm_prompt: 'You are an expert at parsing commercial invoices...' }),
    );
    expect(cfg.llmPrompt).toBe('You are an expert at parsing commercial invoices...');
  });

  it('treats whitespace-only prompt as null (защита от пустой Save из UI)', () => {
    const cfg = resolveConfigFromRow('invoice', row({ llm_prompt: '   \n\t  ' }));
    expect(cfg.llmPrompt).toBeNull();
  });

  it('null row produces fallback config with llmPrompt=null', () => {
    const cfg = resolveConfigFromRow('invoice', null);
    expect(cfg.llmPrompt).toBeNull();
    expect(cfg.source).toBe('fallback');
  });
});

describe('GenericLlmParser — пробрасывает promptOverride', () => {
  it('passes override.llmPrompt to llm.extract as promptOverride', async () => {
    const { llm, calls } = mockLlm();
    const parser = new GenericLlmParser(llm, 'commercial_invoice');
    await parser.parse('text', {
      llmSchema: { type: 'object' },
      llmPrompt: 'CUSTOM-ADMIN-INSTRUCTION',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptOverride).toBe('CUSTOM-ADMIN-INSTRUCTION');
    expect(calls[0]!.hint).toBe('commercial_invoice');
  });

  it('omits promptOverride когда override.llmPrompt не задан', async () => {
    const { llm, calls } = mockLlm();
    const parser = new GenericLlmParser(llm, 'minimal');
    await parser.parse('text', { llmSchema: {} });
    expect(calls[0]!.promptOverride).toBeUndefined();
  });
});

describe('TtnParser — Phase 2 пробрасывает promptOverride', () => {
  it('LLM extract получает promptOverride когда он задан', async () => {
    const { llm, calls } = mockLlm();
    const parser = new TtnParser(llm);
    await parser.parse('ttn raw text', {
      llmPrompt: 'TTN-CUSTOM-PROMPT',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptOverride).toBe('TTN-CUSTOM-PROMPT');
    expect(calls[0]!.hint).toBe('TTN');
  });
});

describe('InvoiceParser — Phase 1 fallback пробрасывает promptOverride', () => {
  it('regex confidence low → LLM-fallback получает promptOverride', async () => {
    const { llm, calls } = mockLlm();
    // forceLowConf — bare text без распознаваемых полей; regex confidence ~0.
    const parser = new InvoiceParser(llm);
    await parser.parse('гарбидж ???', {
      regexFallbackThreshold: 1.0, // принудительный LLM-вызов
      llmPrompt: 'INVOICE-CUSTOM-PROMPT',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptOverride).toBe('INVOICE-CUSTOM-PROMPT');
    expect(calls[0]!.hint).toBe('invoice');
  });

  it('regex confidence high → LLM не вызывается, promptOverride не передаётся', async () => {
    const { llm, calls } = mockLlm();
    const parser = new InvoiceParser(llm);
    await parser.parse(
      'Счёт № 100 от 01.05.2026 ИНН 7712345678 Итого: 50000',
      { llmPrompt: 'should-not-leak', regexFallbackThreshold: 0.5 },
    );
    expect(calls).toHaveLength(0);
  });
});
