/**
 * KeywordClassifier — двухуровневая логика:
 *   1. DB-resolved keywords (через `documentTypeResolver.listActive()`);
 *   2. hardcoded fallback для шести builtin-типов.
 *
 * Мокаем `documentTypesRepo.listActive` — это позволяет проверить обе
 * ветки без живой БД. resolver делит TTL-кэш между тестами, поэтому
 * каждый test очищает кэш в beforeEach.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Минимум env.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { KeywordClassifier } from '../src/pipeline/classifier/keywords.js';
import { documentTypeResolver } from '../src/pipeline/document-type-resolver.js';
import { documentTypesRepo, type DocumentTypeRow } from '../src/storage/document-types.js';

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

describe('KeywordClassifier — DB keywords path', () => {
  beforeEach(() => {
    documentTypeResolver.invalidate();
    vi.restoreAllMocks();
  });

  it('classifies custom type by DB keyword (no builtin fallback hit)', async () => {
    vi.spyOn(documentTypesRepo, 'listActive').mockResolvedValue([
      row({
        slug: 'commercial_invoice',
        classification_keywords: ['\\bcommercial\\s+invoice\\b'],
      }),
    ]);

    const r = await new KeywordClassifier().classify(
      'COMMERCIAL INVOICE No. CI-2026-001\nSeller: ACME Corp\n...',
    );
    expect(r.type).toBe('commercial_invoice');
    expect(r.source).toBe('keyword');
    expect(r.matched?.toLowerCase()).toContain('commercial invoice');
  });

  it('hardcoded fallback фурычит если БД пустая (свежий dev-стенд)', async () => {
    vi.spyOn(documentTypesRepo, 'listActive').mockResolvedValue([]);

    const r = await new KeywordClassifier().classify(
      'УНИВЕРСАЛЬНЫЙ ПЕРЕДАТОЧНЫЙ ДОКУМЕНТ № У-1 от 01.05.2026',
    );
    expect(r.type).toBe('UPD');
  });

  it('falls through to hardcoded если DB-правила не подошли', async () => {
    vi.spyOn(documentTypesRepo, 'listActive').mockResolvedValue([
      row({
        slug: 'commercial_invoice',
        classification_keywords: ['\\bcommercial\\s+invoice\\b'],
      }),
    ]);

    // Текст не матчит DB-правило, но матчит hardcoded для УПД.
    const r = await new KeywordClassifier().classify('УПД № 1');
    expect(r.type).toBe('UPD');
  });

  it('null when nothing matches in DB or hardcoded', async () => {
    vi.spyOn(documentTypesRepo, 'listActive').mockResolvedValue([]);
    const r = await new KeywordClassifier().classify('Some random text');
    expect(r.type).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('admin может перебить builtin: DB-rule с тем же slug заменяет hardcoded', async () => {
    vi.spyOn(documentTypesRepo, 'listActive').mockResolvedValue([
      row({
        slug: 'invoice',
        is_builtin: true,
        // Регекс strictнее чем hardcoded — должен сматчиться только на полную фразу
        classification_keywords: ['\\bсчёт\\s+на\\s+оплату\\b'],
      }),
    ]);

    const r1 = await new KeywordClassifier().classify('Счёт на оплату № 100');
    expect(r1.type).toBe('invoice');

    // С админ-правилом «просто счёт» уже не классифицируется — мы сузили regex.
    // Но hardcoded FALLBACK_RULES всё ещё содержит /сч[её]т/ — оно сматчит.
    // Так что классификатор всё равно вернёт invoice через fallback path.
    const r2 = await new KeywordClassifier().classify('Счёт от поставщика');
    expect(r2.type).toBe('invoice'); // hardcoded fallback срабатывает
  });

  it('bad regex в БД не валит классификатор', async () => {
    vi.spyOn(documentTypesRepo, 'listActive').mockResolvedValue([
      row({
        slug: 'bad_type',
        classification_keywords: ['[unclosed bracket', 'valid_keyword'],
      }),
    ]);

    const r = await new KeywordClassifier().classify('valid_keyword in the text');
    expect(r.type).toBe('bad_type');
  });

  it('per-type weight из metadata.classification_weight применяется', async () => {
    vi.spyOn(documentTypesRepo, 'listActive').mockResolvedValue([
      row({
        slug: 'low_priority',
        classification_keywords: ['shared'],
        metadata: { classification_weight: 0.3 },
      }),
      row({
        slug: 'high_priority',
        classification_keywords: ['shared'],
        metadata: { classification_weight: 0.9 },
      }),
    ]);

    const r = await new KeywordClassifier().classify('something shared here');
    expect(r.type).toBe('high_priority');
    expect(r.confidence).toBe(0.9);
  });
});
