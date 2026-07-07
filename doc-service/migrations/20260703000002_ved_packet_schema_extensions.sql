-- Up Migration
--
-- VANGA-VED-1 §3.2/§3.3/§3.6: мелкие аддитивные расширения существующих
-- типов под транзитный комплект (реальные данные БКТ Транзит).
--   commercial_invoice → specification_reference (ссылка на спецификацию,
--                        встречается в шапке инвойса комплекта №1).
--   packing_list       → contract_reference, total_pallets (шапка/итоги) +
--                        per-line pallets (несколько товаров на паллете).
--   transport_request  → customs_post_entry (т/п въезда), border_crossing (КПП).
--                        КЛЮЧЕВОЕ для перецепа: заявка несёт РФ-машину + т/п,
--                        которых нет в CMR (§ ved-transit-packet-ingest A5).
--
-- Паттерн: shallow-merge (`||`) новых свойств в существующий `properties`-узел
-- — не трогает и не удаляет существующие поля. Для custom-типов DB.llm_schema
-- авторитетна (GenericLlmParser), поэтому правим её. Forward-only, идемпотентно
-- (повторный прогон перезапишет те же ключи теми же значениями).

BEGIN;

-- ── commercial_invoice: specification_reference ─────────────────────
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      (llm_schema -> 'properties') || '{
        "specification_reference": {"type": "string", "description": "Ссылка на спецификацию к контракту (номер/дата), если указана в шапке инвойса"}
      }'::jsonb
    )
WHERE slug = 'commercial_invoice'
  AND llm_schema -> 'properties' IS NOT NULL;

-- ── packing_list: top-level contract_reference + total_pallets ──────
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      (llm_schema -> 'properties') || '{
        "contract_reference": {"type": "string", "description": "Ссылка на контракт/инвойс"},
        "total_pallets": {"type": "number", "description": "Общее количество паллет (может быть дробным при неполной паллете)"}
      }'::jsonb
    )
WHERE slug = 'packing_list'
  AND llm_schema -> 'properties' IS NOT NULL;

-- ── packing_list: per-line pallets (несколько товаров на паллете) ───
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties,items,items,properties}',
      (llm_schema #> '{properties,items,items,properties}') || '{
        "pallets": {"type": "number", "description": "Число паллет по позиции (допускается дробное/повтор номера паллеты)"}
      }'::jsonb
    )
WHERE slug = 'packing_list'
  AND llm_schema #> '{properties,items,items,properties}' IS NOT NULL;

-- ── transport_request: customs_post_entry + border_crossing ─────────
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      (llm_schema -> 'properties') || '{
        "customs_post_entry": {"type": "string", "description": "Таможенный пост въезда (код т/п), если указан в заявке"},
        "border_crossing": {"type": "string", "description": "Пункт пропуска через границу (КПП)"}
      }'::jsonb
    )
WHERE slug = 'transport_request'
  AND llm_schema -> 'properties' IS NOT NULL;

-- Sanity check — все четыре поля появились там, где ожидаем.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM document_types
                    WHERE slug = 'commercial_invoice'
                      AND llm_schema #> '{properties,specification_reference}' IS NOT NULL) THEN
        RAISE EXCEPTION 'commercial_invoice.specification_reference not added';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM document_types
                    WHERE slug = 'transport_request'
                      AND llm_schema #> '{properties,customs_post_entry}' IS NOT NULL) THEN
        RAISE EXCEPTION 'transport_request.customs_post_entry not added';
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;

UPDATE document_types
SET llm_schema = jsonb_set(llm_schema, '{properties}',
      (llm_schema -> 'properties') - 'specification_reference')
WHERE slug = 'commercial_invoice';

UPDATE document_types
SET llm_schema = jsonb_set(llm_schema, '{properties}',
      (llm_schema -> 'properties') - 'contract_reference' - 'total_pallets')
WHERE slug = 'packing_list';

UPDATE document_types
SET llm_schema = jsonb_set(llm_schema, '{properties,items,items,properties}',
      (llm_schema #> '{properties,items,items,properties}') - 'pallets')
WHERE slug = 'packing_list'
  AND llm_schema #> '{properties,items,items,properties}' IS NOT NULL;

UPDATE document_types
SET llm_schema = jsonb_set(llm_schema, '{properties}',
      (llm_schema -> 'properties') - 'customs_post_entry' - 'border_crossing')
WHERE slug = 'transport_request';

COMMIT;
