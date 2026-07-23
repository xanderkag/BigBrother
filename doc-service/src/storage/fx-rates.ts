import { db } from '../db.js';
import { config } from '../config.js';
import type { CbrRate } from '../fx/cbr-client.js';

/**
 * FX-1: репозиторий кэша курсов валют (таблица fx_rates, миграция
 * 20260723000003). Обновлятор пишет сюда последний курс ЦБ; расчёт стоимости
 * читает (быстрый DB-read, без сети в горячем пути).
 */

export type FxRateRow = {
  currency_code: string;
  rate_rub: string; // NUMERIC → string из pg
  nominal: number;
  cbr_date: Date;
  source: string;
  fetched_at: Date;
  updated_at: Date;
};

/** Разрешённый курс USD→RUB + откуда он (для снимка стоимости). */
export type ResolvedUsdRub = {
  /** рублей за 1 USD; null → курса нет (стоимость останется estimate) */
  rate: number | null;
  /** 'cbr:YYYY-MM-DD' | 'config:COST_FX_USD_RUB' | 'none' */
  source: string;
};

class FxRatesRepo {
  /**
   * Bulk-upsert курсов (по currency_code). Один вызов на обновление —
   * перезаписывает последний курс каждой валюты. Пустой массив → no-op.
   * Возвращает число записанных строк.
   */
  async upsertMany(rates: CbrRate[], source = 'cbr'): Promise<number> {
    if (rates.length === 0) return 0;
    // Разворачиваем в плоские массивы для unnest — один запрос вместо N.
    const codes: string[] = [];
    const rub: number[] = [];
    const nominals: number[] = [];
    const dates: string[] = [];
    for (const r of rates) {
      codes.push(r.currency_code);
      rub.push(r.rate_rub);
      nominals.push(r.nominal);
      dates.push(r.cbr_date);
    }
    const { rowCount } = await db.query(
      `INSERT INTO fx_rates (currency_code, rate_rub, nominal, cbr_date, source, fetched_at, updated_at)
       SELECT * FROM unnest(
         $1::text[], $2::numeric[], $3::int[], $4::date[]
       ) AS t(currency_code, rate_rub, nominal, cbr_date)
       CROSS JOIN (SELECT $5::text AS source, now() AS fetched_at, now() AS updated_at) c
       ON CONFLICT (currency_code) DO UPDATE SET
         rate_rub   = EXCLUDED.rate_rub,
         nominal    = EXCLUDED.nominal,
         cbr_date   = EXCLUDED.cbr_date,
         source     = EXCLUDED.source,
         fetched_at = EXCLUDED.fetched_at,
         updated_at = now()`,
      [codes, rub, nominals, dates, source],
    );
    return rowCount ?? 0;
  }

  /** Последний курс валюты к рублю. null если валюты нет в кэше. */
  async getRate(
    currency: string,
  ): Promise<{ rate: number; source: string; cbr_date: string } | null> {
    const { rows } = await db.query<{ rate_rub: string; source: string; cbr_date: Date }>(
      `SELECT rate_rub, source, cbr_date FROM fx_rates WHERE currency_code = $1`,
      [currency.toUpperCase()],
    );
    if (!rows[0]) return null;
    const rate = Number(rows[0].rate_rub);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return {
      rate,
      source: rows[0].source,
      cbr_date: rows[0].cbr_date.toISOString().slice(0, 10),
    };
  }

  /**
   * Курс USD→RUB для расчёта стоимости с fail-soft-цепочкой:
   *   1. кэш ЦБ (fx_rates) → 'cbr:YYYY-MM-DD';
   *   2. статический COST_FX_USD_RUB из конфига → 'config:COST_FX_USD_RUB';
   *   3. ничего (>0 нет нигде) → rate=null (стоимость останется estimate).
   * НИКОГДА не бросает — расчёт стоимости не должен падать из-за курса.
   */
  async resolveUsdRub(): Promise<ResolvedUsdRub> {
    try {
      const r = await this.getRate('USD');
      if (r) return { rate: r.rate, source: `cbr:${r.cbr_date}` };
    } catch {
      // БД недоступна — тихо откатываемся на конфиг.
    }
    const cfg = config.cost.fxUsdRub;
    if (cfg && cfg > 0) return { rate: cfg, source: 'config:COST_FX_USD_RUB' };
    return { rate: null, source: 'none' };
  }

  /** Все закэшированные курсы (для UI/диагностики), отсортированы по коду. */
  async list(): Promise<FxRateRow[]> {
    const { rows } = await db.query<FxRateRow>(
      `SELECT * FROM fx_rates ORDER BY currency_code`,
    );
    return rows;
  }
}

export const fxRatesRepo = new FxRatesRepo();
