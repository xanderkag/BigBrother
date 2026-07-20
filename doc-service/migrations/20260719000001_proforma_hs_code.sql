-- Up Migration
--
-- SLAI §4 (2026-07-19): код ТН ВЭД структурным полем. Живой замер — proforma_invoice
-- отдаёт hs_code в 0 из 82 док, потому что в её llm_schema у items[] нет поля hs_code
-- (только qty/line_total/unit_price/description) — модель его просто не спрашивают.
-- Добавляем hs_code + hs_description в схему позиции. Остальные товарные типы
-- (commercial_invoice, packing_list, price_list, contract_specification) hs_code
-- в схеме уже имеют. Recovery-шаг normalize/hs-codes.ts добивает код из текста как
-- страховку; это — корневой фикс, чтобы модель отдавала код сама.

BEGIN;

UPDATE document_types
SET llm_schema = jsonb_set(
      jsonb_set(
        llm_schema,
        '{properties,items,items,properties,hs_code}',
        '{"type":"string","description":"Код ТН ВЭД ЕАЭС (10 цифр) / HS (6-8). Только цифры, без пробелов."}'::jsonb,
        true),
      '{properties,items,items,properties,hs_description}',
      '{"type":"string","description":"Описание товара по ТН ВЭД, если приведено отдельно от наименования позиции."}'::jsonb,
      true)
WHERE slug = 'proforma_invoice'
  AND llm_schema #> '{properties,items,items,properties}' IS NOT NULL;

COMMIT;

-- Down Migration
BEGIN;

UPDATE document_types
SET llm_schema = (llm_schema #- '{properties,items,items,properties,hs_code}')
                 #- '{properties,items,items,properties,hs_description}'
WHERE slug = 'proforma_invoice';

COMMIT;
