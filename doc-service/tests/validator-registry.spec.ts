/**
 * Tests for the validator registry — spec parsing, path resolution, and
 * each builtin validator behind its registered name.
 *
 * No DB access: the registry is pure. Resolver-integration tests will
 * land separately when the document_types table is part of a test
 * fixture container.
 */

import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import {
  listBuiltinNames,
  parseSpec,
  runValidatorSpecs,
} from '../src/pipeline/validation/registry.js';

describe('parseSpec', () => {
  it('parses bare name', () => {
    expect(parseSpec('vat_consistency')).toEqual({
      raw: 'vat_consistency',
      name: 'vat_consistency',
      args: [],
    });
  });

  it('parses single-arg form', () => {
    expect(parseSpec('inn_checksum:seller.inn')).toEqual({
      raw: 'inn_checksum:seller.inn',
      name: 'inn_checksum',
      args: ['seller.inn'],
    });
  });

  it('parses multi-arg form (comma-separated)', () => {
    expect(parseSpec('parties_differ:seller.inn,buyer.inn')).toEqual({
      raw: 'parties_differ:seller.inn,buyer.inn',
      name: 'parties_differ',
      args: ['seller.inn', 'buyer.inn'],
    });
  });

  it('trims whitespace around args', () => {
    expect(parseSpec('parties_differ: seller.inn ,  buyer.inn ')).toEqual({
      raw: 'parties_differ: seller.inn ,  buyer.inn ',
      name: 'parties_differ',
      args: ['seller.inn', 'buyer.inn'],
    });
  });

  it('drops empty args between commas', () => {
    expect(parseSpec('parties_differ:seller.inn,,buyer.inn').args).toEqual([
      'seller.inn',
      'buyer.inn',
    ]);
  });
});

describe('listBuiltinNames', () => {
  it('exposes all expected validator names', () => {
    const names = listBuiltinNames();
    expect(names).toEqual(
      expect.arrayContaining([
        'inn_checksum',
        'kpp_format',
        'vehicle_plate',
        'country_code',
        'date_range',
        'money_sanity',
        'vat_consistency',
        'parties_differ',
        'weight_nett_le_gross',
      ]),
    );
  });
});

describe('runValidatorSpecs', () => {
  const seller = { inn: '7707083893' }; // Сбербанк — valid checksum
  const buyer = { inn: '7728168971' }; // Лукойл — valid

  it('returns empty array on no specs', () => {
    expect(runValidatorSpecs({}, [])).toEqual([]);
  });

  it('skips unknown specs and notifies hook', () => {
    const onUnknown = vi.fn();
    const issues = runValidatorSpecs({}, ['no_such_validator', 'inn_checksum:seller.inn'], {
      onUnknown,
    });
    expect(issues).toEqual([]);
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown.mock.calls[0]![0].name).toBe('no_such_validator');
  });

  it('inn_checksum: passes valid INN at path', () => {
    const issues = runValidatorSpecs({ seller }, ['inn_checksum:seller.inn']);
    expect(issues).toEqual([]);
  });

  it('inn_checksum: catches typo in INN', () => {
    const issues = runValidatorSpecs(
      { seller: { inn: '7707083894' } },
      ['inn_checksum:seller.inn'],
    );
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/контрольная сумма/);
  });

  it('inn_checksum: noop when path missing', () => {
    expect(runValidatorSpecs({}, ['inn_checksum:seller.inn'])).toEqual([]);
  });

  it('kpp_format: passes 9-digit, rejects junk', () => {
    expect(runValidatorSpecs({ seller: { kpp: '770801001' } }, ['kpp_format:seller.kpp'])).toEqual([]);
    expect(runValidatorSpecs({ seller: { kpp: '12345' } }, ['kpp_format:seller.kpp']).length).toBe(1);
  });

  it('vehicle_plate: passes А123ВВ77, rejects Latin', () => {
    expect(runValidatorSpecs({ vehicle: { plate: 'А123ВВ77' } }, ['vehicle_plate:vehicle.plate'])).toEqual([]);
    expect(runValidatorSpecs({ vehicle: { plate: 'A123BB77' } }, ['vehicle_plate:vehicle.plate']).length).toBe(1);
  });

  it('country_code: passes RU/DE, rejects lowercase', () => {
    expect(runValidatorSpecs({ sender: { country: 'RU' } }, ['country_code:sender.country'])).toEqual([]);
    expect(runValidatorSpecs({ sender: { country: 'ru' } }, ['country_code:sender.country']).length).toBe(1);
  });

  it('date_range: catches absurd dates', () => {
    expect(runValidatorSpecs({ date: '2026-03-15' }, ['date_range'])).toEqual([]);
    expect(runValidatorSpecs({ date: '1900-01-01' }, ['date_range']).length).toBe(1);
  });

  it('money_sanity: ok for normal totals, flags negative', () => {
    expect(runValidatorSpecs({ total: 1000 }, ['money_sanity:total'])).toEqual([]);
    expect(runValidatorSpecs({ total: -1 }, ['money_sanity:total']).length).toBe(1);
  });

  it('vat_consistency: passes 20% inclusive, flags mismatch', () => {
    expect(runValidatorSpecs({ total: 120, vat: 20, vat_rate: 20 }, ['vat_consistency'])).toEqual([]);
    expect(runValidatorSpecs({ total: 120, vat: 5, vat_rate: 20 }, ['vat_consistency']).length).toBe(1);
  });

  it('parties_differ: flags identical INNs', () => {
    expect(runValidatorSpecs(
      { seller: { inn: '7707083893' }, buyer: { inn: '7707083893' } },
      ['parties_differ:seller.inn,buyer.inn'],
    ).length).toBe(1);
    expect(runValidatorSpecs(
      { seller, buyer },
      ['parties_differ:seller.inn,buyer.inn'],
    )).toEqual([]);
  });

  it('weight_nett_le_gross: flags nett > gross', () => {
    expect(runValidatorSpecs({ cargo: { weight_gross: 100, weight_nett: 200 } }, ['weight_nett_le_gross']).length).toBe(1);
    expect(runValidatorSpecs({ cargo: { weight_gross: 200, weight_nett: 100 } }, ['weight_nett_le_gross'])).toEqual([]);
  });

  it('collects multiple issues from multiple specs in order', () => {
    const issues = runValidatorSpecs(
      {
        seller: { inn: '7707083894' }, // bad
        buyer: { inn: '7707083894' },  // same → triggers parties_differ
        total: -50,
        vat: 0,
        vat_rate: 0,
      },
      [
        'inn_checksum:seller.inn',
        'inn_checksum:buyer.inn',
        'parties_differ:seller.inn,buyer.inn',
        'money_sanity:total',
        'vat_consistency',
      ],
    );
    // Expect: 2 bad INNs + 1 parties_differ + 1 negative total = ≥4 issues.
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
});
