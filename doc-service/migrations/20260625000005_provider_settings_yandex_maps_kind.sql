-- Up Migration
--
-- 2026-06-25: Добавляем kind='yandex_maps' в provider_settings.
--
-- INTEGRATION_HUB yandex_maps (Ф1): коннектор Яндекс.Карт (геокодер +
-- маршрут/расстояние) уже в реестре gateway_connectors (enabled=false). Его
-- ключ (env-fallback на provider_settings.kind='yandex_maps') не мог лечь в
-- ту же таблицу из-за CHECK (kind IN ('llm','ocr','dadata')). Расширяем CHECK.
--   - api_key = Яндекс API ключ (уходит в query `apikey`, не Bearer)
-- Шифруется/маскируется как у остальных провайдеров (envelope-encryption).
--
-- Forward-only: дропаем старый CHECK, ставим новый с расширенным набором.

ALTER TABLE provider_settings
    DROP CONSTRAINT IF EXISTS provider_settings_kind_check;

ALTER TABLE provider_settings
    ADD CONSTRAINT provider_settings_kind_check
    CHECK (kind IN ('llm', 'ocr', 'dadata', 'yandex_maps'));

-- Down Migration

ALTER TABLE provider_settings
    DROP CONSTRAINT IF EXISTS provider_settings_kind_check;

-- Откат: убираем yandex_maps-строки, иначе восстановление старого CHECK упадёт.
DELETE FROM provider_settings WHERE kind = 'yandex_maps';

ALTER TABLE provider_settings
    ADD CONSTRAINT provider_settings_kind_check
    CHECK (kind IN ('llm', 'ocr', 'dadata'));
