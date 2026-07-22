/**
 * SPEED-5: countTableRows — прокси объёма вывода для триггера multipass.
 * (Врезка в orchestrator покрыта интеграционно; здесь — чистый счётчик,
 * от которого зависит решение row-heavy → multipass.)
 */
import { describe, it, expect } from 'vitest';
import { countTableRows, isTableRow } from '../src/pipeline/parsers/multipass-llm.js';

describe('isTableRow', () => {
  it('строка с ≥2 разделителями — табличная', () => {
    expect(isTableRow('CHINA,PART-1,Power board,2,145.50')).toBe(true);
    expect(isTableRow('a\tb\tc')).toBe(true);
    expect(isTableRow('x;y;z')).toBe(true);
  });
  it('проза и заголовки — НЕ табличные', () => {
    expect(isTableRow('Настоящим сообщаем, что')).toBe(false); // 1 запятая
    expect(isTableRow('=== Sheet: INVOICE ===')).toBe(false);
    expect(isTableRow('')).toBe(false);
    expect(isTableRow('   ')).toBe(false);
  });
});

describe('countTableRows', () => {
  it('считает только табличные строки', () => {
    const text = [
      '=== Sheet: INVOICE ===',
      'No,Description,Qty,Price,Total',
      'Просто абзац текста без структуры',
      '1,Болт,10,5.5,55',
      '2,Гайка,20,2.25,45',
      '',
    ].join('\n');
    expect(countTableRows(text)).toBe(3); // шапка + 2 строки
  });

  it('100 товарных строк — выше дефолтного порога 40 (row-heavy)', () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i},Товар ${i},2,100,200,CN`).join('\n');
    expect(countTableRows(text)).toBe(100);
    expect(countTableRows(text) > 40).toBe(true);
  });

  it('короткий инвойс (5 строк) — ниже порога, не row-heavy', () => {
    const text = Array.from({ length: 5 }, (_, i) => `${i},Товар,1,10,10`).join('\n');
    expect(countTableRows(text) > 40).toBe(false);
  });
});
