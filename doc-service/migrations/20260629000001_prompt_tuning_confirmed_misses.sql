-- Up Migration
--
-- Доработка промптов по итогам замера заполнения 2026-06-29 (живой reprocess
-- + диагностика меток в raw_text). Для этих полей МЕТКА присутствует в тексте
-- документов, но phi4 их НЕ извлекал — реальный недобор, причина в llm_prompt,
-- который не перечислял поле (схемы уже содержат их). Только append к llm_prompt:
--   invoice          — payee (банк-получатель в 3/3 доков, payee пуст 0/3)
--   bill_of_lading   — carrier + shipped_on_board + place/date_of_issue
--   UKD              — seller_kpp/buyer_kpp + base_doc_refs + currency_code (КПП в 2/2)
--   commercial_invoice — contract_no/contract_date (ссылка на договор в 3/3)
-- Схемы и код не трогаем. Forward-only.

BEGIN;

UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' Если в платёжных реквизитах есть отдельный ПОЛУЧАТЕЛЬ ПЛАТЕЖА («Получатель», «Банк получателя») — на агентских и маркетплейс-счетах он отличается от продавца — заполни payee (name, inn, kpp, account, bank_name, bic).'
 WHERE slug = 'invoice';

UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' shipped_on_board — дата «Shipped on Board» (фактическая погрузка на судно), отдельно от date, формат YYYY-MM-DD. place_of_issue / date_of_issue — место и дата выдачи коносамента. carrier — название морской линии/перевозчика (Maersk, MSC, COSCO, ...), НЕ экспедитора и НЕ грузоотправителя.'
 WHERE slug = 'bill_of_lading';

UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' seller_kpp / buyer_kpp — КПП продавца и покупателя (9 цифр), если указаны рядом с ИНН. currency_code — код валюты (ISO 4217). base_doc_refs[] — список исходных документов (УПД/счёт-фактур) вида {type, number, date}, к которым относится корректировка.'
 WHERE slug = 'UKD';

UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' contract_no / contract_date — номер и дата договора поставки, ТОЛЬКО если в инвойсе есть ссылка на конкретный контракт (например "Contract No. ABC-123 dd ..."), а не общие условия продажи. Иначе null.'
 WHERE slug = 'commercial_invoice';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM document_types
   WHERE (slug = 'invoice'            AND llm_prompt LIKE '%ПОЛУЧАТЕЛЬ ПЛАТЕЖА%')
      OR (slug = 'bill_of_lading'     AND llm_prompt LIKE '%Shipped on Board%')
      OR (slug = 'UKD'                AND llm_prompt LIKE '%base_doc_refs%')
      OR (slug = 'commercial_invoice' AND llm_prompt LIKE '%contract_no%');
  IF n <> 4 THEN
    RAISE EXCEPTION 'prompt tuning: expected 4 rows updated, got %', n;
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' Если в платёжных реквизитах есть отдельный ПОЛУЧАТЕЛЬ ПЛАТЕЖА («Получатель», «Банк получателя») — на агентских и маркетплейс-счетах он отличается от продавца — заполни payee (name, inn, kpp, account, bank_name, bic).', '')
 WHERE slug = 'invoice';
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' shipped_on_board — дата «Shipped on Board» (фактическая погрузка на судно), отдельно от date, формат YYYY-MM-DD. place_of_issue / date_of_issue — место и дата выдачи коносамента. carrier — название морской линии/перевозчика (Maersk, MSC, COSCO, ...), НЕ экспедитора и НЕ грузоотправителя.', '')
 WHERE slug = 'bill_of_lading';
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' seller_kpp / buyer_kpp — КПП продавца и покупателя (9 цифр), если указаны рядом с ИНН. currency_code — код валюты (ISO 4217). base_doc_refs[] — список исходных документов (УПД/счёт-фактур) вида {type, number, date}, к которым относится корректировка.', '')
 WHERE slug = 'UKD';
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' contract_no / contract_date — номер и дата договора поставки, ТОЛЬКО если в инвойсе есть ссылка на конкретный контракт (например "Contract No. ABC-123 dd ..."), а не общие условия продажи. Иначе null.', '')
 WHERE slug = 'commercial_invoice';
COMMIT;
