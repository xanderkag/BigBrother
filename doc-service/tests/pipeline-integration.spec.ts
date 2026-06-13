/**
 * Integration test for the post-OCR pipeline (`runDocumentPipeline`).
 *
 * Doesn't touch the database, queue, file system, or external services.
 * Imports the same orchestrator wiring used in production — meaning the
 * KeywordClassifier, the parser registry, and the LLM client (which falls
 * back to NullLlmClient when LLM_INFERENCE_URL is unset, as it is in
 * tests). Exercises the full classify → parse → confidence path with
 * realistic Russian document text.
 *
 * For the LLM-backed Phase 2 parsers, this test asserts graceful
 * degradation: with no LLM configured, the pipeline still completes,
 * just with empty extraction and a populated `missing` list.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import pino from 'pino';

// Force LLM client into "not configured" mode for these tests, regardless of
// the developer's local .env. The orchestrator reads config at module load,
// so the assignment must happen before the import.
process.env.LLM_INFERENCE_URL = '';
process.env.YANDEX_VISION_API_KEY = '';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const log = pino({ level: 'silent' });

let runDocumentPipeline: typeof import('../src/pipeline/orchestrator.js').runDocumentPipeline;

beforeAll(async () => {
  // Dynamic import after env is set so the orchestrator picks up our values.
  ({ runDocumentPipeline } = await import('../src/pipeline/orchestrator.js'));
});

const SAMPLE_INVOICE = `
  Счёт № 0042 от 15.03.2026 г.

  Поставщик: ООО "Ромашка"
  ИНН 7712345678 КПП 771201001
  Адрес: 125009, г. Москва, ул. Тверская, д. 1

  Покупатель: ООО "Василёк"
  ИНН 7798765432 КПП 779801001

  Наименование товара/услуги:
    1. Бумага А4 — 100 пачек × 250 руб = 25 000 руб
    2. Степлер — 5 шт × 500 руб = 2 500 руб

  Итого без НДС: 22 916,67
  НДС 20%: 4 583,33
  Итого к оплате: 27 500,00 руб.
`;

const SAMPLE_UPD = `
  Универсальный передаточный документ № У-2026-100 от 02.04.2026

  Продавец: ООО "Ромашка"  ИНН 7712345678
  Покупатель: ООО "Василёк" ИНН 7798765432

  Всего к оплате: 100 000,00
  В том числе НДС 20%: 16 666,67
`;

const SAMPLE_TTN = `
  ТРАНСПОРТНАЯ НАКЛАДНАЯ № 555 от 10.04.2026

  Грузоотправитель: ООО "Логистика+", ИНН 7712345678
  Грузополучатель: ИП Иванов И.И., ИНН 771234567890

  Транспортное средство: МАЗ-5440, государственный номер А123БВ77
  Водитель: Петров П.П.

  Маршрут:
    Погрузка: г. Москва, склад №3
    Разгрузка: г. Санкт-Петербург, ул. Ленина 100

  Груз: Бытовая техника, 50 мест, брутто 2000 кг, нетто 1850 кг.
`;

const SAMPLE_NOISE = 'lorem ipsum dolor sit amet, consectetur adipiscing elit';

describe('runDocumentPipeline — Phase 1 (regex parsers)', () => {
  it('classifies and extracts a Russian invoice', async () => {
    const r = await runDocumentPipeline(SAMPLE_INVOICE, {}, log);

    expect(r.documentType).toBe('invoice');
    expect(r.classificationSource).toBe('keyword');
    expect(r.extracted.number).toBe('0042');
    expect(r.extracted.date).toBe('2026-03-15');
    expect(r.extracted.total).toBe(27500);
    expect(r.extracted.vat).toBe(4583.33);
    expect(r.extracted.vat_rate).toBe(20);
    expect(r.parserConfidence).toBeGreaterThan(0.6);
    expect(r.parserMissing).not.toContain('total');
  });

  it('classifies and extracts UPD', async () => {
    const r = await runDocumentPipeline(SAMPLE_UPD, {}, log);

    expect(r.documentType).toBe('UPD');
    expect(r.extracted.number).toBe('У-2026-100');
    expect(r.extracted.date).toBe('2026-04-02');
    expect(r.extracted.total).toBe(100000);
  });

  it('honours hint over keyword classification', async () => {
    const r = await runDocumentPipeline(SAMPLE_INVOICE, { hint: 'UPD' }, log);
    expect(r.documentType).toBe('UPD');
    expect(r.classificationSource).toBe('hint');
  });
});

describe('runDocumentPipeline — Phase 2 (LLM parsers, NullLlmClient)', () => {
  it('classifies TTN but degrades to empty extraction without LLM', async () => {
    const r = await runDocumentPipeline(SAMPLE_TTN, {}, log);

    // Classification still works — keyword classifier is offline-only.
    expect(r.documentType).toBe('TTN');
    expect(r.classificationSource).toBe('keyword');

    // Extraction degrades gracefully: no domain fields extracted. Normalize
    // still injects the _match_signals envelope (schema_version marker) for
    // every typed extraction (PD-CONTRACT-1 §2.1) — strip meta before the check.
    const { _match_signals, _normalized_fields, _field_confidence, ...domain } =
      r.extracted as Record<string, unknown>;
    expect(domain).toEqual({});
    expect(r.parserConfidence).toBe(0);
    expect(r.parserMissing).toContain('shipper');
    expect(r.parserMissing).toContain('cargo');
    expect(r.parserMissing).toContain('vehicle');
  });
});

describe('runDocumentPipeline — edge cases', () => {
  it('returns nulls when no document type can be inferred', async () => {
    const r = await runDocumentPipeline(SAMPLE_NOISE, {}, log);
    expect(r.documentType).toBeNull();
    expect(r.extracted).toEqual({});
    expect(r.parserConfidence).toBeUndefined();
    expect(r.parserMissing).toEqual([]);
  });

  it('uses hint even when classifier would disagree', async () => {
    const r = await runDocumentPipeline(SAMPLE_NOISE, { hint: 'invoice' }, log);
    expect(r.documentType).toBe('invoice');
    // No fields extracted from noise; missing list reflects that.
    expect(r.parserMissing.length).toBeGreaterThan(0);
  });
});
