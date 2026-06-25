-- Up Migration
--
-- bill_of_lading.llm_schema был восстановлен как МИНИМАЛЬНЫЙ skeleton
-- ({items:[{name}]}) миграцией 20260607999999 (фикс collision sanity-check
-- 20260608000001). Побочка обнаружена на боевом батче 2026-06-25: resolver
-- отдаёт DB-skeleton с приоритетом над полной BL_SCHEMA из кода
-- (EXTENDED_SCHEMAS.bill_of_lading) → bill_of_lading извлекал ТОЛЬКО `items`,
-- теряя number / shipper / consignee / carrier / containers / порты / даты.
-- B/L — ключевой тип для SLAI (контейнеры + bl_number match-signals).
--
-- Фикс: убрать DB-skeleton (NULL) → resolver падает на EXTENDED_SCHEMAS.bill_of_lading
-- (полная BL_SCHEMA из кода = единый источник истины). Резолвер дополнен, чтобы
-- fallback включал EXTENDED_SCHEMAS (см. document-type-resolver.ts).
-- Безопасно: sanity-check 20260608000001 уже применён и не перезапускается; на
-- свежем деплое эта миграция идёт ПОСЛЕ него (после того как его проверка прошла).

BEGIN;

UPDATE document_types SET llm_schema = NULL WHERE slug = 'bill_of_lading';

DO $$
BEGIN
  IF (SELECT llm_schema FROM document_types WHERE slug = 'bill_of_lading') IS NOT NULL THEN
    RAISE EXCEPTION 'bill_of_lading.llm_schema still set after NULL';
  END IF;
END $$;

COMMIT;

-- Down Migration
-- Вернуть минимальный skeleton (состояние после 20260607999999).
BEGIN;
UPDATE document_types
   SET llm_schema = jsonb_build_object(
         'type', 'object',
         'properties', jsonb_build_object(
           'items', jsonb_build_object(
             'type', 'array',
             'items', jsonb_build_object(
               'type', 'object',
               'properties', jsonb_build_object('name', jsonb_build_object('type', 'string'))
             )
           )
         )
       )
 WHERE slug = 'bill_of_lading' AND llm_schema IS NULL;
COMMIT;
