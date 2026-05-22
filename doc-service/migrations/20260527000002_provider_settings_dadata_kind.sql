-- Up Migration
--
-- 2026-05-22: Добавляем kind='dadata' в provider_settings.
--
-- До этой миграции CHECK (kind IN ('llm', 'ocr')) не давал хранить креды
-- DaData в той же таблице, что и LLM/OCR. Теперь DaData (party-by-INN
-- ЕГРЮЛ-обогащение в enrich-стадии) управляется из той же админки:
--   - api_key  = DaData Token (используется в findById/party lookup)
--   - extra.secret_key = DaData Secret key (cleaning API, пока не используем)
-- Оба секрета шифруются/маскируются как у остальных провайдеров (api_key —
-- envelope-encryption, extra.secret_key — маскируется в toApi()).
--
-- Forward-only: дропаем старый авто-именованный CHECK и ставим новый с
-- расширенным набором. Имя constraint'а у Postgres по умолчанию
-- provider_settings_kind_check.

ALTER TABLE provider_settings
    DROP CONSTRAINT IF EXISTS provider_settings_kind_check;

ALTER TABLE provider_settings
    ADD CONSTRAINT provider_settings_kind_check
    CHECK (kind IN ('llm', 'ocr', 'dadata'));

-- Down Migration

ALTER TABLE provider_settings
    DROP CONSTRAINT IF EXISTS provider_settings_kind_check;

-- Откат: убираем dadata-строки, иначе восстановление старого CHECK упадёт.
DELETE FROM provider_settings WHERE kind = 'dadata';

ALTER TABLE provider_settings
    ADD CONSTRAINT provider_settings_kind_check
    CHECK (kind IN ('llm', 'ocr'));
