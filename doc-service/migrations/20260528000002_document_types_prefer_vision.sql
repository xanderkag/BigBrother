-- Up Migration
--
-- Hybrid-routing (SLAI backlog Sequencing #3): per-type opt-in в vision-путь.
--
-- document_types.prefer_vision=true → даже при чистом текстовом слое и высокой
-- OCR-уверенности doc-service маршрутизирует extract этого типа через
-- designated vision-провайдера (Qwen-VL) с картинкой первой страницы. Полезно
-- для типов где скан — норма (счёт-фактура, печатные акты), а текстовый слой
-- ненадёжен даже когда формально присутствует.
--
-- NULL/false (default) → решение принимается обычными cheap-сигналами роутера
-- (OCR confidence / scan-engine / short-text). Поведение не меняется пока
-- админ явно не выставит флаг конкретному типу.
--
-- Гейтится HYBRID_ROUTING_ENABLED — при выключенном флаге колонка игнорируется.
--
-- Forward-only. Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE document_types
    ADD COLUMN IF NOT EXISTS prefer_vision boolean NOT NULL DEFAULT false;

COMMIT;

-- Down Migration

BEGIN;

ALTER TABLE document_types
    DROP COLUMN IF EXISTS prefer_vision;

COMMIT;
