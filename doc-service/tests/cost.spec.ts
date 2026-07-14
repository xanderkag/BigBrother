/**
 * Стоимость ₽/док — ядро расчёта (owner-запрос 2026-07-13).
 */
import { describe, expect, it } from 'vitest';
import { computeJobCost, type CostRates } from '../src/pipeline/cost.js';

const rates: CostRates = {
  ocrPageRub: 0.13,
  ocrTableRub: 1.22,
  llmInputPer1kRub: 0.2,
  llmOutputPer1kRub: 0.3,
};
const tableTypes = new Set(['INVOICE', 'TAX_INVOICE', 'UPD']);

describe('computeJobCost', () => {
  it('yandex OCR (печатный) + LLM — типовой ВЭД-док ~4.5₽', () => {
    const c = computeJobCost(
      {
        llmUsage: { prompt_tokens: 16750, output_tokens: 3120, calls_without_usage: 0 },
        ocrEngine: 'yandex',
        ocrPages: 2,
        documentType: 'customs_export_ead',
      },
      rates,
      tableTypes,
    );
    // llm = 16.75*0.2 + 3.12*0.3 = 4.286 ; ocr = 2*0.13 = 0.26
    expect(c.breakdown.llm).toBeCloseTo(4.29, 1);
    expect(c.breakdown.ocr).toBeCloseTo(0.26, 2);
    expect(c.rub).toBeCloseTo(4.55, 1);
    expect(c.estimate).toBe(false);
  });

  it('табличный тип (invoice) → OCR по табличной ставке', () => {
    const c = computeJobCost(
      { llmUsage: { prompt_tokens: 0, output_tokens: 0, calls_without_usage: 0 }, ocrEngine: 'yandex', ocrPages: 2, documentType: 'invoice' },
      rates,
      tableTypes,
    );
    expect(c.breakdown.ocr).toBeCloseTo(2.44, 2); // 2 * 1.22
  });

  it('локальный OCR (tesseract) → OCR не стоит', () => {
    const c = computeJobCost(
      { llmUsage: { prompt_tokens: 1000, output_tokens: 500, calls_without_usage: 0 }, ocrEngine: 'tesseract', ocrPages: 3, documentType: 'cmr' },
      rates,
      tableTypes,
    );
    expect(c.breakdown.ocr).toBe(0);
    expect(c.breakdown.llm).toBeCloseTo(0.35, 2); // 1*0.2 + 0.5*0.3
  });

  it('неполный usage (calls_without_usage>0) → estimate=true', () => {
    const c = computeJobCost(
      { llmUsage: { prompt_tokens: 1000, output_tokens: 500, calls_without_usage: 2 }, ocrEngine: 'tesseract', ocrPages: 1, documentType: null },
      rates,
      tableTypes,
    );
    expect(c.estimate).toBe(true);
  });

  it('yandex OCR но страниц не знаем → estimate=true', () => {
    const c = computeJobCost(
      { llmUsage: { prompt_tokens: 100, output_tokens: 50, calls_without_usage: 0 }, ocrEngine: 'yandex', ocrPages: null, documentType: 'cmr' },
      rates,
      tableTypes,
    );
    expect(c.estimate).toBe(true);
    expect(c.breakdown.ocr).toBe(0);
  });

  it('нет LLM-usage → llm=0', () => {
    const c = computeJobCost(
      { llmUsage: null, ocrEngine: 'yandex', ocrPages: 1, documentType: 'cmr' },
      rates,
      tableTypes,
    );
    expect(c.breakdown.llm).toBe(0);
    expect(c.breakdown.ocr).toBeCloseTo(0.13, 2);
  });
});
