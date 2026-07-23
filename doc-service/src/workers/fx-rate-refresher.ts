import type { Logger } from 'pino';
import { fetchCbrDailyRates, type CbrRate } from '../fx/cbr-client.js';
import { fxRatesRepo } from '../storage/fx-rates.js';

/**
 * FX-1: фоновый обновлятор курса ЦБ (аналог pending-job-sweeper). На старте
 * и далее раз в `intervalMs` тянет дневной курс всех валют из cbr.ru и пишет
 * в таблицу fx_rates (upsert по валюте). Расчёт стоимости читает оттуда без
 * сети.
 *
 * Fail-soft: любая ошибка (сеть/таймаут/выходной/битый XML) логируется warn'ом
 * и НЕ роняет процесс — остаётся прошлый кэш. ЦБ обновляет курс раз в рабочий
 * день, поэтому дефолтный период — часы, а не минуты; лишние запросы в пределах
 * суток просто перезапишут тем же значением.
 *
 * Один процесс (воркер) — как и прочие sweeper'ы; при горизонтальном
 * масштабировании вынести в BullMQ repeatable, чтобы тянул один инстанс.
 */
export type FxRateRefresherDeps = {
  log: Logger;
  /** Период обновления, мс. По умолчанию из config (fxRefreshHours). */
  intervalMs: number;
  /** Override источника курса (тесты). */
  fetchRates?: () => Promise<CbrRate[]>;
  /** Override записи (тесты). */
  upsert?: (rates: CbrRate[]) => Promise<number>;
};

export function startFxRateRefresher(
  deps: FxRateRefresherDeps,
): { stop: () => void; runOnce: () => Promise<number> } {
  const { log, intervalMs } = deps;
  const fetchRates = deps.fetchRates ?? ((): Promise<CbrRate[]> => fetchCbrDailyRates());
  const upsert = deps.upsert ?? ((r: CbrRate[]): Promise<number> => fxRatesRepo.upsertMany(r, 'cbr'));

  async function runOnce(): Promise<number> {
    try {
      const rates = await fetchRates();
      const n = await upsert(rates);
      const usd = rates.find((r) => r.currency_code === 'USD');
      log.info(
        { count: n, cbr_date: rates[0]?.cbr_date, usd_rub: usd?.rate_rub },
        'fx rates refreshed from CBR',
      );
      return n;
    } catch (err) {
      // Fail-soft: ЦБ недоступен / выходной / битый XML — оставляем прошлый кэш.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'fx rate refresh failed — keeping last cached rates',
      );
      return 0;
    }
  }

  // Первый прогон на старте — fire-and-forget, boot не блокируем.
  void runOnce();

  // .unref() — таймер не держит процесс живым на shutdown (как в sweeper'ах).
  const handle = setInterval(() => void runOnce(), intervalMs);
  handle.unref?.();
  log.info({ intervalMs }, 'fx rate refresher started');

  return {
    stop: (): void => clearInterval(handle),
    runOnce,
  };
}
