/**
 * Tests for `resolveConfigFromRow` — pure folding of a `DocumentTypeRow`
 * (or `null`) into the runtime-facing `ResolvedTypeConfig`. Mocks no DB;
 * exercises only the fallback logic.
 *
 * Resolver-with-cache tests (TTL, invalidate, race) belong in an
 * integration suite with a real DB — not covered here.
 */

import { describe, it, expect } from 'vitest';

// Minimum env so config.ts loads cleanly during the transitive import chain.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { resolveConfigFromRow } from '../src/pipeline/document-type-resolver.js';
import type { DocumentTypeRow } from '../src/storage/document-types.js';

function row(overrides: Partial<DocumentTypeRow> = {}): DocumentTypeRow {
  return {
    slug: 'invoice',
    display_name: 'Invoice',
    description: null,
    is_active: true,
    is_builtin: true,
    parser_kind: 'builtin:invoice_regex',
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
  } as DocumentTypeRow;
}

describe('resolveConfigFromRow', () => {
  it('on null row: source=fallback, uses env defaults + hardcoded fields/schema', () => {
    const cfg = resolveConfigFromRow('invoice', null);
    expect(cfg.source).toBe('fallback');
    expect(cfg.slug).toBe('invoice');
    // Env defaults are 0.6 / 0.7 per .env.example.
    expect(cfg.confidenceThreshold).toBeGreaterThan(0);
    expect(cfg.regexFallbackThreshold).toBeGreaterThan(0);
    // Hardcoded fallback fields from document-json-schemas.ts.
    expect(cfg.expectedFields).toEqual(
      expect.arrayContaining(['number', 'date', 'seller', 'buyer', 'total']),
    );
    // Hardcoded fallback schema is the canonical builtin.
    expect(cfg.llmSchema).toMatchObject({ type: 'object' });
    expect(cfg.validators).toEqual([]);
  });

  it('on populated row: source=db, DB values take precedence', () => {
    const cfg = resolveConfigFromRow('TTN', row({
      slug: 'TTN',
      parser_kind: 'llm_extract',
      confidence_threshold: '0.85' as unknown as string,
      regex_fallback_threshold: '0.55' as unknown as string,
      expected_fields: ['number', 'date', 'shipper'],
      validators: ['inn_checksum:shipper.inn'],
      llm_schema: { type: 'object', properties: { custom_field: { type: 'string' } } },
    }));
    expect(cfg.source).toBe('db');
    expect(cfg.confidenceThreshold).toBe(0.85);
    expect(cfg.regexFallbackThreshold).toBe(0.55);
    expect(cfg.expectedFields).toEqual(['number', 'date', 'shipper']);
    expect(cfg.validators).toEqual(['inn_checksum:shipper.inn']);
    expect(cfg.llmSchema).toMatchObject({
      type: 'object',
      properties: { custom_field: { type: 'string' } },
    });
  });

  it('null DB columns fall back to env / hardcoded individually', () => {
    // DB row exists (so source=db), but with null thresholds and empty
    // fields — each null should pick up its own fallback.
    const cfg = resolveConfigFromRow('UPD', row({
      slug: 'UPD',
      parser_kind: 'builtin:upd_regex',
      confidence_threshold: null,
      regex_fallback_threshold: null,
      expected_fields: [],
      llm_schema: null,
    }));
    expect(cfg.source).toBe('db');
    expect(cfg.confidenceThreshold).toBeGreaterThan(0);    // from env
    expect(cfg.regexFallbackThreshold).toBeGreaterThan(0); // from env
    expect(cfg.expectedFields.length).toBeGreaterThan(0);  // from hardcoded
    expect(cfg.llmSchema).toMatchObject({ type: 'object' }); // from hardcoded
  });

  it('returns independent arrays — caller mutation does not poison cache', () => {
    const r = row({
      slug: 'AKT',
      expected_fields: ['number', 'date'],
      validators: ['date_range'],
    });
    const cfg = resolveConfigFromRow('AKT', r);
    cfg.expectedFields.push('mutated');
    cfg.validators.push('mutated');
    // Original row arrays untouched.
    expect(r.expected_fields).toEqual(['number', 'date']);
    expect(r.validators).toEqual(['date_range']);
  });
});
