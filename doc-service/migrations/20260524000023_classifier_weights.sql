-- Up Migration
--
-- Classifier per-keyword weights. До этой миграции все keywords имели
-- одинаковый weight=1.0, и при равенстве побеждал **длиннее match**.
-- Это давало false-positives: `Country of origin` (16 chars) bили
-- specific patterns типа `PRICE LIST №` (12 chars).
--
-- Real-world кейс: прайс-лист Anji Mingpai №13 классифицировался как
-- `commercial_invoice` через generic `Country of origin` (присутствует
-- в каждой позиции), хотя имеет специфичный `PRICE LIST №` в заголовке.
--
-- Решение: parallel array `classification_keyword_weights numeric[]`
-- с per-keyword весом. Чем выше — тем сильнее. Default 1.0.
-- Backwards-compat: пустой/NULL массив → все веса = 1.0.

BEGIN;

ALTER TABLE document_types
  ADD COLUMN IF NOT EXISTS classification_keyword_weights numeric(4,2)[] DEFAULT NULL;

COMMENT ON COLUMN document_types.classification_keyword_weights IS
  'Parallel array к classification_keywords. weight[i] — вес для keyword[i]. '
  'Higher value = higher priority. NULL/empty array → default 1.0 для всех. '
  'Используется для разрешения конфликтов когда документ матчит несколько типов.';

-- Веса для текущих типов, где это критично:

-- price_list: высокий вес на specific PRICE LIST №, низкий на generic
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 3.0, 1.5]::numeric(4,2)[]
WHERE slug = 'price_list';
-- классификация_keywords: [прайс-?лист, \bprice\s+list\b, прейскурант,
--                          (?:артикул|article|sku).{0,200}(?:цена|price)]

-- eac_conformity_certificate: высокий вес на номер формата «N RU Д-CN»
UPDATE document_types
SET classification_keyword_weights = ARRAY[3.0, 8.0, 4.0, 5.0, 5.0, 4.0]::numeric(4,2)[]
WHERE slug = 'eac_conformity_certificate';
-- keywords: [сертификат соответствия, \bN\s+RU\s+(?:Д-|С-)..., технический регламент,
--            ТР ТС, ТР ЕАЭС, EAC conformity]

-- cert_of_origin: высокий вес на certificate of origin (specific)
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 3.0, 1.5]::numeric(4,2)[]
WHERE slug = 'cert_of_origin';
-- keywords: [сертификат происхождения, certificate of origin, form (CT-1|...),
--            country of origin]
-- NB: `country of origin` тут с низким весом — это generic, в инвойсах тоже есть

-- commercial_invoice: понижаем generic «Country of origin» (для разрешения
-- conflict'а с price_list, который имеет эту фразу в позициях)
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 3.0, 2.0, 3.0, 0.8]::numeric(4,2)[]
WHERE slug = 'commercial_invoice';
-- keywords: [\bcommercial\s+invoice\b, \bINVOICE\s+No\.?\s*..., Incoterms?,
--            \bexporter\b.*\bconsignee\b, \bcountry\s+of\s+origin\b]
-- NB: «country of origin» получает 0.8 — ниже default 1.0, чтобы price_list побеждал

-- proforma_invoice: высокий вес на «proforma invoice» (specific)
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'proforma_invoice';
-- keywords: [\bproforma\s+invoice\b, инвойс-?проформа, предварительный инвойс]

-- wire_transfer_application: высокий вес на «заявление на перевод» (specific)
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 3.0, 2.0, 3.0, 2.0, 1.5, 1.5]::numeric(4,2)[]
WHERE slug = 'wire_transfer_application';

-- weighing_act: высокий вес на «акт взвешивания» (specific)
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 3.0, 3.0, 2.0, 1.5]::numeric(4,2)[]
WHERE slug = 'weighing_act';

-- transport_request: высокие веса на specific patterns заявка-договор
UPDATE document_types
SET classification_keyword_weights = ARRAY[3.0, 4.0, 5.0, 4.0, 3.0]::numeric(4,2)[]
WHERE slug = 'transport_request';

-- payment_order: 5 keywords (после migration 0021 без bare БИК)
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 3.0, 3.0, 3.0]::numeric(4,2)[]
WHERE slug = 'payment_order';

-- bill_of_lading: высокий вес на specific patterns
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'bill_of_lading';

-- packing_list: highest weight на «packing list»
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 4.0]::numeric(4,2)[]
WHERE slug = 'packing_list';

-- TTN/CMR/UPD/AKT/factInvoice/invoice: оставляем default 1.0 (NULL = default),
-- их keywords уже specific. UPDATE не нужен.

-- Sanity check — обновили 9 типов
DO $$
DECLARE updated_count int;
BEGIN
    SELECT count(*) INTO updated_count
    FROM document_types
    WHERE classification_keyword_weights IS NOT NULL;
    IF updated_count < 9 THEN
        RAISE EXCEPTION 'Expected ≥9 rows with classification_keyword_weights, got %', updated_count;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
ALTER TABLE document_types DROP COLUMN IF EXISTS classification_keyword_weights;
COMMIT;
