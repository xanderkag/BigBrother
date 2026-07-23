/**
 * FX-1: курс ЦБ РФ — парсер XML, фетчер (инъектируемый), резолвер USD→RUB.
 *
 *   - parseCbrDailyXml: comma-decimal, Nominal!=1 (Value/Nominal), дата из
 *     атрибута, терпимость к мусору, пустой/битый → [].
 *   - fetchCbrDailyRates: инъектируемый fetch (без сети); не-2xx / пустой → throw.
 *   - fxRatesRepo.resolveUsdRub: кэш ЦБ → 'cbr:date'; пусто+конфиг → config;
 *     пусто+конфиг 0 → none; БД упала → config (fail-soft).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

const queryMock = vi.fn();
vi.mock('../src/db.js', () => ({ db: { query: (...a: unknown[]) => queryMock(...a) } }));

import { parseCbrDailyXml, fetchCbrDailyRates } from '../src/fx/cbr-client.js';
import { fxRatesRepo } from '../src/storage/fx-rates.js';
import { config } from '../src/config.js';

// Компактный документ в стиле реального ответа ЦБ (windows-1251, но нужные
// поля ASCII). USD nominal=1, JPY nominal=100, EUR без Nominal-варианта.
const FIXTURE = [
  '<?xml version="1.0" encoding="windows-1251"?>',
  '<ValCurs Date="24.07.2026" name="Foreign Currency Market">',
  '<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode>',
  '<Nominal>1</Nominal><Name>x</Name><Value>78,4049</Value><VunitRate>78,4049</VunitRate></Valute>',
  '<Valute ID="R01820"><CharCode>JPY</CharCode><Nominal>100</Nominal><Value>48,0835</Value></Valute>',
  '<Valute ID="R01239"><CharCode>EUR</CharCode><Nominal>1</Nominal><Value>92,1</Value></Valute>',
  '</ValCurs>',
].join('');

beforeEach(() => queryMock.mockReset());

describe('parseCbrDailyXml', () => {
  it('парсит USD (nominal 1) и дату', () => {
    const rates = parseCbrDailyXml(FIXTURE);
    const usd = rates.find((r) => r.currency_code === 'USD');
    expect(usd).toBeDefined();
    expect(usd!.rate_rub).toBeCloseTo(78.4049, 4);
    expect(usd!.nominal).toBe(1);
    expect(usd!.cbr_date).toBe('2026-07-24');
  });

  it('делит Value на Nominal для валют с номиналом 100 (JPY)', () => {
    const jpy = parseCbrDailyXml(FIXTURE).find((r) => r.currency_code === 'JPY');
    expect(jpy!.rate_rub).toBeCloseTo(0.480835, 6);
    expect(jpy!.nominal).toBe(100);
  });

  it('берёт все валюты документа', () => {
    const codes = parseCbrDailyXml(FIXTURE).map((r) => r.currency_code).sort();
    expect(codes).toEqual(['EUR', 'JPY', 'USD']);
  });

  it('пропускает мусорные Valute (нет CharCode / непарсируемый Value)', () => {
    const xml =
      '<ValCurs Date="24.07.2026">' +
      '<Valute ID="A"><Nominal>1</Nominal><Value>10,0</Value></Valute>' + // нет CharCode
      '<Valute ID="B"><CharCode>ZZZ</CharCode><Nominal>1</Nominal><Value>abc</Value></Valute>' + // Value не число
      '<Valute ID="C"><CharCode>GBP</CharCode><Nominal>1</Nominal><Value>100,5</Value></Valute>' +
      '</ValCurs>';
    const rates = parseCbrDailyXml(xml);
    expect(rates.map((r) => r.currency_code)).toEqual(['GBP']);
  });

  it('нет атрибута Date → [] (битый/пустой документ)', () => {
    expect(parseCbrDailyXml('<ValCurs></ValCurs>')).toEqual([]);
    expect(parseCbrDailyXml('')).toEqual([]);
    expect(parseCbrDailyXml('garbage')).toEqual([]);
  });
});

describe('fetchCbrDailyRates (инъектируемый fetch)', () => {
  const okFetch = (body: string): typeof fetch =>
    (async () => ({ ok: true, status: 200, text: async () => body })) as unknown as typeof fetch;

  it('ok → распарсенные курсы', async () => {
    const rates = await fetchCbrDailyRates({ fetchImpl: okFetch(FIXTURE) });
    expect(rates.find((r) => r.currency_code === 'USD')!.rate_rub).toBeCloseTo(78.4049, 4);
  });

  it('не-2xx → throw', async () => {
    const bad = (async () => ({ ok: false, status: 503, text: async () => '' })) as unknown as typeof fetch;
    await expect(fetchCbrDailyRates({ fetchImpl: bad })).rejects.toThrow(/HTTP 503/);
  });

  it('пустой/битый XML → throw (0 курсов)', async () => {
    await expect(fetchCbrDailyRates({ fetchImpl: okFetch('<ValCurs></ValCurs>') })).rejects.toThrow(
      /0 rates/,
    );
  });
});

describe('fxRatesRepo.resolveUsdRub (fail-soft-цепочка)', () => {
  it('кэш ЦБ есть → cbr:date', async () => {
    queryMock.mockResolvedValue({
      rows: [{ rate_rub: '78.4049', source: 'cbr', cbr_date: new Date('2026-07-24T00:00:00Z') }],
    });
    const r = await fxRatesRepo.resolveUsdRub();
    expect(r.rate).toBeCloseTo(78.4049, 4);
    expect(r.source).toBe('cbr:2026-07-24');
  });

  it('кэш пуст + конфиг задан → config-fallback', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const prev = config.cost.fxUsdRub;
    config.cost.fxUsdRub = 90;
    try {
      const r = await fxRatesRepo.resolveUsdRub();
      expect(r).toEqual({ rate: 90, source: 'config:COST_FX_USD_RUB' });
    } finally {
      config.cost.fxUsdRub = prev;
    }
  });

  it('кэш пуст + конфиг 0 → none (стоимость останется estimate)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const prev = config.cost.fxUsdRub;
    config.cost.fxUsdRub = 0;
    try {
      const r = await fxRatesRepo.resolveUsdRub();
      expect(r).toEqual({ rate: null, source: 'none' });
    } finally {
      config.cost.fxUsdRub = prev;
    }
  });

  it('getRate упал → fail-soft на конфиг, resolveUsdRub не бросает', async () => {
    // Спаим сам getRate синхронным throw: исключение летит прямо в try/catch
    // resolveUsdRub, БЕЗ создания промиса (mockRejectedValue на db.query давал
    // «floating» rejection, который vitest засчитывает как unhandled).
    const spy = vi.spyOn(fxRatesRepo, 'getRate').mockImplementation(() => {
      throw new Error('db down');
    });
    const prev = config.cost.fxUsdRub;
    config.cost.fxUsdRub = 95;
    try {
      const r = await fxRatesRepo.resolveUsdRub();
      expect(r).toEqual({ rate: 95, source: 'config:COST_FX_USD_RUB' });
    } finally {
      config.cost.fxUsdRub = prev;
      spy.mockRestore();
    }
  });
});
