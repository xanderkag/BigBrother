-- Up Migration
--
-- Аудит пробелов извлечения 2026-06-30 (read-only): commercial_invoice
-- (llm_schema живёт в БД). Реально отсутствуют:
--   • buyer.inn / buyer.kpp — у buyer сейчас только name/address, тогда как
--     exporter/consignee несут tax_id. РУ-покупатели имеют ИНН и КПП ОТДЕЛЬНО
--     (tax_id — единичное поле, два значения в нём не уместить), поэтому имена
--     inn/kpp как в каноническом PARTY кода (document-json-schemas.ts).
--   • containers[].number — FCL-инвойсы ссылаются на номера контейнеров; модель
--     УЖЕ эмитит containers off-schema (наблюдалось в 2/5 боевых job). Форма как
--     у BL_SCHEMA.containers (минимальная: number, ISO 6346).
--   • total / total_with_vat — top-level алиасы суммы; модель УЖЕ эмитит их
--     off-schema (2/5 job), без ключа в схеме они дропались. total_amount уже
--     есть — total/total_with_vat добавляются ДОПОЛНИТЕЛЬНО.
--
-- Техника аддитивная: NEW || EXISTING на уровне properties и внутри buyer
-- (конфликтный ключ сохраняет СТАРОЕ значение); containers добавляется только
-- если отсутствует. Forward-only.

BEGIN;

-- 1. Top-level: total, total_with_vat, containers (NEW || EXISTING).
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "total": {"type": "number", "description": "Итоговая сумма инвойса (алиас total_amount)"},
            "total_with_vat": {"type": "number", "description": "Итоговая сумма с НДС"},
            "containers": {
              "type": "array",
              "description": "Номера контейнеров (ISO 6346: 4 буквы + 7 цифр, напр. MSCU1234567). По одному объекту на контейнер. Если контейнеров нет — опусти поле.",
              "items": {
                "type": "object",
                "properties": {
                  "number": {"type": "string", "description": "Номер контейнера, формат ISO 6346 (напр. MSCU1234567)"}
                }
              }
            }
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'commercial_invoice';

-- 2. buyer.inn (внутри существующего объекта buyer, additively).
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,buyer,properties}',
         '{"inn": {"type": "string", "description": "ИНН покупателя (10 цифр ЮЛ / 12 цифр ИП)"}}'::jsonb
           || (llm_schema #> '{properties,buyer,properties}')
       )
 WHERE slug = 'commercial_invoice'
   AND llm_schema #> '{properties,buyer,properties}' IS NOT NULL;

-- 3. buyer.kpp.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,buyer,properties}',
         '{"kpp": {"type": "string", "description": "КПП покупателя (9 цифр)"}}'::jsonb
           || (llm_schema #> '{properties,buyer,properties}')
       )
 WHERE slug = 'commercial_invoice'
   AND llm_schema #> '{properties,buyer,properties}' IS NOT NULL;

DO $$
DECLARE props jsonb; buyer_props jsonb; cont_item jsonb;
BEGIN
  SELECT llm_schema->'properties',
         llm_schema #> '{properties,buyer,properties}',
         llm_schema #> '{properties,containers,items,properties}'
    INTO props, buyer_props, cont_item
    FROM document_types WHERE slug = 'commercial_invoice';

  IF props IS NULL THEN
    RAISE EXCEPTION 'commercial_invoice schema/properties missing';
  END IF;
  -- новые top-level ключи
  IF NOT (props ? 'total')          THEN RAISE EXCEPTION 'total not added'; END IF;
  IF NOT (props ? 'total_with_vat') THEN RAISE EXCEPTION 'total_with_vat not added'; END IF;
  IF NOT (props ? 'containers')     THEN RAISE EXCEPTION 'containers not added'; END IF;
  IF cont_item IS NULL OR NOT (cont_item ? 'number') THEN
    RAISE EXCEPTION 'containers[].number not shaped';
  END IF;
  -- новые buyer-ключи
  IF buyer_props IS NULL OR NOT (buyer_props ? 'inn') THEN RAISE EXCEPTION 'buyer.inn not added'; END IF;
  IF NOT (buyer_props ? 'kpp') THEN RAISE EXCEPTION 'buyer.kpp not added'; END IF;
  -- additive-only: существовавшие ключи на месте
  IF NOT (props ? 'total_amount')   THEN RAISE EXCEPTION 'existing key total_amount clobbered'; END IF;
  IF NOT (props ? 'exporter')       THEN RAISE EXCEPTION 'existing key exporter clobbered'; END IF;
  IF NOT (props ? 'consignee')      THEN RAISE EXCEPTION 'existing key consignee clobbered'; END IF;
  IF NOT (props ? 'incoterms')      THEN RAISE EXCEPTION 'existing key incoterms clobbered'; END IF;
  IF NOT (buyer_props ? 'name')     THEN RAISE EXCEPTION 'existing key buyer.name clobbered'; END IF;
  IF NOT (buyer_props ? 'address')  THEN RAISE EXCEPTION 'existing key buyer.address clobbered'; END IF;
  -- tax_id у других сторон не задели
  IF (SELECT llm_schema #> '{properties,exporter,properties,tax_id}'
        FROM document_types WHERE slug = 'commercial_invoice') IS NULL THEN
    RAISE EXCEPTION 'existing key exporter.tax_id clobbered';
  END IF;
END $$;

-- Промпт перечисляет поля — дописываем новые имена (append-only).
UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' buyer (покупатель) дополнительно: inn (ИНН, 10/12 цифр), kpp (КПП, 9 цифр), если РУ-покупатель их указывает. containers[] — номера контейнеров (ISO 6346, по объекту {number} на контейнер) для FCL-поставок. total / total_with_vat — итоговая сумма инвойса (total — алиас total_amount) и сумма с НДС, числами.'
 WHERE slug = 'commercial_invoice'
   AND llm_prompt NOT LIKE '%total_with_vat%';

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = (llm_schema #- '{properties,total}'
                                #- '{properties,total_with_vat}'
                                #- '{properties,containers}'
                                #- '{properties,buyer,properties,inn}'
                                #- '{properties,buyer,properties,kpp}')
 WHERE slug = 'commercial_invoice';
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' buyer (покупатель) дополнительно: inn (ИНН, 10/12 цифр), kpp (КПП, 9 цифр), если РУ-покупатель их указывает. containers[] — номера контейнеров (ISO 6346, по объекту {number} на контейнер) для FCL-поставок. total / total_with_vat — итоговая сумма инвойса (total — алиас total_amount) и сумма с НДС, числами.', '')
 WHERE slug = 'commercial_invoice';
COMMIT;
