import { describe, it, expect } from 'vitest';
import { guardInvoiceLetter } from '../src/pipeline/normalize/invoice-letter-guard.js';

describe('guardInvoiceLetter — F0g', () => {
  it('invoice без позиций и итога: валюта → null + флаг _suspect_letter', () => {
    const ex: Record<string, unknown> = { number: '13693', date: '2026-07-01', currency: 'RUB' };
    const r = guardInvoiceLetter('invoice', ex);
    expect(r.changed).toBe(true);
    expect(ex.currency).toBeNull();
    expect(ex._suspect_letter).toBe(true);
    // реквизиты не трогаем — решает оператор
    expect(ex.number).toBe('13693');
  });

  it('живой счёт (есть позиции) — не трогаем', () => {
    const ex: Record<string, unknown> = {
      currency: 'USD',
      positions: [{ name: 'фрахт', total: 100 }],
    };
    expect(guardInvoiceLetter('invoice', ex).changed).toBe(false);
    expect(ex.currency).toBe('USD');
  });

  it('счёт без позиций, но с итогом — не трогаем', () => {
    const ex: Record<string, unknown> = { currency: 'RUB', total: 15000 };
    expect(guardInvoiceLetter('invoice', ex).changed).toBe(false);
  });

  it('total="0.00" строкой считается пустым итогом', () => {
    const ex: Record<string, unknown> = { currency: 'RUB', total: '0.00' };
    expect(guardInvoiceLetter('invoice', ex).changed).toBe(true);
    expect(ex.currency).toBeNull();
  });

  it('не-invoice типы не трогаем', () => {
    const ex: Record<string, unknown> = { currency: 'RUB' };
    expect(guardInvoiceLetter('bill_of_lading', ex).changed).toBe(false);
    expect(guardInvoiceLetter(null, ex).changed).toBe(false);
    expect(ex.currency).toBe('RUB');
  });

  it('items вместо positions тоже распознаются как позиции', () => {
    const ex: Record<string, unknown> = { currency: 'EUR', items: [{ name: 'x' }] };
    expect(guardInvoiceLetter('factInvoice', ex).changed).toBe(false);
  });

  it('идемпотентность: повторный вызов ничего не меняет', () => {
    const ex: Record<string, unknown> = { currency: 'RUB' };
    guardInvoiceLetter('invoice', ex);
    expect(guardInvoiceLetter('invoice', ex).changed).toBe(false);
  });
});
