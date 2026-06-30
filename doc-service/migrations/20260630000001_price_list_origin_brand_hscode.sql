-- Up Migration
--
-- Аудит пробелов извлечения 2026-06-30 (read-only): реальные РУ-прайс-листы
-- несут явные колонки, которых нет в схеме price_list (llm_schema живёт в БД).
-- Заголовок:
--   • incoterms        — условие поставки (FCA/CIF/EXW + город).
--   • contract_ref     — ссылка «Appendix to contract №…».
--   • supplier_address — адрес поставщика.
-- Строки items[] (явные столбцы Model / Description / Manufacturer / Trade mark /
-- Country / HS CODE — присутствуют в боевых прайсах, никогда не извлекались):
--   • hs_code            — код ТН ВЭД (имя как в commercial_invoice.items).
--   • country_of_origin  — страна происхождения (имя как в commercial_invoice.items).
--   • brand              — торговая марка (Trade mark).
--   • manufacturer       — производитель.
--   • model              — модель.
--   • description        — описание, ОТДЕЛЬНО от name.
--
-- Техника аддитивная: на уровне properties сливаем NEW || EXISTING (конфликтный
-- ключ сохраняет СТАРОЕ значение); item-поля добавляются только если отсутствуют
-- (jsonb_set create_missing=true под NOT (... ? key)). Forward-only.

BEGIN;

-- 1. Заголовочные скаляры. NEW || EXISTING — любой существующий ключ сохраняется.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "incoterms": {"type": "string", "description": "Условие поставки Incoterms (FCA/CIF/EXW + город)"},
            "contract_ref": {"type": "string", "description": "Ссылка на контракт/приложение (Appendix to contract №...)"},
            "supplier_address": {"type": "string", "description": "Адрес поставщика"}
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'price_list';

-- 2. items[].hs_code (имя как в commercial_invoice.items).
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,hs_code}',
         '{"type": "string", "description": "Код ТН ВЭД (10 цифр РФ/ЕАЭС, 8 цифр ЕС). Столбец HS CODE."}'::jsonb,
         true
       )
 WHERE slug = 'price_list'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'hs_code');

-- 3. items[].country_of_origin.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,country_of_origin}',
         '{"type": "string", "description": "Страна происхождения (столбец Country). ISO 3166-1 alpha-2."}'::jsonb,
         true
       )
 WHERE slug = 'price_list'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'country_of_origin');

-- 4. items[].brand (Trade mark).
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,brand}',
         '{"type": "string", "description": "Торговая марка (столбец Trade mark)."}'::jsonb,
         true
       )
 WHERE slug = 'price_list'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'brand');

-- 5. items[].manufacturer.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,manufacturer}',
         '{"type": "string", "description": "Производитель (столбец Manufacturer)."}'::jsonb,
         true
       )
 WHERE slug = 'price_list'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'manufacturer');

-- 6. items[].model.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,model}',
         '{"type": "string", "description": "Модель (столбец Model)."}'::jsonb,
         true
       )
 WHERE slug = 'price_list'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'model');

-- 7. items[].description (ОТДЕЛЬНО от name).
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,description}',
         '{"type": "string", "description": "Описание позиции (столбец Description), отдельно от name."}'::jsonb,
         true
       )
 WHERE slug = 'price_list'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'description');

DO $$
DECLARE props jsonb; item_props jsonb;
BEGIN
  SELECT llm_schema->'properties',
         llm_schema #> '{properties,items,items,properties}'
    INTO props, item_props
    FROM document_types WHERE slug = 'price_list';

  IF props IS NULL THEN
    RAISE EXCEPTION 'price_list schema/properties missing';
  END IF;
  -- новые заголовочные ключи
  IF NOT (props ? 'incoterms')        THEN RAISE EXCEPTION 'incoterms not added'; END IF;
  IF NOT (props ? 'contract_ref')     THEN RAISE EXCEPTION 'contract_ref not added'; END IF;
  IF NOT (props ? 'supplier_address') THEN RAISE EXCEPTION 'supplier_address not added'; END IF;
  -- новые item-ключи
  IF NOT (item_props ? 'hs_code')           THEN RAISE EXCEPTION 'items[].hs_code not added'; END IF;
  IF NOT (item_props ? 'country_of_origin') THEN RAISE EXCEPTION 'items[].country_of_origin not added'; END IF;
  IF NOT (item_props ? 'brand')             THEN RAISE EXCEPTION 'items[].brand not added'; END IF;
  IF NOT (item_props ? 'manufacturer')      THEN RAISE EXCEPTION 'items[].manufacturer not added'; END IF;
  IF NOT (item_props ? 'model')             THEN RAISE EXCEPTION 'items[].model not added'; END IF;
  IF NOT (item_props ? 'description')       THEN RAISE EXCEPTION 'items[].description not added'; END IF;
  -- additive-only: существовавшие ключи на месте
  IF NOT (props ? 'supplier_name')   THEN RAISE EXCEPTION 'existing key supplier_name clobbered'; END IF;
  IF NOT (props ? 'currency')        THEN RAISE EXCEPTION 'existing key currency clobbered'; END IF;
  IF NOT (item_props ? 'name')       THEN RAISE EXCEPTION 'existing key items[].name clobbered'; END IF;
  IF NOT (item_props ? 'price')      THEN RAISE EXCEPTION 'existing key items[].price clobbered'; END IF;
  IF NOT (item_props ? 'min_qty')    THEN RAISE EXCEPTION 'existing key items[].min_qty clobbered'; END IF;
END $$;

-- Промпт перечисляет поля — дописываем новые имена (append-only).
UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' Дополнительно (заголовок): incoterms (условие поставки Incoterms), contract_ref (ссылка на контракт/приложение, "Appendix to contract №..."), supplier_address (адрес поставщика).'
     || ' В строках items[] дополнительно извлекай явные столбцы: hs_code (HS CODE / ТН ВЭД), country_of_origin (Country, ISO 3166 alpha-2), brand (Trade mark), manufacturer (Manufacturer), model (Model), description (Description, отдельно от name).'
 WHERE slug = 'price_list'
   AND llm_prompt NOT LIKE '%supplier_address%';

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = (llm_schema #- '{properties,incoterms}'
                                #- '{properties,contract_ref}'
                                #- '{properties,supplier_address}'
                                #- '{properties,items,items,properties,hs_code}'
                                #- '{properties,items,items,properties,country_of_origin}'
                                #- '{properties,items,items,properties,brand}'
                                #- '{properties,items,items,properties,manufacturer}'
                                #- '{properties,items,items,properties,model}'
                                #- '{properties,items,items,properties,description}')
 WHERE slug = 'price_list';
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' Дополнительно (заголовок): incoterms (условие поставки Incoterms), contract_ref (ссылка на контракт/приложение, "Appendix to contract №..."), supplier_address (адрес поставщика).'
  || ' В строках items[] дополнительно извлекай явные столбцы: hs_code (HS CODE / ТН ВЭД), country_of_origin (Country, ISO 3166 alpha-2), brand (Trade mark), manufacturer (Manufacturer), model (Model), description (Description, отдельно от name).', '')
 WHERE slug = 'price_list';
COMMIT;
