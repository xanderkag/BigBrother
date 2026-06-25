/**
 * resolveConfigFromRow — fallback llm_schema на EXTENDED_SCHEMAS.
 *
 * Регрессия (боевой батч 2026-06-25): bill_of_lading с минимальным DB-skeleton
 * ({items}) извлекал только items, теряя number/shipper/consignee/containers,
 * потому что DB-схема приоритетна над полной BL_SCHEMA из кода. Фикс: при
 * llm_schema=NULL резолвер падает на EXTENDED_SCHEMAS[slug] (а не на {}).
 */
import { describe, it, expect } from 'vitest';
import { resolveConfigFromRow } from '../src/pipeline/document-type-resolver.js';
import type { DocumentTypeRow } from '../src/storage/document-types.js';

function row(llmSchema: unknown): DocumentTypeRow {
  return {
    slug: 'bill_of_lading',
    display_name: 'B/L',
    description: null,
    is_active: true,
    is_builtin: false,
    parser_kind: 'llm_extract',
    llm_prompt: null,
    llm_schema: llmSchema as never,
    expected_fields: [],
    validators: [],
    confidence_threshold: null,
    regex_fallback_threshold: null,
    classification_keywords: [],
    metadata: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as DocumentTypeRow;
}

function propKeys(cfg: { llmSchema: Record<string, unknown> }): string[] {
  const props = (cfg.llmSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(props);
}

describe('resolveConfigFromRow — EXTENDED_SCHEMAS fallback', () => {
  it('bill_of_lading с llm_schema=NULL → полная BL_SCHEMA из кода (не пусто)', () => {
    const cfg = resolveConfigFromRow('bill_of_lading', row(null));
    const keys = propKeys(cfg);
    expect(keys).toContain('number');
    expect(keys).toContain('shipper');
    expect(keys).toContain('consignee');
    expect(keys).toContain('containers');
  });

  it('минимальный DB-skeleton перекрывает код (это и была причина потери полей)', () => {
    const cfg = resolveConfigFromRow(
      'bill_of_lading',
      row({ type: 'object', properties: { items: { type: 'array' } } }),
    );
    // DB-схема приоритетна → только items. После миграции 20260625000002
    // (llm_schema=NULL) сработает ветка выше с полной BL_SCHEMA.
    expect(propKeys(cfg)).toEqual(['items']);
  });

  it('тип без row → тоже EXTENDED_SCHEMAS fallback (bill_of_lading)', () => {
    const cfg = resolveConfigFromRow('bill_of_lading', null);
    expect(propKeys(cfg)).toContain('containers');
  });
});
