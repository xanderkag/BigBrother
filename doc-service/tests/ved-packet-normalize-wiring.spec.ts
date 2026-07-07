import { describe, it, expect } from 'vitest';
import { normalizeExtractedFields } from '../src/pipeline/normalize/extracted-fields.js';

// VANGA-VED-1 §4 wiring + §7 golden fixtures. Проверяем, что §4-нормализаторы
// подключены в normalizeExtractedFields и производят правильный
// _normalized_fields на реальных комплектах (БКТ Транзит).

describe('§7.2 комплект №1 — перецеп (С380ТУ60 cyr ≠ GF8484 lat)', () => {
  it('CMR с иностранным номером → latin script + ISO валюта + чистый ТНВЭД', () => {
    const cmr = {
      number: '25082',
      vehicle: { plate: 'GF8484', trailer_plate: 'U6161' },
      declared_value: { amount: 11590052.03, currency: 'руб.' },
      hs_codes: ['4802589000', '4805 92 0000', '48109 9 8000'],
    };
    const out = normalizeExtractedFields(cmr)!;
    const nf = out._normalized_fields as Record<string, string>;
    expect(nf['vehicle.plate.script']).toBe('latin');
    expect(nf['declared_value.currency']).toBe('RUB');
    expect(nf['hs_codes.0']).toBe('4802589000');
    expect(nf['hs_codes.1']).toBe('4805920000'); // пробелы убраны
  });

  it('transport_request с РФ-номером → cyrillic script (та самая связка)', () => {
    const req = { vehicle: { plate: 'С380ТУ60', trailer_plate: 'ВА417460' } };
    const nf = normalizeExtractedFields(req)!._normalized_fields as Record<string, string>;
    expect(nf['vehicle.plate.script']).toBe('cyrillic');
    // и заодно нормализованный РФ-номер лёг в канонический вид
    expect(nf['vehicle.plate']).toBe('С380ТУ60');
  });
});

describe('§7.1 комплект №2 — Milka (EAD + водитель)', () => {
  it('customs_export_ead: transport_identity script + очистка ТНВЭД позиций', () => {
    const ead = {
      mrn: '23HR030228018557B5',
      transport_identity: { truck_plate: '9096BC', trailer_plate: '587BE' },
      currency: 'EUR',
      items: [
        { item_no: 1, hs_code: '1806 32 1000', statistical_value: 17325.26 },
        { item_no: 4, hs_code: '1905907000' },
      ],
    };
    const nf = normalizeExtractedFields(ead)!._normalized_fields as Record<string, string>;
    expect(nf['transport_identity.truck_plate.script']).toBe('latin');
    expect(nf['currency']).toBe('EUR');
    expect(nf['items.0.hs_code']).toBe('1806321000');
    expect(nf['items.1.hs_code']).toBe('1905907000');
  });

  it('driver.fio латиницей → driver.script=latin (для транслит-сверки с паспортом)', () => {
    const cmr = { driver: { fio: 'MAMETKAZIYEV TYNCHTINBEK' } };
    const nf = normalizeExtractedFields(cmr)!._normalized_fields as Record<string, string>;
    expect(nf['driver.script']).toBe('latin');
  });
});

describe('regression: не-VED документ не обрастает VED-полями', () => {
  it('обычный счёт без ТС/ТНВЭД → нет script/hs ключей', () => {
    const invoice = { seller: { inn: '7707083893' }, total: 15400.5 }; // валидная контрольная сумма
    const out = normalizeExtractedFields(invoice)!;
    const nf = (out._normalized_fields ?? {}) as Record<string, string>;
    expect(Object.keys(nf).some((k) => k.endsWith('.script') || k.startsWith('hs_codes'))).toBe(false);
    // ИНН по-прежнему нормализуется (не сломали существующее)
    expect(nf['seller.inn']).toBe('7707083893');
  });
});
