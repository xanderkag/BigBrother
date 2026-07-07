import { describe, it, expect } from 'vitest';
import {
  normalizeWeightToKg,
  parseNumericLoose,
  normalizeCurrency,
  normalizeHsCode,
  detectScript,
  plateWithScript,
} from '../src/pipeline/normalize/ved-fields.js';
import { normalizePlate } from '../src/pipeline/normalize/identifiers.js';

// VANGA-VED-1 §4 — нормализаторы. Примеры взяты из ТЗ §4 и реальных
// фикстур §7 (комплекты Milka / дизайнерская бумага).

describe('parseNumericLoose (RU/EU number formats)', () => {
  it('RU format with space-thousands and comma-decimal', () => {
    expect(parseNumericLoose('17 653,02')).toBe(17653.02); // §4 пример
  });
  it('EN format with comma-thousands and dot-decimal', () => {
    expect(parseNumericLoose('17,653.02')).toBe(17653.02);
  });
  it('plain dot-decimal', () => {
    expect(parseNumericLoose('17653.02')).toBe(17653.02);
  });
  it('integer with thousands space', () => {
    expect(parseNumericLoose('1 234')).toBe(1234);
  });
  it('passes numbers through', () => {
    expect(parseNumericLoose(42)).toBe(42);
  });
  it('null for empty / garbage', () => {
    expect(parseNumericLoose('')).toBeNull();
    expect(parseNumericLoose(null)).toBeNull();
    expect(parseNumericLoose('—')).toBeNull();
  });
});

describe('normalizeWeightToKg', () => {
  it('tonnes via explicit unit', () => {
    expect(normalizeWeightToKg(5, 'т')).toBe(5000);
    expect(normalizeWeightToKg('5', 't')).toBe(5000);
  });
  it('tonnes via inline unit', () => {
    expect(normalizeWeightToKg('5 т')).toBe(5000);
  });
  it('grams → kg', () => {
    expect(normalizeWeightToKg('250 г')).toBe(0.25);
  });
  it('kg passes through, RU/EU number ok', () => {
    expect(normalizeWeightToKg('18 528,02', 'kg')).toBe(18528.02); // §7.1 брутто-с-паллетами
    expect(normalizeWeightToKg('17653.02')).toBe(17653.02);
  });
  it('null for non-weight unit or empty', () => {
    expect(normalizeWeightToKg('5', 'шт')).toBeNull();
    expect(normalizeWeightToKg('')).toBeNull();
  });
});

describe('normalizeCurrency', () => {
  it('RU symbols and abbreviations → RUB', () => {
    expect(normalizeCurrency('руб.')).toBe('RUB');
    expect(normalizeCurrency('₽')).toBe('RUB');
    expect(normalizeCurrency('рублей')).toBe('RUB');
  });
  it('EUR / USD / KZT', () => {
    expect(normalizeCurrency('€')).toBe('EUR');
    expect(normalizeCurrency('евро')).toBe('EUR');
    expect(normalizeCurrency('$')).toBe('USD');
    expect(normalizeCurrency('тенге')).toBe('KZT');
  });
  it('already-ISO passes through (upper)', () => {
    expect(normalizeCurrency('eur')).toBe('EUR');
  });
  it('null for unknown non-ISO-shaped', () => {
    expect(normalizeCurrency('руб12')).toBeNull();
    expect(normalizeCurrency('')).toBeNull();
  });
});

describe('normalizeHsCode', () => {
  it('strips spaces/dots, keeps digits (does NOT pad)', () => {
    expect(normalizeHsCode('1806 32 10')).toBe('18063210'); // HS-8 (не выдумываем 00)
    expect(normalizeHsCode('1806321000')).toBe('1806321000'); // §7.1 EAD — 10-значный ТНВЭД
    expect(normalizeHsCode('1806.32.10.00')).toBe('1806321000');
    expect(normalizeHsCode('2204222200')).toBe('2204222200');
  });
  it('preserves leading zeros as string', () => {
    expect(normalizeHsCode('0402100000')).toBe('0402100000');
  });
  it('null for out-of-range length', () => {
    expect(normalizeHsCode('12345')).toBeNull();
    expect(normalizeHsCode('')).toBeNull();
  });
});

describe('detectScript', () => {
  it('cyrillic plate (заявка, РФ-тягач)', () => {
    expect(detectScript('С380ТУ60')).toBe('cyrillic');
  });
  it('latin plate (CMR, иностранный тягач)', () => {
    expect(detectScript('9096BC')).toBe('latin');
  });
  it('cyrillic look-alike plate is cyrillic', () => {
    expect(detectScript('9096ВС')).toBe('cyrillic'); // В,С — кириллица
  });
  it('mixed', () => {
    expect(detectScript('МАМ123abc')).toBe('mixed');
  });
  it('null when no letters', () => {
    expect(detectScript('123')).toBeNull();
  });
});

describe('plateWithScript (перецеп-связка)', () => {
  it('РФ-номер: сохраняет оригинал + cyrillic + нормализует', () => {
    const r = plateWithScript('С380ТУ60', normalizePlate);
    expect(r).not.toBeNull();
    expect(r!.original).toBe('С380ТУ60');
    expect(r!.script).toBe('cyrillic');
    expect(r!.normalized).toBe('С380ТУ60');
  });
  it('иностранный номер: latin, normalized=null, сверка по оригиналу', () => {
    const r = plateWithScript('9096BC', normalizePlate);
    expect(r!.original).toBe('9096BC');
    expect(r!.script).toBe('latin');
    expect(r!.normalized).toBeNull();
  });
  it('null для пустого', () => {
    expect(plateWithScript('', normalizePlate)).toBeNull();
  });
});
