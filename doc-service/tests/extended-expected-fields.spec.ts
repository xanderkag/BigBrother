/**
 * Подключение EXTENDED_EXPECTED_FIELDS к резолверу (2026-07-21).
 * До фикса константа была мёртвой: missing[] у extended-типов всегда пуст,
 * контроль полноты и stats-coverage не работали.
 */
import { describe, it, expect } from 'vitest';
import { resolveConfigFromRow } from '../src/pipeline/document-type-resolver.js';
import type { DocumentTypeSlug } from '../src/types/documents.js';

function row(slug: string, over: Record<string, unknown> = {}) {
  return {
    slug,
    display_name: slug,
    description: null,
    is_active: true,
    is_builtin: false,
    parser_kind: 'llm_extract',
    llm_prompt: null,
    llm_schema: null,
    expected_fields: [] as string[],
    validators: [] as string[],
    confidence_threshold: null,
    regex_fallback_threshold: null,
    classification_keywords: [] as string[],
    metadata: null,
    resolution_config: null,
    organization_id: null,
    prefer_vision: false,
    tier: 'beta',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as never;
}

describe('resolveConfigFromRow — EXTENDED_EXPECTED_FIELDS fallback', () => {
  it('bill_of_lading с пустой колонкой → ядро из кода (7 полей)', () => {
    const cfg = resolveConfigFromRow('bill_of_lading' as DocumentTypeSlug, row('bill_of_lading'));
    expect(cfg.expectedFields).toEqual([
      'number',
      'date',
      'shipper',
      'consignee',
      'port_of_loading',
      'port_of_discharge',
      'containers',
    ]);
  });

  it('waybill / transport_request получают свои списки', () => {
    expect(
      resolveConfigFromRow('waybill' as DocumentTypeSlug, row('waybill')).expectedFields,
    ).toContain('odometer_start');
    expect(
      resolveConfigFromRow('transport_request' as DocumentTypeSlug, row('transport_request'))
        .expectedFields,
    ).toContain('rate');
  });

  it('builtin-мапа приоритетнее extended (CMR — исторический список)', () => {
    const cfg = resolveConfigFromRow('CMR' as DocumentTypeSlug, row('CMR'));
    expect(cfg.expectedFields).toContain('place_of_delivery');
  });

  it('непустая БД-колонка перекрывает оба fallback', () => {
    const cfg = resolveConfigFromRow(
      'bill_of_lading' as DocumentTypeSlug,
      row('bill_of_lading', { expected_fields: ['custom_only'] }),
    );
    expect(cfg.expectedFields).toEqual(['custom_only']);
  });

  it('тип без записей в обеих мапах → пустой список (как раньше)', () => {
    expect(
      resolveConfigFromRow('price_list' as DocumentTypeSlug, row('price_list')).expectedFields,
    ).toEqual([]);
  });
});
