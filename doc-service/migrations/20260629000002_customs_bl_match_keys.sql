-- Up Migration
--
-- По прочтению реальных образцов (FESCO multimodal B/L + ДТ с приложенной ДТС-1,
-- 2026-06-29): эти документы содержат кросс-документные ключи матчинга, которых
-- в схемах не было. Добавляем ВЫБОРОЧНО (только ключи связывания + ключевые
-- counterparty/итог), чтобы не раздувать большую схему ГТД и не провоцировать
-- drop полей у phi4.
--   customs_declaration (additive jsonb):
--     container_number — графа 31 «Номера контейнеров» (FESU…): сшивает ДТ ↔ коносамент ↔ упак.лист
--     seller          — продавец по контракту из ДТС-1 (отличается от отправителя графы 2)
--     total_duties    — ИТОГО таможенных платежей (раздел B / сумма граф 47), ₽
--     customs_post    — таможенный пост оформления (графа 29/30)
--     release_date    — дата выпуска (отметка «ВЫПУСК ТОВАРОВ РАЗРЕШЕН», графа C)
--   bill_of_lading: только append к llm_prompt (carrier-эмфаза + service_name; схема в коде).
-- Схема BL и items ГТД не трогаются. Forward-only.

BEGIN;

UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "container_number": {"type": "string", "description": "Номер контейнера (ISO 6346: 4 буквы + 7 цифр, напр. FESU5187259) из графы 31 «Номера контейнеров». Связывает ДТ с коносаментом и упаковочным листом."},
            "seller": {"type": "object", "description": "Продавец по внешнеторговому контракту (из приложенной ДТС-1, графа «Продавец»; может отличаться от отправителя/экспортёра графы 2).", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "country": {"type": "string"}, "address": {"type": "string"}}},
            "total_duties": {"type": "number", "description": "Всего таможенных платежей (ИТОГО, раздел B / сумма по графам 47), в рублях."},
            "customs_post": {"type": "string", "description": "Таможенный пост оформления (графа 29/30), напр. «Т/П МОРСКОЙ ПОРТ ВЛАДИВОСТОК»."},
            "release_date": {"type": "string", "description": "Дата выпуска товаров в формате YYYY-MM-DD (отметка «ВЫПУСК ТОВАРОВ РАЗРЕШЕН», графа C)."}
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'customs_declaration';

UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' container_number — номер контейнера из графы 31 («Номера контейнеров», ISO 6346, напр. FESU5187259). seller — продавец по контракту (из ДТС-1, графа «Продавец»; может отличаться от отправителя графы 2). total_duties — ИТОГО таможенных платежей в рублях (раздел B / сумма граф 47). customs_post — таможенный пост оформления (графа 29/30). release_date — дата выпуска (YYYY-MM-DD) из отметки «ВЫПУСК ТОВАРОВ РАЗРЕШЕН».'
 WHERE slug = 'customs_declaration';

UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' carrier — морская линия/океанский перевозчик; часто указан ВНИЗУ в подписи «on behalf of the Ocean Carrier, X» (напр. FESCO INTEGRATED TRANSPORT), НЕ shipper и НЕ экспедитор. service_name — название сервиса/линии, если есть (напр. «Fesco China Direct Line»).'
 WHERE slug = 'bill_of_lading';

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(k, ', ') INTO missing
  FROM (SELECT k FROM unnest(ARRAY['container_number','seller','total_duties','customs_post','release_date']) k
        WHERE NOT ((SELECT llm_schema->'properties' FROM document_types WHERE slug='customs_declaration') ? k)) s;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'customs_declaration match-keys missing: %', missing;
  END IF;
  IF (SELECT llm_prompt FROM document_types WHERE slug='customs_declaration') NOT LIKE '%container_number%' THEN
    RAISE EXCEPTION 'customs_declaration prompt not extended';
  END IF;
  IF (SELECT llm_prompt FROM document_types WHERE slug='bill_of_lading') NOT LIKE '%service_name%' THEN
    RAISE EXCEPTION 'bill_of_lading prompt not extended';
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = llm_schema #- '{properties,container_number}'
                               #- '{properties,seller}'
                               #- '{properties,total_duties}'
                               #- '{properties,customs_post}'
                               #- '{properties,release_date}'
 WHERE slug = 'customs_declaration';
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' container_number — номер контейнера из графы 31 («Номера контейнеров», ISO 6346, напр. FESU5187259). seller — продавец по контракту (из ДТС-1, графа «Продавец»; может отличаться от отправителя графы 2). total_duties — ИТОГО таможенных платежей в рублях (раздел B / сумма граф 47). customs_post — таможенный пост оформления (графа 29/30). release_date — дата выпуска (YYYY-MM-DD) из отметки «ВЫПУСК ТОВАРОВ РАЗРЕШЕН».', '')
 WHERE slug = 'customs_declaration';
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' carrier — морская линия/океанский перевозчик; часто указан ВНИЗУ в подписи «on behalf of the Ocean Carrier, X» (напр. FESCO INTEGRATED TRANSPORT), НЕ shipper и НЕ экспедитор. service_name — название сервиса/линии, если есть (напр. «Fesco China Direct Line»).', '')
 WHERE slug = 'bill_of_lading';
COMMIT;
