import { describe, it, expect } from 'vitest';
import {
  validateInn,
  validateKpp,
  validateVehiclePlate,
  validateDate,
  validateMoney,
  validateVatConsistency,
  validatePositionsSum,
  validatePartiesDiffer,
  validateCountryCode,
} from '../src/pipeline/validation/validators.js';
import { validateExtracted } from '../src/pipeline/validation/index.js';

describe('validateInn', () => {
  // Examples from the public ФНС test vector and well-known real INNs.
  it.each([
    '7707083893', // Сбербанк
    '7728168971', // Лукойл
    '500100732259', // valid 12-digit (test vector)
  ])('accepts valid INN %s', (inn) => {
    expect(validateInn(inn)).toBeNull();
  });

  it('rejects checksum-broken 10-digit INN', () => {
    expect(validateInn('7707083894')).toMatch(/контрольная сумма/);
  });

  it('rejects checksum-broken 12-digit INN', () => {
    expect(validateInn('500100732250')).toMatch(/контрольная сумма/);
  });

  it('rejects wrong length', () => {
    expect(validateInn('123')).toMatch(/10 или 12/);
    expect(validateInn('12345678901')).toMatch(/10 или 12/); // 11 digits
  });

  it('rejects non-digits', () => {
    expect(validateInn('77ABC83893')).toMatch(/только из цифр/);
  });
});

describe('validateKpp', () => {
  it('accepts standard KPP', () => {
    expect(validateKpp('770801001')).toBeNull();
  });

  it('accepts KPP with letters in cause-of-registration position', () => {
    expect(validateKpp('7708AB001')).toBeNull();
  });

  it('rejects wrong length', () => {
    expect(validateKpp('123')).toMatch(/некорректный формат/);
  });
});

describe('validateVehiclePlate', () => {
  it('accepts standard plate', () => {
    // Letters allowed by ГИБДД: АВЕКМНОРСТУХ (12 Cyrillic letters that look
    // like Latin in both cases). Б is intentionally NOT in this set.
    expect(validateVehiclePlate('А123ВВ77')).toBeNull();
    expect(validateVehiclePlate('М001ОР197')).toBeNull(); // 3-digit region
  });

  it('handles spaces and lowercase', () => {
    expect(validateVehiclePlate('а 123 вв 77')).toBeNull();
  });

  it('rejects Latin letters in plate', () => {
    expect(validateVehiclePlate('A123BV77')).toMatch(/российский/);
  });

  it('rejects malformed plate', () => {
    expect(validateVehiclePlate('123АБВ77')).toMatch(/российский/);
  });
});

describe('validateDate', () => {
  const today = new Date('2026-05-06T00:00:00Z');

  it('accepts a recent date', () => {
    expect(validateDate('2026-01-15', today)).toBeNull();
  });

  it('rejects 1900', () => {
    expect(validateDate('1900-01-01', today)).toMatch(/раньше/);
  });

  it('rejects far future', () => {
    expect(validateDate('2027-12-31', today)).toMatch(/в будущем/);
  });

  it('rejects invalid calendar date (30.02)', () => {
    expect(validateDate('2026-02-30', today)).toMatch(/невалидная|раньше|в будущем/);
  });

  it('rejects bad format', () => {
    expect(validateDate('15.01.2026', today)).toMatch(/YYYY-MM-DD/);
  });
});

describe('validateMoney', () => {
  it('accepts positive finite numbers', () => {
    expect(validateMoney(0, 'total')).toBeNull();
    expect(validateMoney(1000, 'total')).toBeNull();
  });

  it('rejects negatives', () => {
    expect(validateMoney(-100, 'total')).toMatch(/отрицательный/);
  });

  it('rejects NaN/Infinity', () => {
    expect(validateMoney(NaN, 'total')).toMatch(/не число/);
    expect(validateMoney(Infinity, 'total')).toMatch(/не число/);
  });

  it('rejects unrealistic largeness', () => {
    expect(validateMoney(2e12, 'total')).toMatch(/неправдоподобно/);
  });
});

