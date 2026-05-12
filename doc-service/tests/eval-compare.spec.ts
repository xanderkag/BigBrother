/**
 * Unit-тесты на компараторы eval harness'а.
 *
 * Это критичная зона: если компаратор соврал, мы будем верить ложным
 * метрикам и катить регрессии. Каждый компаратор покрыт обоими
 * сторонами: что должно матчиться (с разной формой записи) и что
 * матчиться не должно.
 */

import { describe, expect, it } from 'vitest';
import {
  compareString,
  compareMoney,
  comparePercent,
  compareDate,
  compareDigits,
  comparePlate,
  compareCountry,
  compareInteger,
  compareNumber,
  compareByKind,
  inferKind,
  getByPath,
  isAbsent,
  parseMoney,
  parsePercent,
  parseDate,
  normalizeString,
  normalizePlate,
  digitsOnly,
} from '../src/scripts/eval/compare.js';

describe('isAbsent', () => {
  it('treats null/undefined/empty-string/NaN as absent', () => {
    expect(isAbsent(null)).toBe(true);
    expect(isAbsent(undefined)).toBe(true);
    expect(isAbsent('')).toBe(true);
    expect(isAbsent('   ')).toBe(true);
    expect(isAbsent(NaN)).toBe(true);
  });
  it('treats 0, false, "0" as present', () => {
    expect(isAbsent(0)).toBe(false);
    expect(isAbsent(false)).toBe(false);
    expect(isAbsent('0')).toBe(false);
  });
});

