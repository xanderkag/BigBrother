import { describe, it, expect } from 'vitest';
import { assessQuality, REQUALITY_THRESHOLD } from '../src/pipeline/quality-assessment.js';

describe('assessQuality', () => {
  const goodExtract = {
    number: 'FYTVAK167N7042',
    date: '2026-06-30',
    carrier: 'FESCO INTEGRATED TRANSPORT',
    shipper: { name: 'ZHONGSHAN JIWEN' },
    consignee: { name: 'East-West Logistic' },
  };

  it('clean extract → score 0, no requality', () => {
    const r = assessQuality({
      extracted: goodExtract,
      expectedFields: ['number', 'date', 'carrier', 'shipper', 'consignee'],
      missing: [],
      confidence: 0.9,
      rawResponse: JSON.stringify(goodExtract),
      ocrText: 'BILL OF LADING No. FYTVAK167N7042 FESCO INTEGRATED TRANSPORT',
    });
    expect(r.score).toBe(0);
    expect(r.factors).toHaveLength(0);
    expect(r.shouldRequality).toBe(false);
  });

  it('empty extract → heavy factor, requality triggered', () => {
    const r = assessQuality({
      extracted: {},
      expectedFields: ['number', 'date'],
      missing: ['number', 'date'],
      confidence: 0.72,
    });
    expect(r.factors.map((f) => f.code)).toContain('empty_extract');
    expect(r.score).toBeGreaterThanOrEqual(REQUALITY_THRESHOLD);
    expect(r.shouldRequality).toBe(true);
  });

  it('extract with only _match_signals → empty (business fields = 0)', () => {
    const r = assessQuality({
      extracted: { _match_signals: { schema_version: '1.1' } },
      expectedFields: ['number', 'date', 'carrier'],
      missing: ['number', 'date', 'carrier'],
      confidence: 0.85,
    });
    expect(r.factors.map((f) => f.code)).toContain('empty_extract');
    expect(r.shouldRequality).toBe(true);
  });

  it('confident but sparse → soft factor, below threshold alone', () => {
    const r = assessQuality({
      extracted: { number: 'X1' },
      expectedFields: ['number', 'date', 'carrier', 'shipper', 'consignee'],
      missing: ['date', 'carrier', 'shipper', 'consignee'],
      confidence: 0.85,
    });
    expect(r.factors.map((f) => f.code)).toContain('confident_sparse');
    // Один слабый фактор (0.6) не пробивает порог 1.0
    expect(r.shouldRequality).toBe(false);
  });

  it('truncated JSON → requality triggered', () => {
    const r = assessQuality({
      extracted: goodExtract,
      expectedFields: ['number'],
      missing: [],
      confidence: 0.8,
      rawResponse: '{"number":"X1","items":[{"name":"a"},{"name":',
    });
    expect(r.factors.map((f) => f.code)).toContain('truncated_json');
    expect(r.shouldRequality).toBe(true);
  });

  it('reasoning bleed → requality triggered', () => {
    const r = assessQuality({
      extracted: goodExtract,
      expectedFields: ['number'],
      missing: [],
      confidence: 0.8,
      rawResponse:
        "Here's my thinking process for this document. First, I need to identify the type... {\"number\":\"X1\"}",
    });
    expect(r.factors.map((f) => f.code)).toContain('reasoning_bleed');
    expect(r.shouldRequality).toBe(true);
  });

  it('garbled OCR (latin-as-cyrillic) → soft factor', () => {
    // Мусор: латиница распознана как кириллица, много смешанных токенов.
    const garbled = 'РЕЗСО ОСЕАМ МАМАСЕМЕМТ НОNG КОNG ЛИМИТЕД ВILL ОF ЛАДИNG';
    const r = assessQuality({
      extracted: goodExtract,
      expectedFields: ['number'],
      missing: [],
      confidence: 0.8,
      ocrText: garbled,
    });
    expect(r.factors.map((f) => f.code)).toContain('garbled_ocr');
  });

  it('clean bilingual OCR (separate lat/cyr words) → no garbled factor', () => {
    // Легитимный смешанный документ: слова НЕ мешают алфавиты внутри токена.
    const clean =
      'BILL OF LADING Коносамент SHIPPER Отправитель ANJI FURNITURE Мебель CHINA Китай';
    const r = assessQuality({
      extracted: goodExtract,
      expectedFields: ['number'],
      missing: [],
      confidence: 0.8,
      ocrText: clean,
    });
    expect(r.factors.map((f) => f.code)).not.toContain('garbled_ocr');
  });

  it('multiple weak factors accumulate past threshold', () => {
    // confident_sparse (0.6) + garbled_ocr (0.7) = 1.3 >= 1.0
    const r = assessQuality({
      extracted: { number: 'X1' },
      expectedFields: ['number', 'date', 'carrier', 'shipper', 'consignee'],
      missing: ['date', 'carrier', 'shipper', 'consignee'],
      confidence: 0.85,
      ocrText: 'РЕЗСО ОСЕАМ МАМАСЕМЕМТ НОNG КОNG ЛИМИТЕД ВILL ОF ЛАДИNG NUMBЕR',
    });
    expect(r.score).toBeGreaterThanOrEqual(REQUALITY_THRESHOLD);
    expect(r.shouldRequality).toBe(true);
  });
});