describe('validateVatConsistency', () => {
  it('accepts NDS-20% inclusive math', () => {
    // total=120, rate=20 → vat = 120 * 20 / 120 = 20
    expect(validateVatConsistency(120, 20, 20)).toBeNull();
  });

  it('flags large mismatch', () => {
    expect(validateVatConsistency(120, 5, 20)).toMatch(/не сходится/);
  });

  it('zero rate must mean zero vat', () => {
    expect(validateVatConsistency(120, 0, 0)).toBeNull();
    expect(validateVatConsistency(120, 5, 0)).toMatch(/нестыковка/);
  });

  it('skips when any input missing', () => {
    expect(validateVatConsistency(undefined, 20, 20)).toBeNull();
    expect(validateVatConsistency(120, undefined, 20)).toBeNull();
    expect(validateVatConsistency(120, 20, undefined)).toBeNull();
  });
});

describe('validatePositionsSum', () => {
  it('accepts close-to-equal sums', () => {
    expect(
      validatePositionsSum([{ total: 50 }, { total: 50 }], 100),
    ).toBeNull();
  });

  it('flags off-by-much sums', () => {
    expect(
      validatePositionsSum([{ total: 50 }, { total: 50 }], 200),
    ).toMatch(/не сходится/);
  });

  it('skips when any position has no total', () => {
    expect(
      validatePositionsSum([{ total: 50 }, {}], 100),
    ).toBeNull();
  });

  it('skips when total is missing', () => {
    expect(validatePositionsSum([{ total: 50 }], undefined)).toBeNull();
  });
});

describe('validatePartiesDiffer', () => {
  it('flags identical INNs', () => {
    expect(validatePartiesDiffer('7707083893', '7707083893')).toMatch(/совпадают/);
  });

  it('passes different INNs', () => {
    expect(validatePartiesDiffer('7707083893', '7728168971')).toBeNull();
  });
});

describe('validateCountryCode', () => {
  it('accepts ISO alpha-2', () => {
    expect(validateCountryCode('RU')).toBeNull();
    expect(validateCountryCode('DE')).toBeNull();
  });

  it('rejects lowercase, alpha-3, garbage', () => {
    expect(validateCountryCode('ru')).toMatch(/ISO/);
    expect(validateCountryCode('RUS')).toMatch(/ISO/);
    expect(validateCountryCode('1')).toMatch(/ISO/);
  });
});

describe('validateExtracted — composer', () => {
  it('returns no issues on a clean invoice', () => {
    const issues = validateExtracted(
      {
        number: '123',
        date: '2026-01-15',
        seller: { inn: '7707083893' },
        buyer: { inn: '7728168971' },
        total: 120,
        vat: 20,
        vat_rate: 20,
      },
      'invoice',
    );
    expect(issues).toEqual([]);
  });

  it('flags multiple problems on a corrupted invoice', () => {
    const issues = validateExtracted(
      {
        number: '999',
        date: '1850-05-05',
        seller: { inn: '7707083894' }, // bad checksum
        buyer: { inn: '7707083894' }, // duplicate (also bad)
        total: -100,
        vat: 999,
        vat_rate: 20,
      },
      'invoice',
    );
    // Expect at least: bad date, bad INN, identical parties, negative total, vat mismatch.
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  it('TTN: bad plate + nett>gross', () => {
    const issues = validateExtracted(
      {
        date: '2026-04-10',
        shipper: { inn: '7707083893' },
        consignee: { inn: '7728168971' },
        vehicle: { plate: 'ABC123XYZ' },
        cargo: { weight_gross: 100, weight_nett: 200 },
      },
      'TTN',
    );
    expect(issues.some((i) => /российский/.test(i))).toBe(true);
    expect(issues.some((i) => /нетто.*брутто/.test(i))).toBe(true);
  });

  it('CMR: bad country codes', () => {
    const issues = validateExtracted(
      {
        date: '2026-04-10',
        sender: { country: 'Russia' },
        recipient: { country: 'DE' },
      },
      'CMR',
    );
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/ISO/);
  });
});
