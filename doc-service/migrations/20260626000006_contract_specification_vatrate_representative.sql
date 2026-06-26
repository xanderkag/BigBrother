-- Up Migration
--
-- Аудит пробелов извлечения 2026-06-26 (extraction-gap audit): у типа
-- contract_specification на реальных спецификациях регулярно присутствуют, но
-- НИКОГДА не извлекались два дешёвых поля верхнего уровня:
--   * vat_rate            — основная ставка НДС по спецификации (20/10/0%).
--   * representative_name  — ФИО подписанта/представителя стороны.
-- Прогон 0522/0608 эти поля «терял» (их не было в llm_schema → модель их не
-- возвращала). Добавляем их аддитивно в llm_schema.properties, существующие
-- ключи (включая items[].vat_rate и top-level total_vat) НЕ трогаем.
--
-- Техника: NEW || EXISTING при мерже свойств — при конфликте побеждает
-- СУЩЕСТВУЮЩЕЕ значение, гарантия что миграция только добавляет.

BEGIN;

UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "vat_rate": {"type": "number", "description": "Основная ставка НДС по спецификации, %"},
            "representative_name": {"type": "string", "description": "ФИО подписанта/представителя"}
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'contract_specification';

DO $$
DECLARE props jsonb;
BEGIN
  SELECT llm_schema->'properties' INTO props
    FROM document_types WHERE slug='contract_specification';
  IF props IS NULL THEN
    RAISE EXCEPTION 'contract_specification not found or has no properties';
  END IF;
  IF NOT (props ? 'vat_rate') THEN
    RAISE EXCEPTION 'vat_rate not present after update';
  END IF;
  IF NOT (props ? 'representative_name') THEN
    RAISE EXCEPTION 'representative_name not present after update';
  END IF;
  -- existing keys must survive
  IF NOT (props ? 'items') OR NOT (props ? 'total_vat') OR NOT (props ? 'party_a') THEN
    RAISE EXCEPTION 'existing contract_specification keys were clobbered';
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         (llm_schema->'properties') #- '{vat_rate}' #- '{representative_name}'
       )
 WHERE slug = 'contract_specification';
COMMIT;
