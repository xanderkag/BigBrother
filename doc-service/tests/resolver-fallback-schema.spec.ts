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

/**
 * FIX-A (находки SLAI 2026-07-16, docs/BCTT_EXTRACT_FIXES.md).
 *
 * Регрессия (корпус БКТ, 138 док): SLAI заметил «регистр типа коррелирует с
 * качеством стопроцентно» — 3 док с типом `CMR` имели маршрут/стороны/машину,
 * все 8 с типом `cmr` были БЕЗ маршрута, а `number` содержал мусор («CMR»,
 * имя перевозчика).
 *
 * Причина: сегментация композитов ставит сегменту outbound-слаг (`cmr`), а
 * DOCUMENT_JSON_SCHEMAS/EXPECTED_FIELDS проиндексированы историческим (`CMR`).
 * Строку в БД резолвер находил (expandSlugCandidates регистр-терпим), но у неё
 * llm_schema=NULL → fallback-лукап по сырому слагу промахивался → схема `{}` →
 * в промпт уходило «выводи JSON в формате {}» → модель сочиняла.
 */
function typeRow(slug: string, llmSchema: unknown, expectedFields: string[] = []): DocumentTypeRow {
  return {
    slug,
    display_name: slug,
    description: null,
    is_active: true,
    is_builtin: true,
    parser_kind: 'llm_extract',
    llm_prompt: null,
    llm_schema: llmSchema as never,
    expected_fields: expectedFields,
    validators: [],
    confidence_threshold: null,
    regex_fallback_threshold: null,
    classification_keywords: [],
    metadata: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as DocumentTypeRow;
}

describe('resolveConfigFromRow — FIX-A: канонизация слага для builtin-лукапа', () => {
  it('cmr (сегмент композита) + llm_schema=NULL → полная CMR-схема, а НЕ {}', () => {
    // Слаг от сегментации — outbound; row из БД — исторический (как в проде).
    const cfg = resolveConfigFromRow('cmr', typeRow('CMR', null));
    const keys = propKeys(cfg);
    // Ровно те поля, ради которых SLAI строит маршрут — раньше их не было НИ У ОДНОГО.
    expect(keys).toContain('place_of_loading');
    expect(keys).toContain('place_of_delivery');
    expect(keys).toContain('border_crossing');
    expect(keys).toContain('carrier');
    expect(keys).toContain('number');
  });

  it('CMR (одиночный док) → та же схема; канонизация идемпотентна', () => {
    const lower = propKeys(resolveConfigFromRow('cmr', typeRow('CMR', null)));
    const upper = propKeys(resolveConfigFromRow('CMR', typeRow('CMR', null)));
    // Обе ветки обязаны отдавать ОДИН набор полей — это и просил SLAI (вопрос 3).
    expect(lower).toEqual(upper);
    expect(upper).toContain('place_of_loading');
  });

  it('cmr без row → тоже полная CMR-схема (не {})', () => {
    expect(propKeys(resolveConfigFromRow('cmr', null))).toContain('place_of_loading');
  });

  it('cmr + пустые expected_fields в БД → fallback на EXPECTED_FIELDS.CMR', () => {
    const cfg = resolveConfigFromRow('cmr', typeRow('CMR', null, []));
    expect(cfg.expectedFields).toContain('place_of_loading');
    expect(cfg.expectedFields).toContain('place_of_delivery');
  });

  it('радиус шире CMR: ttn / upd / tax_invoice тоже канонизируются', () => {
    expect(propKeys(resolveConfigFromRow('ttn', typeRow('TTN', null)))).toContain('number');
    expect(propKeys(resolveConfigFromRow('upd', typeRow('UPD', null)))).toContain('number');
    // tax_invoice → factInvoice (не регистр, а alias-переименование)
    expect(propKeys(resolveConfigFromRow('tax_invoice', typeRow('factInvoice', null)))).toContain('number');
  });

  it('DB-схема по-прежнему приоритетна над кодом (канонизация её не перебивает)', () => {
    const cfg = resolveConfigFromRow('cmr', typeRow('CMR', { type: 'object', properties: { items: { type: 'array' } } }));
    expect(propKeys(cfg)).toEqual(['items']);
  });

  it('не-alias слаги не задеты (invoice / waybill / bill_of_lading)', () => {
    expect(propKeys(resolveConfigFromRow('invoice', typeRow('invoice', null)))).toContain('number');
    expect(propKeys(resolveConfigFromRow('waybill', null))).toContain('number');
    expect(propKeys(resolveConfigFromRow('bill_of_lading', null))).toContain('containers');
  });
});
