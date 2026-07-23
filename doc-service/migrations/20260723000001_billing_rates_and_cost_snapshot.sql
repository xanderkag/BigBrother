-- Up Migration
--
-- BILL-1 (ТЗ docs/BILLING_INTERNAL_TZ.md §4.1/§4.2 + решения владельца §9).
--
-- Проблема: стоимость задачи НЕ хранилась вообще — `cost_rub` вычислялся на
-- чтение в `toApi` из текущего `config.cost`. Значит смена ставки сегодня
-- молча переписывала стоимость всех прошлых задач, а агрегировать было нечего.
--
-- Фикс: (1) прайс-лист висит на провайдере (`provider_settings.rates`);
-- (2) в задаче сохраняется СНИМОК расчёта (`jobs.cost_breakdown`) со ставкой
-- и курсом на момент разбора + денормализованный итог `jobs.cost_rub`.
--
-- Решения владельца 2026-07-23:
--   · всё сводим к рублям, курс фиксируется на дату задачи (в снимке);
--   · своё железо тарифицируем по КОММЕРЧЕСКОМУ эквиваленту («как если бы
--     считал Yandex»), cost_basis='amortized' — цифра отвечает «сколько это
--     стоило бы в облаке», поэтому в отчётах отделена от живых денег.

BEGIN;

ALTER TABLE provider_settings ADD COLUMN IF NOT EXISTS rates JSONB;
COMMENT ON COLUMN provider_settings.rates IS
  'Прайс-лист провайдера: {currency, cost_basis: vendor|amortized|free, llm_input_per_1k, llm_output_per_1k, ocr_page, ocr_page_table}. NULL → ставка неизвестна, расход помечается estimate (НЕ ноль).';

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost_rub NUMERIC(12,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost_breakdown JSONB;
COMMENT ON COLUMN jobs.cost_breakdown IS
  'Снимок расчёта себестоимости: построчно (провайдер × вид расхода) со ставкой и курсом НА МОМЕНТ разбора. Смена тарифа/курса не меняет уже посчитанные задачи.';

-- ── Живые деньги наружу (vendor) ─────────────────────────────────────────
UPDATE provider_settings SET rates = jsonb_build_object(
  'currency', 'RUB', 'cost_basis', 'vendor',
  'ocr_page', 0.13, 'ocr_page_table', 1.22
) WHERE id = 'yandex-vision';

-- Claude Sonnet 4.5: $3 / 1M вход, $15 / 1M выход → $/1k.
UPDATE provider_settings SET rates = jsonb_build_object(
  'currency', 'USD', 'cost_basis', 'vendor',
  'llm_input_per_1k', 0.003, 'llm_output_per_1k', 0.015
) WHERE id = 'anthropic';

-- gpt-4o-mini: $0.15 / 1M вход, $0.60 / 1M выход.
UPDATE provider_settings SET rates = jsonb_build_object(
  'currency', 'USD', 'cost_basis', 'vendor',
  'llm_input_per_1k', 0.00015, 'llm_output_per_1k', 0.0006
) WHERE id = 'openai';

-- ── Не тарифицируется ────────────────────────────────────────────────────
UPDATE provider_settings SET rates = jsonb_build_object(
  'currency', 'RUB', 'cost_basis', 'free'
) WHERE id IN ('tesseract', 'stub');

-- ── Своё железо: коммерческий эквивалент (решение владельца) ─────────────
-- Ставки = тариф Yandex AI Studio (вход ₽0.2/1k, выход ₽0.3/1k). Смысл цифры —
-- «сколько эта работа стоила бы в облаке», НЕ «сколько потрачено».
UPDATE provider_settings SET rates = jsonb_build_object(
  'currency', 'RUB', 'cost_basis', 'amortized',
  'llm_input_per_1k', 0.2, 'llm_output_per_1k', 0.3
) WHERE kind = 'llm' AND (id LIKE 'local-%' OR id = 'qwen-local');

COMMIT;
