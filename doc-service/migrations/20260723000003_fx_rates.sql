-- Up Migration
--
-- FX-1 (курс валют из ЦБ РФ). Раньше USD→RUB был статичной константой
-- `COST_FX_USD_RUB` (в проде = 0 → стоимость облачных LLM-вызовов помечалась
-- estimate, конвертации не было). Теперь курс тянется из официального ЦБ
-- (cbr.ru/scripts/XML_daily.asp, обновляется раз в рабочий день) фоновым
-- обновлятором и кэшируется здесь.
--
-- Таблица держит ТОЛЬКО последний курс на валюту (PK=currency_code, upsert).
-- История не нужна: курс на момент разбора фиксируется в снимке задачи
-- (jobs.cost_breakdown, BILL-1) — смена курса не переписывает прошлые задачи.
--
-- Fail-soft: если ЦБ недоступен/выходной/первый запуск — расчёт берёт
-- последний курс отсюда, а при пустой таблице откатывается на статический
-- COST_FX_USD_RUB. Никогда не блокирует расчёт стоимости.

BEGIN;

CREATE TABLE IF NOT EXISTS fx_rates (
  -- ISO буквенный код валюты ЦБ (CharCode): 'USD','EUR','CNY',...
  currency_code TEXT PRIMARY KEY,
  -- рублей за 1 ЕДИНИЦУ валюты = Value / Nominal (ЦБ даёт цену за Nominal единиц).
  rate_rub      NUMERIC(18,6) NOT NULL,
  -- номинал ЦБ (1, 10, 100) — сохраняем как есть для прозрачности/аудита.
  nominal       INTEGER NOT NULL DEFAULT 1,
  -- дата курса по ЦБ (атрибут ValCurs Date). В выходные = последний рабочий день.
  cbr_date      DATE NOT NULL,
  -- источник: 'cbr' (авто) | 'manual' (ручная фиксация, если появится).
  source        TEXT NOT NULL DEFAULT 'cbr',
  -- когда наш обновлятор реально забрал строку (для диагностики свежести).
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE fx_rates IS
  'FX-1: последний курс валюты к рублю из ЦБ РФ (кэш обновлятора). rate_rub = рублей за 1 единицу. История не хранится — курс задачи фиксируется в jobs.cost_breakdown.';

COMMIT;

-- Down Migration
BEGIN;
DROP TABLE IF EXISTS fx_rates;
COMMIT;
