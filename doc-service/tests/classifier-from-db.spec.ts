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
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
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

  it('счёт ВРАЗРЯДКУ «С Ч Е Т №» + SWIFT-блок → invoice, не wire_transfer (Q-INVOICE-1)', async () => {
    // Реальный кейс с прода: транспортный счёт с банковскими блоками (SWIFT для
    // RUB/EUR/USD) уезжал в wire_transfer_application (платёжку без позиций),
    // потому что заголовок «С Ч Е Т» вразрядку, а старый invoice-ключ его не ловил.
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
      row({
        slug: 'invoice',
        classification_keywords: [
          '(?:^|\\W)сч[её]т\\s+(?:№|no|#)',
          '(?:^|\\W)с\\s*ч\\s*[её]\\s*т\\s*(?:№|no|n°|nº|#|на\\s+оплату)',
        ],
        classification_keyword_weights: [5, 6],
      }),
      row({
        slug: 'wire_transfer_application',
        classification_keywords: ['\\bSWIFT\\b.{0,40}\\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2,5}\\b'],
        classification_keyword_weights: [2],
      }),
    ]);

    const r = await new KeywordClassifier().classify(
      'ООО «КрафтТранс»\nС Ч Е Т № 260525/015/2 от 27.05.2026\nЗаказчик: ...\n' +
        'Для оплаты в RUB: Счёт 40702..., SWIFT: RZBMRUMM',
    );
    expect(r.type).toBe('invoice');
  });

  it('настоящая платёжка («заявление на перевод») остаётся wire_transfer (не задета фиксом)', async () => {
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
      row({
        slug: 'invoice',
        classification_keywords: ['(?:^|\\W)с\\s*ч\\s*[её]\\s*т\\s*(?:№|no|n°|nº|#|на\\s+оплату)'],
        classification_keyword_weights: [6],
      }),
      row({
        slug: 'wire_transfer_application',
        classification_keywords: ['заявление\\s+на\\s+перевод'],
        classification_keyword_weights: [5],
      }),
    ]);

    const r = await new KeywordClassifier().classify(
      'ЗАЯВЛЕНИЕ НА ПЕРЕВОД № 7 от 01.06.2026\nПлательщик: ...\nBeneficiary: ...',
    );
    expect(r.type).toBe('wire_transfer_application');
  });

  it('ДЕКЛАРАЦИЯ НА ТОВАРЫ с «на основании доверенности» → customs_declaration, не PoA (Q-GTD-1)', async () => {
    // ГТД: декларант действует «на основании доверенности» → раньше PoA (голый
    // `доверенность` w6) бил декларацию (w5). Теперь декларация w8 + PoA анкер на заголовок.
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
      row({
        slug: 'customs_declaration',
        classification_keywords: ['(?:^|\\W)декларация\\s+на\\s+товары(?:\\W|$)', '(?:^|\\W)ГТД(?:\\W|$)'],
        classification_keyword_weights: [8, 5],
      }),
      row({
        slug: 'power_of_attorney',
        classification_keywords: ['(?:^|\\n)\\s*доверенность', 'м-2', 'уполномочивает'],
        classification_keyword_weights: [6, 5, 3],
      }),
    ]);
    const r = await new KeywordClassifier().classify(
      'ДЕКЛАРАЦИЯ НА ТОВАРЫ\n2 Отправитель: NINGBO EAST-WEST\n14 Декларант: ООО «Ист-Вест» на основании доверенности №16',
    );
    expect(r.type).toBe('customs_declaration');
  });

  it('реальная ДОВЕРЕННОСТЬ (заголовок строки) остаётся power_of_attorney', async () => {
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
      row({
        slug: 'power_of_attorney',
        classification_keywords: ['(?:^|\\n)\\s*доверенность', 'уполномочивает'],
        classification_keyword_weights: [6, 3],
      }),
      row({
        slug: 'customs_declaration',
        classification_keywords: ['(?:^|\\W)декларация\\s+на\\s+товары(?:\\W|$)'],
        classification_keyword_weights: [8],
      }),
    ]);
    const r = await new KeywordClassifier().classify(
      'ДОВЕРЕННОСТЬ № 5 от 01.06.2026\nООО «Ромашка» уполномочивает Иванова И.И. представлять интересы',
    );
    expect(r.type).toBe('power_of_attorney');
  });

  it('hardcoded fallback фурычит если БД пустая (свежий dev-стенд)', async () => {
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([]);

    const r = await new KeywordClassifier().classify(
      'УНИВЕРСАЛЬНЫЙ ПЕРЕДАТОЧНЫЙ ДОКУМЕНТ № У-1 от 01.05.2026',
    );
    expect(r.type).toBe('UPD');
  });

  it('falls through to hardcoded если DB-правила не подошли', async () => {
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
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
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([]);
    const r = await new KeywordClassifier().classify('Some random text');
    expect(r.type).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('admin может перебить builtin: DB-rule с тем же slug заменяет hardcoded', async () => {
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
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
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
      row({
        slug: 'bad_type',
        classification_keywords: ['[unclosed bracket', 'valid_keyword'],
      }),
    ]);

    const r = await new KeywordClassifier().classify('valid_keyword in the text');
    expect(r.type).toBe('bad_type');
  });

  it('per-type weight из metadata.classification_weight применяется', async () => {
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([
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
    // Both keyword'а попадают в title-window (chars 0-500) → оба получают
    // ×1.5 title-boost (feature 2026-05-18). high_priority: 0.9×1.5=1.35,
    // clamp'ится к 1.0 на выходе. Контракт теста — относительный порядок
    // (high > low), а не точное значение confidence.
    expect(r.confidence).toBe(1.0);
  });
});
