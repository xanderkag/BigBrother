/**
 * F2: per-field confidence — pull-up + калибровка.
 */
import { describe, expect, it } from 'vitest';
import { processFieldConfidence } from '../src/pipeline/normalize/field-confidence.js';

describe('processFieldConfidence — pull-up из extracted', () => {
  it('переносит _field_confidence из extracted на верх', () => {
    const r = processFieldConfidence({
      number: 'INV-1',
      _field_confidence: { number: 0.9, 'seller.inn': 0.95 },
    });
    expect(r.fieldConfidence.number).toBe(0.9);
    expect(r.fieldConfidence['seller.inn']).toBe(0.95);
    expect(r.cleanedExtracted._field_confidence).toBeUndefined();
  });

  it('игнорирует невалидные значения (> 1, < 0, не числа)', () => {
    const r = processFieldConfidence({
      _field_confidence: { number: 1.5, 'seller.inn': -0.1, date: 'bad', total_with_vat: 0.8 },
    });
    expect(r.fieldConfidence.number).toBeUndefined();
    expect(r.fieldConfidence['seller.inn']).toBeUndefined();
    expect(r.fieldConfidence.date).toBeUndefined();
    expect(r.fieldConfidence.total_with_vat).toBe(0.8);
  });

  it('принимает строковые числа ("0.8")', () => {
    const r = processFieldConfidence({
      _field_confidence: { number: '0.8' },
    });
    expect(r.fieldConfidence.number).toBe(0.8);
  });
});

describe('processFieldConfidence — defaults для критичных полей', () => {
  it('ставит дефолт 0.7 если поле present но LLM не указала confidence', () => {
    const r = processFieldConfidence({
      number: 'INV-1',
      date: '2026-05-17',
      // нет _field_confidence
    });
    expect(r.fieldConfidence.number).toBe(0.7);
    expect(r.fieldConfidence.date).toBe(0.7);
  });

  it('не выдумывает confidence для отсутствующих полей', () => {
    const r = processFieldConfidence({ number: 'INV-1' });
    expect(r.fieldConfidence['seller.inn']).toBeUndefined(); // нет поля → нет confidence
  });

  it('уважает confidence от LLM если она указала', () => {
    const r = processFieldConfidence({
      number: 'INV-1',
      _field_confidence: { number: 0.55 },
    });
    expect(r.fieldConfidence.number).toBe(0.55); // не перетёрто на дефолт 0.7
  });
});

describe('processFieldConfidence — калибровка по checksum ИНН', () => {
  it('валидный ИНН без LLM confidence → ставит 0.95', () => {
    // 7707083893 — реальный валидный ИНН
    const r = processFieldConfidence({
      seller: { inn: '7707083893' },
    });
    expect(r.fieldConfidence['seller.inn']).toBe(0.95);
  });

  it('валидный 12-значный ИНН ИП → ставит 0.95', () => {
    // 500100732259 — валидный 12-знач
    const r = processFieldConfidence({
      seller: { inn: '500100732259' },
    });
    expect(r.fieldConfidence['seller.inn']).toBe(0.95);
  });

  it('невалидный checksum → cap confidence в 2×', () => {
    // 7707083894 — последняя цифра неправильная
    const r = processFieldConfidence({
      seller: { inn: '7707083894' },
      _field_confidence: { 'seller.inn': 0.9 },
    });
    // 0.9 × 0.5 = 0.45
    expect(r.fieldConfidence['seller.inn']).toBe(0.45);
  });

  it('неправильная длина → confidence 0.3', () => {
    const r = processFieldConfidence({
      seller: { inn: '12345' }, // 5 цифр — не 10 и не 12
      _field_confidence: { 'seller.inn': 0.9 },
    });
    expect(r.fieldConfidence['seller.inn']).toBe(0.3); // min(0.9, 0.3) = 0.3
  });

  it('калибрует все ИНН-пути (shipper, consignee, carrier)', () => {
    const r = processFieldConfidence({
      shipper: { inn: '7707083893' }, // валидный
      consignee: { inn: 'XXX' },        // невалидный (не цифры)
      carrier: { inn: '500100732259' }, // валидный ИП
    });
    expect(r.fieldConfidence['shipper.inn']).toBe(0.95);
    expect(r.fieldConfidence['consignee.inn']).toBeUndefined(); // не цифры — даже не пытаемся
    expect(r.fieldConfidence['carrier.inn']).toBe(0.95);
  });
});

describe('processFieldConfidence — калибровка по нормализации plate', () => {
  it('успешно нормализованный plate → confidence 0.9', () => {
    const r = processFieldConfidence({
      vehicle: { plate: 'А123ВВ77' }, // уже в норме
    });
    expect(r.fieldConfidence['vehicle.plate']).toBe(0.9);
  });

  it('plate с латиницей → нормализуется → 0.9', () => {
    const r = processFieldConfidence({
      vehicle: { plate: 'A123BB77' }, // лат → кир
    });
    expect(r.fieldConfidence['vehicle.plate']).toBe(0.9);
  });

  it('не нормализуемый plate → cap 0.4 если LLM ставила больше', () => {
    const r = processFieldConfidence({
      vehicle: { plate: 'ABC123' }, // не подходит под маску
      _field_confidence: { 'vehicle.plate': 0.95 },
    });
    expect(r.fieldConfidence['vehicle.plate']).toBe(0.4);
  });

  it('не нормализуемый plate без LLM confidence → не добавляет в map', () => {
    const r = processFieldConfidence({
      vehicle: { plate: 'ABC123' },
    });
    expect(r.fieldConfidence['vehicle.plate']).toBeUndefined();
  });
});

describe('processFieldConfidence — edge cases', () => {
  it('null extracted → пустой map', () => {
    const r = processFieldConfidence(null);
    expect(r.fieldConfidence).toEqual({});
  });

  it('пустой объект → пустой map', () => {
    const r = processFieldConfidence({});
    expect(r.fieldConfidence).toEqual({});
  });

  it('идемпотентность: повторный вызов не меняет результат', () => {
    const input = {
      number: 'INV-1',
      seller: { inn: '7707083893' },
      _field_confidence: { number: 0.85 },
    };
    const r1 = processFieldConfidence(input);
    const r2 = processFieldConfidence({
      ...r1.cleanedExtracted,
      _field_confidence: r1.fieldConfidence,
    });
    expect(r2.fieldConfidence.number).toBe(0.85);
    expect(r2.fieldConfidence['seller.inn']).toBe(0.95);
  });
});
