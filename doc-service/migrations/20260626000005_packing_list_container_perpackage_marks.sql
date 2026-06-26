-- Up Migration
--
-- Аудит пробелов извлечения 2026-06-26: упаковочные листы из FCL-поставок не
-- отдавали ключевые match-сигналы. Поля ниже либо были выпилены из схемы в
-- ранних правках (0522/0608), либо вовсе не извлекались:
--   • container_number (ISO-6346, 4 буквы + 7 цифр) — КРИТИЧЕН: единственный
--     надёжный линк PL → B/L в FCL-отправках, без него матчинг рвётся.
--   • marks_and_numbers — маркировка мест (свободный текст).
--   • weight_unit / volume_unit — единицы (kg / m3), без них агрегаты
--     total_weight_*/total_volume неоднозначны.
--   • items[].package_no — номер места.
--   • items[].weight_net_per_package — вес нетто на одно место.
-- items[].dimensions УЖЕ есть в схеме («Размеры одного места L×W×H») — не трогаем.
--
-- Техника аддитивная: NEW || EXISTING на уровне properties (конфликтный ключ
-- сохраняет СТАРОЕ значение), item-поля добавляются только если отсутствуют.

BEGIN;

-- 1. Top-level: container_number, marks_and_numbers, weight_unit, volume_unit.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "container_number": {"type": "string", "description": "Номер контейнера ISO-6346 (4 буквы + 7 цифр). Линк PL → коносамент в FCL-отправках."},
            "marks_and_numbers": {"type": "string", "description": "Маркировка и номера мест (Marks & Numbers)."},
            "weight_unit": {"type": "string", "description": "Единица измерения веса (kg)."},
            "volume_unit": {"type": "string", "description": "Единица измерения объёма (m3)."}
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'packing_list';

-- 2. items[].package_no (если отсутствует).
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,package_no}',
         '{"type": "string", "description": "Номер места/упаковки."}'::jsonb,
         true
       )
 WHERE slug = 'packing_list'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'package_no');

-- 3. items[].weight_net_per_package (если отсутствует).
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,weight_net_per_package}',
         '{"type": "number", "description": "Вес нетто одного места, кг."}'::jsonb,
         true
       )
 WHERE slug = 'packing_list'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'weight_net_per_package');

DO $$
DECLARE props jsonb; item_props jsonb;
BEGIN
  SELECT llm_schema->'properties',
         llm_schema #> '{properties,items,items,properties}'
    INTO props, item_props
    FROM document_types WHERE slug = 'packing_list';

  IF props IS NULL THEN
    RAISE EXCEPTION 'packing_list schema/properties missing';
  END IF;
  IF NOT (props ? 'container_number') THEN
    RAISE EXCEPTION 'container_number not added';
  END IF;
  IF NOT (props ? 'marks_and_numbers') THEN
    RAISE EXCEPTION 'marks_and_numbers not added';
  END IF;
  IF NOT (props ? 'weight_unit') THEN
    RAISE EXCEPTION 'weight_unit not added';
  END IF;
  IF NOT (props ? 'volume_unit') THEN
    RAISE EXCEPTION 'volume_unit not added';
  END IF;
  IF NOT (item_props ? 'package_no') THEN
    RAISE EXCEPTION 'items[].package_no not added';
  END IF;
  IF NOT (item_props ? 'weight_net_per_package') THEN
    RAISE EXCEPTION 'items[].weight_net_per_package not added';
  END IF;
  -- Аддитивность: ранее существовавшие ключи на месте.
  IF NOT (props ? 'total_weight_gross') THEN
    RAISE EXCEPTION 'existing key total_weight_gross clobbered';
  END IF;
  IF NOT (item_props ? 'dimensions') THEN
    RAISE EXCEPTION 'existing key items[].dimensions clobbered';
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = (llm_schema #- '{properties,container_number}'
                                #- '{properties,marks_and_numbers}'
                                #- '{properties,weight_unit}'
                                #- '{properties,volume_unit}'
                                #- '{properties,items,items,properties,package_no}'
                                #- '{properties,items,items,properties,weight_net_per_package}')
 WHERE slug = 'packing_list';
COMMIT;
