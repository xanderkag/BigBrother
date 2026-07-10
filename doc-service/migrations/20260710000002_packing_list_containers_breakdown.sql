-- Up Migration
--
-- SLAI 2026-07-10: пер-контейнерная разбивка веса/объёма/мест. Главный
-- источник — пакинг-лист: часто содержит табличку «контейнер → вес брутто/
-- нетто/объём/места». Раньше в схеме packing_list был только одиночный
-- `container_number` (top-level строка) — многоконтейнерную разбивку
-- модели некуда было класть.
--
-- Добавляем массив `containers[]` с опциональными полями веса/объёма/мест
-- (форма как у общей CONTAINERS в document-json-schemas.ts). match-signals.ts
-- проектор packing_list собирает их в `_match_signals.container_details[]`
-- через collectContainerDetails(). Аддитивно — старый container_number
-- остаётся, обе формы читаются collectContainers().

BEGIN;

-- Добавляем containers[] в схему packing_list.
UPDATE document_types
SET llm_schema = jsonb_set(
  llm_schema,
  '{properties,containers}',
  '{
    "type": "array",
    "description": "Разбивка ПО КОНТЕЙНЕРАМ, если в пакинге есть табличка контейнер→вес/объём/места. По объекту на контейнер. Нет разбивки — опусти.",
    "items": {
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер контейнера ISO 6346 (напр. MSCU1234567)"},
        "gross_weight_kg": {"type": "number", "description": "Вес брутто по контейнеру, кг"},
        "net_weight_kg": {"type": "number", "description": "Вес нетто по контейнеру, кг"},
        "volume_m3": {"type": "number", "description": "Объём груза в контейнере, м³"},
        "packages": {"type": "number", "description": "Число мест/упаковок в контейнере"}
      }
    }
  }'::jsonb
)
WHERE slug = 'packing_list';

-- Промпт-подсказка про пер-контейнерную табличку.
UPDATE document_types
SET llm_prompt = llm_prompt || '

Если в пакинге есть разбивка ПО КОНТЕЙНЕРАМ (табличка «контейнер → вес брутто/
нетто, объём, места») — заполни массив containers[]: по объекту на контейнер с
полями number / gross_weight_kg / net_weight_kg / volume_m3 / packages. Клади
только то, что реально есть в документе. Нет такой таблички — опусти containers[].'
WHERE slug = 'packing_list';

-- Sanity check
DO $$
DECLARE has_containers boolean;
BEGIN
  SELECT (llm_schema->'properties' ? 'containers')
    INTO has_containers FROM document_types WHERE slug = 'packing_list';
  IF NOT has_containers THEN
    RAISE EXCEPTION 'containers[] not added to packing_list schema';
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
SET llm_schema = llm_schema #- '{properties,containers}'
WHERE slug = 'packing_list';
UPDATE document_types
SET llm_prompt = regexp_replace(llm_prompt, E'\n\nЕсли в пакинге есть разбивка ПО КОНТЕЙНЕРАМ.*$', '', 'n')
WHERE slug = 'packing_list';
COMMIT;
