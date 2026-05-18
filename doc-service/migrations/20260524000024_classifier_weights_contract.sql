-- Up Migration
--
-- Дополнение migration 0023: contract пропущен в weight-update'е, и
-- проигрывал price_list когда контракт ссылается на прайс-лист
-- (типовая ситуация: «согласно прайс-листу № 13...» в тексте).
--
-- Real case: VED-контракт EWL-AMF/180723 содержит ссылку на price-list
-- в одном из разделов → classifier через keyword "прайс-лист" с
-- weight=5.0 (price_list) бил contract keywords с default weight=1.0.

BEGIN;

UPDATE document_types
SET classification_keyword_weights = ARRAY[
    5.0, -- \bДОГОВОР\s+№
    5.0, -- \bПредмет ... договора\b
    4.0, -- \bПрава и обязанности Сторон\b
    4.0, -- \bСрок действия договора\b
    4.0, -- \bПодписи Сторон\b
    5.0, -- \bДоговор поставки\b
    5.0, -- \bДоговор оказания услуг\b
    5.0, -- \bДоговор подряда\b
    5.0, -- \bДоговор аренды\b
    5.0  -- \bДоговор купли-продажи\b
]::numeric(4,2)[]
WHERE slug = 'contract';

-- contract_addendum, contract_specification — те же категории, тоже high
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'contract_addendum';

UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'contract_specification';

-- customs_declaration — таможенная декларация, очень специфичный документ
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'customs_declaration';

-- transport_invoice — ТН формы 2013 (Пост. Прав. РФ № 272)
UPDATE document_types
SET classification_keyword_weights = ARRAY[6.0, 5.0, 4.0]::numeric(4,2)[]
WHERE slug = 'transport_invoice';

-- cash_receipt — кассовый чек, специфичный
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 4.0, 4.0, 3.0, 3.0, 3.0, 3.0]::numeric(4,2)[]
WHERE slug = 'cash_receipt';

-- waybill — путевой лист
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'waybill';

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
SET classification_keyword_weights = NULL
WHERE slug IN ('contract', 'contract_addendum', 'contract_specification',
               'customs_declaration', 'transport_invoice', 'cash_receipt',
               'waybill');
COMMIT;
