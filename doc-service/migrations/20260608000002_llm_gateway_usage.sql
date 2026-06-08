-- Up Migration
--
-- EXT-LLM-GATEWAY (local): slim-счётчики использования LLM-шлюза.
--
-- doc-service выступает локальным OpenAI-совместимым LLM-шлюзом для внешних
-- клиентов (клиент №1 — SLAI AI-чат). На каждый /v1/chat/completions (и
-- /v1/embeddings) пишем ОДНУ лёгкую строку: кто звал, какой алиас/модель,
-- сколько токенов, латентность, исход. Контент (messages[], текст ответа,
-- ключи) НЕ храним — это в бэклоге «полного учёта».
--
-- Таблица заводится с первого дня, чтобы «потом считать всё» было SELECT'ом,
-- а не backfill'ом. См. docs/EXT_LLM_GATEWAY_LOCAL_IMPL_TZ_2026-06-08.md §5.

BEGIN;

CREATE TABLE IF NOT EXISTS llm_gateway_usage (
  id                 BIGSERIAL PRIMARY KEY,
  caller             TEXT,           -- имя клиента из named key (API_KEYS_JSON); NULL если root-key
  alias              TEXT NOT NULL,  -- опубликованный алиас (parsdocs-chat | ...)
  model              TEXT NOT NULL,  -- фактический backend ollama-tag
  prompt_tokens      INTEGER,        -- из upstream usage (может отсутствовать)
  completion_tokens  INTEGER,        -- из upstream usage (может отсутствовать)
  latency_ms         INTEGER NOT NULL,
  status             TEXT NOT NULL,  -- success | error | timeout
  error_code         TEXT,           -- коды шлюза: upstream_error | timeout | network_error | ...
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Основной аналитический срез — «по клиенту, недавние сверху».
CREATE INDEX IF NOT EXISTS idx_llm_gw_usage_time
  ON llm_gateway_usage (caller, started_at DESC);

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_llm_gw_usage_time;
DROP TABLE IF EXISTS llm_gateway_usage;

COMMIT;
