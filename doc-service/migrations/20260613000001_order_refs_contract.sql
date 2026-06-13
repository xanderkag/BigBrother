-- PD-CONTRACT-1 Q2 / §2.1 (SLAI 2026-06-13): order_refs[] — #1 match-signal
-- после контейнера. Добавляем свободный массив ссылок на заказ/PO в llm_schema
-- DB-типа `contract`. Договор поставки часто ссылается на заказ покупателя
-- («во исполнение заказа №», «по заказу №», PO number) — это даёт SLAI matcher'у
-- ещё один сигнал привязки документа к сделке.
--
-- TS-типы (invoice/tax_invoice/upd/ttn/cmr/bill_of_lading) получают order_refs
-- через src/types/document-json-schemas.ts (ORDER_REFS) — для них миграция не
-- нужна, схема живёт в коде. Здесь — только DB-резидентный `contract`.
--
-- Description совпадает дословно с ORDER_REFS из TS-схемы (single wording).
-- Additive: только добавляем ключ в properties, остальную схему не трогаем.
-- expected_fields НЕ меняем (order_refs опционален — не должен ронять acceptance).
-- Admin может переопределить через UI (Document Type Registry).

-- Up Migration

BEGIN;

UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties,order_refs}', '{
        "type": "array",
        "description": "Номера заказов/PO, упомянутые в документе («Заказ №», «Order Ref», «Our ref.», PO number, «по заказу №»). Как есть, без трактовки. Пустой массив, если нет.",
        "items": {"type": "string"}
      }'::jsonb,
      true
    ),
    updated_at = now()
WHERE slug = 'contract'
  AND llm_schema IS NOT NULL
  AND llm_schema -> 'properties' IS NOT NULL;

-- Sanity check — contract теперь имеет order_refs[] в схеме (если строка есть)
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM document_types
     WHERE slug = 'contract'
       AND (llm_schema -> 'properties' ? 'order_refs');
    IF n = 0 THEN
        RAISE WARNING 'contract: order_refs not added (row missing or llm_schema NULL) — skipped';
    END IF;
END $$;

COMMIT;

-- Down Migration

BEGIN;

UPDATE document_types
SET llm_schema = llm_schema #- '{properties,order_refs}',
    updated_at = now()
WHERE slug = 'contract';

COMMIT;
