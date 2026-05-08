import { describe, it, expect } from 'vitest';
import {
  scorePdfText,
  combineConfidence,
  normalizeTesseractConfidence,
} from '../src/pipeline/quality.js';

describe('scorePdfText', () => {
  it('scores empty / very short text as zero', () => {
    expect(scorePdfText('')).toBe(0);
    expect(scorePdfText('xx')).toBe(0);
  });

  it('scores a real Russian invoice highly', () => {
    const text = `
      Счёт-фактура № 123 от 15 января 2026 года.
      Продавец: ООО "Ромашка", ИНН 7712345678, КПП 771201001.
      Покупатель: ООО "Василёк", ИНН 7798765432.
      Итого к оплате: 15 000,00 руб., в том числе НДС 20% — 2 500,00 руб.
      Подписи сторон, печати, реквизиты банка ПАО Сбербанк.
    `.repeat(2);
    expect(scorePdfText(text)).toBeGreaterThan(0.8);
  });

  it('scores image-extracted noise low', () => {
    expect(scorePdfText('!!!@@@###    ')).toBeLessThan(0.3);
  });
});

describe('combineConfidence', () => {
  it('returns OCR conf when parser conf undefined', () => {
    expect(combineConfidence(0.8, undefined)).toBe(0.8);
  });

  it('penalises when either side is weak (geometric mean)', () => {
    expect(combineConfidence(0.9, 0.1)).toBeLessThan(0.5);
    expect(combineConfidence(0.9, 0.9)).toBeGreaterThan(0.85);
  });
});

describe('normalizeTesseractConfidence', () => {
  it('rescales 0..100 to 0..1', () => {
    expect(normalizeTesseractConfidence(80)).toBeCloseTo(0.8);
  });
  it('clamps', () => {
    expect(normalizeTesseractConfidence(150)).toBe(1);
    expect(normalizeTesseractConfidence(-1)).toBe(0);
  });
});
