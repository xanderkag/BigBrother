-- Up Migration
--
-- Vanga как интеграционный хаб — ФУНДАМЕНТ (Ф1 backbone).
-- См. docs/INTEGRATION_HUB_VISION.md. Ось учёта: потребитель × коннектор ×
-- units × время. Заводим реестр коннекторов, суточные бюджеты потребителей
-- и обобщаем метеринг с «только LLM-tokens» на generic units.
--
--   gateway_connectors        — реестр внешних API (llm/dadata/yandex_maps),
--                               kind-ссылка на сейф ключей (provider_settings.kind),
--                               внешние суточный/месячный лимиты ключа (cap).
--   gateway_consumer_budgets  — персональный суточный бюджет потребителя
--                               (= caller в usage) на конкретный коннектор.
--   llm_gateway_usage         — +connector/units/unit_kind (старые строки
--                               получают connector='llm'; LLM-путь НЕ ломаем).
--
-- Enforcement квот в роуты пока НЕ вшит (следующий инкремент) — здесь только
-- схема + seed + спина для checkConsumerQuota(). Forward-only, аддитивно.

BEGIN;

-- ── Реестр коннекторов ──────────────────────────────────────────────
CREATE TABLE gateway_connectors (
    slug          TEXT PRIMARY KEY,            -- 'llm' | 'dadata' | 'yandex_maps'
    display_name  TEXT NOT NULL,
    provider_kind TEXT NOT NULL,               -- ссылка на provider_settings.kind (где лежит ключ)
    unit_kind     TEXT NOT NULL DEFAULT 'calls', -- 'tokens' | 'calls' | 'geocodes' | 'routes'
    daily_cap     INTEGER,                     -- внешний суточный лимит ключа; NULL = неизвестен
    monthly_cap   INTEGER,                     -- внешний месячный лимит ключа; NULL = неизвестен
    enabled       BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Суточный бюджет потребителя на коннектор ────────────────────────
-- consumer = имя потребителя/инстанса, то же что caller в llm_gateway_usage.
-- daily_budget NULL = без персонального лимита (в рамках общего connector cap).
CREATE TABLE gateway_consumer_budgets (
    consumer     TEXT NOT NULL,
    connector    TEXT NOT NULL REFERENCES gateway_connectors(slug),
    daily_budget INTEGER,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (consumer, connector)
);

-- ── Обобщить метеринг: generic units поверх токенов ─────────────────
-- connector NOT NULL DEFAULT 'llm' → старые LLM-строки автоматически 'llm'.
-- units/unit_kind nullable: исторические строки их не знают (для LLM units
-- восстановимы как prompt_tokens+completion_tokens, но backfill не делаем).
ALTER TABLE llm_gateway_usage
    ADD COLUMN connector TEXT NOT NULL DEFAULT 'llm',
    ADD COLUMN units     NUMERIC,
    ADD COLUMN unit_kind TEXT;

-- Аналитический срез квот: «сегодняшние units по потребителю и коннектору».
CREATE INDEX idx_llm_gw_usage_consumer_connector
    ON llm_gateway_usage (caller, connector, started_at DESC);

-- ── Seed реестра коннекторов ────────────────────────────────────────
INSERT INTO gateway_connectors (slug, display_name, provider_kind, unit_kind, enabled) VALUES
    ('llm',         'LLM-шлюз',     'llm',         'tokens', true),
    ('dadata',      'DaData',       'dadata',      'calls',  false),
    ('yandex_maps', 'Яндекс.Карты', 'yandex_maps', 'calls',  false);

-- ── Sanity ──────────────────────────────────────────────────────────
DO $$
DECLARE
  conn_cnt int;
  has_connector boolean;
  has_units boolean;
  has_unit_kind boolean;
BEGIN
  SELECT count(*) INTO conn_cnt FROM gateway_connectors;
  IF conn_cnt <> 3 THEN
    RAISE EXCEPTION 'gateway_connectors seed expected 3 rows, got %', conn_cnt;
  END IF;

  IF (SELECT enabled FROM gateway_connectors WHERE slug='llm') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'llm connector must be enabled by default';
  END IF;

  SELECT bool_or(column_name='connector'),
         bool_or(column_name='units'),
         bool_or(column_name='unit_kind')
    INTO has_connector, has_units, has_unit_kind
    FROM information_schema.columns
   WHERE table_name='llm_gateway_usage';
  IF NOT (has_connector AND has_units AND has_unit_kind) THEN
    RAISE EXCEPTION 'llm_gateway_usage missing generic-units columns';
  END IF;
END $$;

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_llm_gw_usage_consumer_connector;

ALTER TABLE llm_gateway_usage
    DROP COLUMN IF EXISTS unit_kind,
    DROP COLUMN IF EXISTS units,
    DROP COLUMN IF EXISTS connector;

DROP TABLE IF EXISTS gateway_consumer_budgets;
DROP TABLE IF EXISTS gateway_connectors;

COMMIT;