describe('getByPath', () => {
  it('walks dot-path through nested objects', () => {
    const obj = { carrier: { inn: '7707', address: { city: 'Москва' } } };
    expect(getByPath(obj, 'carrier.inn')).toBe('7707');
    expect(getByPath(obj, 'carrier.address.city')).toBe('Москва');
  });
  it('returns undefined for missing path', () => {
    expect(getByPath({}, 'a.b.c')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
  });
  it('handles array indices via numeric keys', () => {
    const obj = { positions: [{ qty: 5 }, { qty: 10 }] };
    expect(getByPath(obj, 'positions.0.qty')).toBe(5);
    expect(getByPath(obj, 'positions.1.qty')).toBe(10);
  });
});

describe('compareString', () => {
  it('matches with whitespace/case/punctuation differences', () => {
    expect(compareString('ООО Ромашка', 'ооо ромашка')).toBe('match');
    expect(compareString('Иванов И.И.', 'Иванов  И. И.')).toBe('match');
    expect(compareString('«ПАО Газпром»', 'ПАО Газпром')).toBe('match');
  });
  it('mismatches on different content', () => {
    expect(compareString('Иванов', 'Петров')).toBe('mismatch');
  });
  it('reports missing when actual is null', () => {
    expect(compareString('Иванов', null)).toBe('missing');
    expect(compareString('Иванов', '')).toBe('missing');
  });
  it('normalizeString collapses whitespace and lowercases', () => {
    expect(normalizeString('  ПАО   "Газпром"  ')).toBe('пао газпром');
  });
});

describe('compareMoney', () => {
  it('matches different surface forms', () => {
    expect(compareMoney(1234.56, 1234.56)).toBe('match');
    expect(compareMoney(1234.56, '1234.56')).toBe('match');
    expect(compareMoney(1234.56, '1 234,56')).toBe('match');
    expect(compareMoney(1234.56, '1 234,56 ₽')).toBe('match');
  });
  it('matches within ±0.01 tolerance', () => {
    expect(compareMoney(100.0, 100.005)).toBe('match');
    expect(compareMoney(100.0, 100.02)).toBe('mismatch');
  });
  it('parseMoney returns null for garbage', () => {
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe('comparePercent', () => {
  it('normalizes 0..1 vs 0..100', () => {
    expect(comparePercent(20, 0.2)).toBe('match');
    expect(comparePercent('20%', 20)).toBe('match');
    expect(comparePercent(20, '20')).toBe('match');
  });
  it('mismatches on different rate', () => {
    expect(comparePercent(20, 10)).toBe('mismatch');
  });
  it('parsePercent handles common forms', () => {
    expect(parsePercent('20%')).toBe(20);
    expect(parsePercent(0.2)).toBe(20);
    expect(parsePercent('garbage')).toBeNull();
  });
});

describe('compareDate', () => {
  it('matches ISO vs DD.MM.YYYY vs DD/MM/YYYY', () => {
    expect(compareDate('2026-04-12', '12.04.2026')).toBe('match');
    expect(compareDate('2026-04-12', '12/04/2026')).toBe('match');
    expect(compareDate('2026-04-12', '2026-04-12T10:00:00Z')).toBe('match');
  });
  it('mismatches on different day', () => {
    expect(compareDate('2026-04-12', '2026-04-13')).toBe('mismatch');
  });
  it('parseDate returns null for unparseable', () => {
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('April 12, 2026')).toBeNull(); // не поддерживаем english long-form
  });
});

describe('compareDigits (ИНН/КПП/счёт)', () => {
  it('strips non-digit and matches', () => {
    expect(compareDigits('7707083893', '7707083893')).toBe('match');
    expect(compareDigits('7707083893', ' 7707 083 893 ')).toBe('match');
    expect(compareDigits('40702810500000000001', '40702810500000000001')).toBe('match');
  });
  it('mismatches on different number', () => {
    expect(compareDigits('7707083893', '7707083892')).toBe('mismatch');
  });
  it('digitsOnly handles edge cases', () => {
    expect(digitsOnly('А777ВВ')).toBe('777');
    expect(digitsOnly('  ')).toBeNull();
    expect(digitsOnly(12345)).toBe('12345');
  });
});

describe('comparePlate', () => {
  it('uppercases and strips spaces/dashes', () => {
    expect(comparePlate('А123ВВ77', 'а123вв77')).toBe('match');
    expect(comparePlate('А123ВВ77', 'А 123 ВВ 77')).toBe('match');
    expect(comparePlate('А123ВВ77', 'А-123-ВВ-77')).toBe('match');
  });
  it('mismatches на разных номерах', () => {
    expect(comparePlate('А123ВВ77', 'Б123ВВ77')).toBe('mismatch');
  });
  it('normalizePlate returns null on empty', () => {
    expect(normalizePlate('')).toBeNull();
  });
});

describe('compareCountry', () => {
  it('case-insensitive ISO alpha-2', () => {
    expect(compareCountry('RU', 'ru')).toBe('match');
    expect(compareCountry('DE', ' de ')).toBe('match');
  });
  it('mismatches on different country', () => {
    expect(compareCountry('RU', 'DE')).toBe('mismatch');
  });
});

describe('compareInteger / compareNumber', () => {
  it('integer rounds before compare', () => {
    expect(compareInteger(5400, 5400.4)).toBe('match');
    expect(compareInteger(5400, 5401)).toBe('mismatch');
  });
  it('number tolerates default ±0.01', () => {
    expect(compareNumber(12.5, 12.501)).toBe('match');
    expect(compareNumber(12.5, 12.52)).toBe('mismatch');
  });
});

describe('compareByKind dispatcher', () => {
  it('routes to right comparator', () => {
    expect(compareByKind('money', 100, '100,00')).toBe('match');
    expect(compareByKind('inn', '7707083893', ' 770 708 3893 ')).toBe('match');
    expect(compareByKind('plate', 'А123ВВ77', 'а123вв 77')).toBe('match');
    expect(compareByKind('country', 'RU', 'ru')).toBe('match');
  });
});

describe('inferKind', () => {
  it('detects inn/kpp/plate by suffix', () => {
    expect(inferKind('carrier.inn')).toBe('inn');
    expect(inferKind('seller.kpp')).toBe('kpp');
    expect(inferKind('vehicle.plate')).toBe('plate');
  });
  it('detects money by keyword', () => {
    expect(inferKind('total')).toBe('money');
    expect(inferKind('positions.0.amount')).toBe('money');
    expect(inferKind('vat')).toBe('money');
  });
  it('detects date by keyword', () => {
    expect(inferKind('loading_date')).toBe('date');
    expect(inferKind('invoice_date')).toBe('date');
  });
  it('detects percent and country', () => {
    expect(inferKind('vat_rate')).toBe('percent');
    expect(inferKind('sender.country')).toBe('country');
  });
  it('falls back to string', () => {
    expect(inferKind('carrier.name')).toBe('string');
  });
});

describe('missing vs mismatch is a tracked distinction', () => {
  it('missing means actual is null/undefined/""', () => {
    expect(compareMoney(100, null)).toBe('missing');
    expect(compareDate('2026-04-12', undefined)).toBe('missing');
    expect(compareDigits('7707083893', '')).toBe('missing');
  });
  it('mismatch means actual is present but wrong', () => {
    expect(compareMoney(100, 200)).toBe('mismatch');
    expect(compareDate('2026-04-12', '2026-04-13')).toBe('mismatch');
  });
});
