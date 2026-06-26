-- Up Migration
--
-- Аудит провалов извлечения 2026-06-26: по commercial_invoice проверяли набор
-- «дешёвых» полей, которые были в схеме 0514 и которые миграции 0522/0608
-- предположительно срезали. Сверка с боевой схемой на проде показала, что
-- ВОССТАНАВЛИВАТЬ почти ничего не нужно — эти ключи уже присутствуют и не
-- извлекать их = баг промпта, а не схемы:
--   payment_terms (string), incoterms (string),
--   exporter.properties.tax_id (VAT/EORI/ИНН), consignee.properties.tax_id,
--   buyer {name,address} top-level, items[].country_of_origin (ISO-3166 a2).
-- Чтобы не клобберить существующие значения (additive-only), эти ключи НЕ трогаем.
--
-- Реально отсутствуют только связки с договором поставки, которые в инвойсах
-- встречаются стабильно («по контракту № … от …»), но никогда не извлекались:
--   contract_no   (string) — номер контракта/договора поставки
--   contract_date (string) — дата контракта поставки
-- Их и добавляем top-level, additively (NEW || EXISTING — конфликт сохраняет старое).

BEGIN;

-- contract_no / contract_date — top-level. Порядок слияния NEW || EXISTING
-- гарантирует, что любой уже существующий ключ сохранит своё значение.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "contract_no":   {"type": "string", "description": "Номер контракта/договора поставки (по контракту №...)"},
            "contract_date": {"type": "string", "description": "Дата контракта/договора поставки"}
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'commercial_invoice';

DO $$
DECLARE
  has_contract_no   boolean;
  has_contract_date boolean;
  -- инварианты: ранее существовавшие ключи обязаны остаться на месте
  keep_payment      boolean;
  keep_incoterms    boolean;
  keep_exp_tax      boolean;
  keep_cons_tax     boolean;
  keep_buyer        boolean;
  keep_item_coo     boolean;
BEGIN
  SELECT
    (llm_schema#>'{properties,contract_no}')   IS NOT NULL,
    (llm_schema#>'{properties,contract_date}') IS NOT NULL,
    (llm_schema#>'{properties,payment_terms}') IS NOT NULL,
    (llm_schema#>'{properties,incoterms}')     IS NOT NULL,
    (llm_schema#>'{properties,exporter,properties,tax_id}')  IS NOT NULL,
    (llm_schema#>'{properties,consignee,properties,tax_id}') IS NOT NULL,
    (llm_schema#>'{properties,buyer}')         IS NOT NULL,
    (llm_schema#>'{properties,items,items,properties,country_of_origin}') IS NOT NULL
  INTO has_contract_no, has_contract_date,
       keep_payment, keep_incoterms, keep_exp_tax, keep_cons_tax, keep_buyer, keep_item_coo
  FROM document_types WHERE slug='commercial_invoice';

  IF NOT has_contract_no THEN
    RAISE EXCEPTION 'commercial_invoice: contract_no not added';
  END IF;
  IF NOT has_contract_date THEN
    RAISE EXCEPTION 'commercial_invoice: contract_date not added';
  END IF;
  -- additive-only: ни один существовавший ключ не должен пропасть
  IF NOT (keep_payment AND keep_incoterms AND keep_exp_tax
          AND keep_cons_tax AND keep_buyer AND keep_item_coo) THEN
    RAISE EXCEPTION 'commercial_invoice: pre-existing key was clobbered (payment=% incoterms=% exp_tax=% cons_tax=% buyer=% item_coo=%)',
      keep_payment, keep_incoterms, keep_exp_tax, keep_cons_tax, keep_buyer, keep_item_coo;
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = (llm_schema #- '{properties,contract_no}') #- '{properties,contract_date}'
 WHERE slug = 'commercial_invoice';
COMMIT;
