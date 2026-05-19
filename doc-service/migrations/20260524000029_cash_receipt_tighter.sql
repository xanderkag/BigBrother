-- Up Migration
--
-- cash_receipt classification keywords слишком жадные — ловили обычные
-- счета на оплату через generic «ИТОГ.*\d» (есть в каждом инвойсе) и
-- «КАССА» (упоминается в payment_terms «оплата в кассу»).
--
-- Real case 2026-05-18 (EDO smoke): 2 PDF счёта (doclegal-invoice +
-- schet-na-oplatu) попали в cash_receipt вместо invoice.
--
-- Решение: оставляем только fiscal-signature patterns — кассовый чек,
-- ФН/ФД/ФПД (фискальные данные), 54-ФЗ. Это **только** настоящие
-- кассовые чеки, без false-positive на счетах.

BEGIN;

UPDATE document_types
SET classification_keywords = ARRAY[
    '(?:^|\W)кассовый\s+чек(?:\W|$)',
    '(?:^|\W)ФН\s+\d{16}',
    '(?:^|\W)ФД\s+\d',
    '(?:^|\W)ФПД?\b\s*\d',
    '54-ФЗ'
]::text[],
classification_keyword_weights = ARRAY[6.0, 5.0, 5.0, 4.0, 3.0]::numeric(4,2)[]
WHERE slug = 'cash_receipt';

COMMIT;

-- Down Migration — возвращаем generic «ИТОГ» / «КАССА» (legacy).
BEGIN;
UPDATE document_types
SET classification_keywords = ARRAY[
    '(?:^|\W)кассовый\s+чек(?:\W|$)',
    '(?:^|\W)ФН\s+\d{16}',
    '(?:^|\W)ФД\s+\d',
    '(?:^|\W)ФПД?\b\s*\d',
    '(?:^|\W)КАССА(?:\W|$)',
    'ИТОГ(?:\W|$).*\d',
    '54-ФЗ'
]::text[],
classification_keyword_weights = ARRAY[5.0, 4.0, 4.0, 3.0, 3.0, 3.0, 3.0]::numeric(4,2)[]
WHERE slug = 'cash_receipt';
COMMIT;
