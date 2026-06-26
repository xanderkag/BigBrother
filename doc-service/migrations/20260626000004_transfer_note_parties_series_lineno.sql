-- Up Migration
--
-- Аудит пробелов извлечения 2026-06-26: для transfer_note (накладная на
-- внутреннее перемещение) llm_schema хранит только склады/организацию
-- (source_warehouse/target_warehouse/organization_*) и плоские items[]
-- (qty/code/name/unit/price/total). Стороны-юрлица (отправитель/получатель,
-- НЕ склад), агрегаты и построчная трассировка отсутствовали как ключи —
-- модель их не извлекала (прогоны 0522/0608 их роняли, т.к. их не было в схеме).
--
-- Добавляем АДДИТИВНО (дешёвые поля, существующие ключи сохраняются):
--   top-level: sender_name, receiver_name, total_qty, total_lines
--   items[]:   series (серийники, напр. счётчиков — per-unit traceability),
--              places (число мест), line_no
-- Party-объектов (sender/receiver как objects) в текущей схеме нет —
-- добавляем именно плоские string-поля, структуру не выдумываем.

BEGIN;

-- top-level props: NEW || EXISTING → при конфликте побеждает существующее значение.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{"sender_name":{"type":"string"},"receiver_name":{"type":"string"},"total_qty":{"type":"number"},"total_lines":{"type":"integer"}}'::jsonb
           || (llm_schema->'properties')
       )
 WHERE slug = 'transfer_note';

-- items[].series — добавляем только если ключа ещё нет.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,series}',
         '{"type":"string"}'::jsonb,
         true
       )
 WHERE slug = 'transfer_note'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'series');

-- items[].places
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,places}',
         '{"type":"number"}'::jsonb,
         true
       )
 WHERE slug = 'transfer_note'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'places');

-- items[].line_no
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,items,items,properties,line_no}',
         '{"type":"integer"}'::jsonb,
         true
       )
 WHERE slug = 'transfer_note'
   AND NOT (llm_schema #> '{properties,items,items,properties}' ? 'line_no');

DO $$
DECLARE props jsonb; iprops jsonb;
BEGIN
  SELECT llm_schema->'properties',
         llm_schema #> '{properties,items,items,properties}'
    INTO props, iprops
    FROM document_types WHERE slug='transfer_note';

  IF props IS NULL THEN
    RAISE EXCEPTION 'transfer_note: properties missing';
  END IF;
  IF NOT (props ? 'sender_name' AND props ? 'receiver_name'
          AND props ? 'total_qty' AND props ? 'total_lines') THEN
    RAISE EXCEPTION 'transfer_note: new top-level keys not present (%)', props;
  END IF;

  -- существующие top-level ключи должны уцелеть
  IF NOT (props ? 'source_warehouse' AND props ? 'target_warehouse'
          AND props ? 'organization_inn' AND props ? 'organization_name'
          AND props ? 'items' AND props ? 'date' AND props ? 'number') THEN
    RAISE EXCEPTION 'transfer_note: existing top-level keys clobbered (%)', props;
  END IF;

  IF iprops IS NULL THEN
    RAISE EXCEPTION 'transfer_note: items.items.properties missing';
  END IF;
  IF NOT (iprops ? 'series' AND iprops ? 'places' AND iprops ? 'line_no') THEN
    RAISE EXCEPTION 'transfer_note: new item keys not present (%)', iprops;
  END IF;
  -- существующие item-ключи должны уцелеть
  IF NOT (iprops ? 'qty' AND iprops ? 'code' AND iprops ? 'name'
          AND iprops ? 'unit' AND iprops ? 'price' AND iprops ? 'total') THEN
    RAISE EXCEPTION 'transfer_note: existing item keys clobbered (%)', iprops;
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema #- '{properties,items,items,properties,series}'
                     #- '{properties,items,items,properties,places}'
                     #- '{properties,items,items,properties,line_no}',
         '{properties}',
         (llm_schema->'properties')
           - 'sender_name' - 'receiver_name' - 'total_qty' - 'total_lines'
       )
 WHERE slug = 'transfer_note';
COMMIT;
