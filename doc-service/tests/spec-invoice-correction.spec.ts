/**
 * §FIX-3 (CLASSIFIER-PACKET-V2): спец со ссылкой «Invoice no.» → contract_specification.
 */
import { describe, expect, it } from 'vitest';
import { correctSpecVsInvoice } from '../src/pipeline/classifier/spec-invoice-correction.js';

describe('correctSpecVsInvoice', () => {
  it('viber_259: спец без цен, но «Invoice no.» в шапке → contract_specification', () => {
    const text =
      'Specification No 1600151851\nInvoice no. 8906476747\nАртикул Кол-во Вес нетто\nBCS 96600 шт 46 паллет';
    expect(correctSpecVsInvoice('commercial_invoice', text)).toBe('contract_specification');
  });

  it('настоящий инвойс с ценами (€) → остаётся commercial_invoice', () => {
    const text = 'VAT Invoice 8906476747\nЦена 92.96 EUR\nИтого 89 843 €';
    expect(correctSpecVsInvoice('commercial_invoice', text)).toBe('commercial_invoice');
  });

  it('спец С ценами (Specification + €) → остаётся commercial_invoice (не демоутим)', () => {
    const text = 'Specification to Contract\nUnit price 10.00 EUR\nAmount 1200 €';
    expect(correctSpecVsInvoice('commercial_invoice', text)).toBe('commercial_invoice');
  });

  it('нет якоря Specification в шапке → без изменений', () => {
    const text = 'Commercial Invoice\nGoods list without prices';
    expect(correctSpecVsInvoice('commercial_invoice', text)).toBe('commercial_invoice');
  });

  it('якорь Specification только в теле (не в первых 500) → без изменений', () => {
    const text = 'Invoice\n' + 'x'.repeat(520) + '\nSpecification reference';
    expect(correctSpecVsInvoice('commercial_invoice', text)).toBe('commercial_invoice');
  });

  it('не-invoice тип не трогаем', () => {
    expect(correctSpecVsInvoice('cmr', 'Specification без цен')).toBe('cmr');
    expect(correctSpecVsInvoice('contract_specification', 'что угодно')).toBe('contract_specification');
    expect(correctSpecVsInvoice(null, 'Specification')).toBeNull();
  });

  it('мультиязычный якорь (Especificación / Spezifikation) без цен → демоут', () => {
    expect(correctSpecVsInvoice('commercial_invoice', 'Especificación de mercancías\nartículo cantidad')).toBe(
      'contract_specification',
    );
    expect(correctSpecVsInvoice('commercial_invoice', 'Spezifikation Nr 5\nArtikel Menge')).toBe(
      'contract_specification',
    );
  });
});
