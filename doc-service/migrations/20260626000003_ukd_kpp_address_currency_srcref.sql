-- Up Migration
--
-- Аудит пробелов извлечения 2026-06-26: у UKD (корректировочная СФ/УКД) дешёвые
-- поля, которые присутствуют в документе, но НЕ извлекались. Ни сид 0028, ни
-- спец-обработка строк 0608 их не заводили (0608 правил только items[] —
-- correction-строки ДО/ПОСЛЕ, party/реквизиты не трогал).
--
-- ВАЖНО про форму схемы UKD: стороны хранятся ПЛОСКИМИ ключами
-- (seller_inn/seller_name/buyer_inn/buyer_name), объектов seller/buyer (или
-- prodavec/pokupatel) в схеме НЕТ. Поэтому kpp/address добавляются как плоские
-- top-level ключи (seller_kpp/buyer_kpp/seller_address/buyer_address) — это
-- соответствует существующей конвенции схемы, а не выдумывает party-объект.
--
-- Добавляем (всё аддитивно, существующие ключи не трогаем):
--   1. seller_kpp, buyer_kpp, seller_address, buyer_address — КПП и адрес сторон
--      (плоские, как seller_inn/buyer_inn).
--   2. currency_code — ISO-4217 (буквенный/цифровой) код валюты. Существующий
--      ключ `currency` (свободная строка) сохраняется.
--   3. base_doc_refs[] {type, number, date} — структурированная ссылка на
--      ИСХОДНЫЙ УПД/счёт-фактуру, к которому относится корректировка. Ключевая
--      связка UKD->UPD; плоские base_doc_number/base_doc_date покрывают только
--      единичный случай и сохраняются.
--   4. items[].okei_code (код ОКЕИ единицы измерения),
--      items[].traceability_reg_number (Графа 11 рег.номер прослеживаемости) —
--      фискальные коды строки. Массив items[] в схеме существует, поэтому
--      item-level поля добавляются точечно через jsonb_set(..., true), без
--      реструктуризации строк ДО/ПОСЛЕ.

BEGIN;

-- 1. Плоские реквизиты сторон (KPP + адрес). NEW || EXISTING -> аддитивно.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "seller_kpp": {"type": "string", "description": "КПП продавца"},
            "buyer_kpp": {"type": "string", "description": "КПП покупателя"},
            "seller_address": {"type": "string", "description": "Адрес продавца"},
            "buyer_address": {"type": "string", "description": "Адрес покупателя"},
            "currency_code": {"type": "string", "description": "Код валюты ISO-4217 (буквенный или цифровой)"},
            "base_doc_refs": {
              "type": "array",
              "description": "Ссылки на исходные документы (УПД/счёт-фактура), к которым относится корректировка.",
              "items": {
                "type": "object",
                "properties": {
                  "type": {"type": "string", "description": "Тип исходного документа (УПД/счёт-фактура)"},
                  "number": {"type": "string", "description": "Номер исходного документа"},
                  "date": {"type": "string", "description": "Дата исходного документа"}
                }
              }
            }
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'UKD';

-- 2. Фискальные коды строки (items[] существует) — точечно, без реструктуризации.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,okei_code}',
         '{"type": "string", "description": "Код единицы измерения по ОКЕИ"}'::jsonb,
         true
       )
 WHERE slug = 'UKD'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'okei_code');

UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,traceability_reg_number}',
         '{"type": "string", "description": "Графа 11: регистрационный номер партии товара, подлежащего прослеживаемости"}'::jsonb,
         true
       )
 WHERE slug = 'UKD'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'traceability_reg_number');

DO $$
DECLARE props jsonb; iprops jsonb;
BEGIN
  SELECT llm_schema->'properties' INTO props FROM document_types WHERE slug='UKD';
  IF props IS NULL THEN
    RAISE EXCEPTION 'UKD not found or has no properties';
  END IF;

  -- Новые top-level ключи присутствуют.
  IF NOT (props ? 'seller_kpp') THEN RAISE EXCEPTION 'UKD missing seller_kpp'; END IF;
  IF NOT (props ? 'buyer_kpp') THEN RAISE EXCEPTION 'UKD missing buyer_kpp'; END IF;
  IF NOT (props ? 'seller_address') THEN RAISE EXCEPTION 'UKD missing seller_address'; END IF;
  IF NOT (props ? 'buyer_address') THEN RAISE EXCEPTION 'UKD missing buyer_address'; END IF;
  IF NOT (props ? 'currency_code') THEN RAISE EXCEPTION 'UKD missing currency_code'; END IF;
  IF NOT (props ? 'base_doc_refs') THEN RAISE EXCEPTION 'UKD missing base_doc_refs'; END IF;

  -- Существующие ключи сохранены (аддитивность).
  IF NOT (props ? 'seller_inn') THEN RAISE EXCEPTION 'UKD lost seller_inn (not additive)'; END IF;
  IF NOT (props ? 'buyer_inn') THEN RAISE EXCEPTION 'UKD lost buyer_inn (not additive)'; END IF;
  IF NOT (props ? 'currency') THEN RAISE EXCEPTION 'UKD lost currency (not additive)'; END IF;
  IF NOT (props ? 'base_doc_number') THEN RAISE EXCEPTION 'UKD lost base_doc_number (not additive)'; END IF;
  IF NOT (props ? 'items') THEN RAISE EXCEPTION 'UKD lost items (not additive)'; END IF;

  -- Item-level фискальные коды присутствуют, старые item-поля сохранены.
  SELECT llm_schema #> '{properties,items,items,properties}' INTO iprops
    FROM document_types WHERE slug='UKD';
  IF NOT (iprops ? 'okei_code') THEN RAISE EXCEPTION 'UKD missing items[].okei_code'; END IF;
  IF NOT (iprops ? 'traceability_reg_number') THEN RAISE EXCEPTION 'UKD missing items[].traceability_reg_number'; END IF;
  IF NOT (iprops ? 'qty_before') THEN RAISE EXCEPTION 'UKD lost items[].qty_before (not additive)'; END IF;
  IF NOT (iprops ? 'qty_after') THEN RAISE EXCEPTION 'UKD lost items[].qty_after (not additive)'; END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = (llm_schema #- '{properties,seller_kpp}'
                                #- '{properties,buyer_kpp}'
                                #- '{properties,seller_address}'
                                #- '{properties,buyer_address}'
                                #- '{properties,currency_code}'
                                #- '{properties,base_doc_refs}'
                                #- '{properties,items,items,properties,okei_code}'
                                #- '{properties,items,items,properties,traceability_reg_number}')
 WHERE slug = 'UKD';
COMMIT;
