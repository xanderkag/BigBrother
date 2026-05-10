import { describe, it, expect } from 'vitest';
import { KeywordClassifier } from '../src/pipeline/classifier/keywords.js';

describe('KeywordClassifier', () => {
  const c = new KeywordClassifier();

  it('detects ТТН', async () => {
    const r = await c.classify('ТРАНСПОРТНАЯ НАКЛАДНАЯ № 123 от 15.01.2026');
    expect(r.type).toBe('TTN');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('detects УПД', async () => {
    const r = await c.classify('Универсальный передаточный документ № 5 от 01.02.2026');
    expect(r.type).toBe('UPD');
  });

  it('detects CMR', async () => {
    const r = await c.classify('CMR International Consignment Note № 999');
    expect(r.type).toBe('CMR');
  });

  it('detects АКТ', async () => {
    const r = await c.classify('АКТ выполненных работ № 42 от 10.03.2026');
    expect(r.type).toBe('AKT');
  });

  it('detects счёт-фактура as factInvoice', async () => {
    const r = await c.classify('Счёт-фактура № 7 от 02.02.2026');
    expect(r.type).toBe('factInvoice');
  });

  it('detects plain счёт as invoice', async () => {
    const r = await c.classify('Счёт на оплату № 100 от 01.03.2026');
    expect(r.type).toBe('invoice');
  });

  it('returns null on noise', async () => {
    const r = await c.classify('Hello world, totally unrelated text.');
    expect(r.type).toBeNull();
  });
});
