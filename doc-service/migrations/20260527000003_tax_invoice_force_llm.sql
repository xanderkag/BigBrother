-- Up Migration
--
-- EXT-1 (real-doc bench 2026-05-25, phi4 prod): счёт-фактура (slug
-- 'factInvoice', API-slug 'tax_invoice') возвращалась regex-only за 10-12 мс,
-- LLM не вызывался. Результат — мусор: total=9, number с приклеенным «от22»/
-- «от30» из соседней ячейки таблицы, ИНН отсутствует.
--
-- Причина: factInvoice сидит на parser_kind='builtin:upd_regex' с
-- regex_fallback_threshold=0.7. UPD-regex «успешно» (выше порога) парсит
-- сложную форму счёта-фактуры на мусор → LLM-fallback не срабатывает.
-- В отличие от УПД у счёта-фактуры нет надёжного builtin-regex парсера
-- (это сложная форма ФНС), поэтому правильное решение — форсировать LLM,
-- как у TTN/CMR/AKT (parser_kind='llm_extract').
--
-- Эффект БЕЗ передеплоя doc-service: orchestrator (CP1) читает parser_kind
-- из БД в рантайме; 'llm_extract' заставляет фабрику использовать
-- GenericLlmParser независимо от того, что slug — builtin. Достаточно
-- прогнать migrate-job.
--
-- Forward-only. Idempotent: WHERE по slug, UPDATE по фиксированным значениям.

BEGIN;

UPDATE document_types
SET parser_kind = 'llm_extract'
WHERE slug = 'factInvoice';

COMMIT;

-- Down Migration
--
-- Откат к исходному состоянию seed-миграции 20260512000003: счёт-фактура
-- парсилась тем же regex'ом, что и УПД.

BEGIN;

UPDATE document_types
SET parser_kind = 'builtin:upd_regex'
WHERE slug = 'factInvoice';

COMMIT;
