-- Up Migration
--
-- doclegal-invoice.pdf (Ozon «Счёт-Оферта №...») классифицировался как
-- UPD из-за упоминания «УПД» в мелком тексте offer terms:
--
--   «...сумма НДС выделяется отдельной строкой в УПД, подлежащем
--    размещению в его Личном кабинете после получения заказа.»
--
-- Это типичный case Ozon B2B-биллинга — Счёт-Оферта (combined invoice +
-- offer) ссылается на отдельный УПД, который выставляется позже. Real-case
-- 2026-05-18 (EDO smoke).
--
-- Решение:
-- 1. Добавляем в invoice keyword `\bсч[её]т-оферт[ау]?\b` с весом 6.0 —
--    специфичный headline-pattern, перебивает body-mention «УПД» (1.0).
-- 2. invoice + invoice keyword weights были NULL (default 1.0). Проставляем
--    explicit weights 5.0 для всех signature patterns, чтобы title-position
--    boost работал предсказуемо.
-- 3. UPD keywords тоже ставим weight'ы (5.0 для signature, 4.0 для simple
--    «\bУПД\b» mention — должен проиграть headline-pattern invoice'а).
--
-- Future-proof: incidental mention «УПД» в любом body-тексте не должен
-- больше определять тип документа сам по себе. Только в title-position
-- (с boost'ом ×1.5 → 6.0) даст confident match.

BEGIN;

-- ── invoice: + Счёт-Оферта + explicit weights ──────────────────────
UPDATE document_types
SET classification_keywords = ARRAY[
    '(?:^|\W)сч[её]т\s+на\s+оплату(?:\W|$)',
    '(?:^|\W)сч[её]т\s+№',
    '(?:^|\W)сч[её]т-оферт[ау]?\b',                          -- NEW: Ozon Счёт-Оферта
    '(?:^|\W)инвойс\s+№',
    '(?:^|\W)инвойс\s+на\s+оплату(?:\W|$)'
]::text[],
classification_keyword_weights = ARRAY[5.0, 5.0, 6.0, 5.0, 5.0]::numeric(4,2)[]
WHERE slug = 'invoice';

-- ── UPD: explicit weights — body-mention слабее ───────────────────
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 4.0]::numeric(4,2)[]
WHERE slug = 'UPD';

-- Sanity check
DO $$
DECLARE updated_count int;
BEGIN
    SELECT count(*) INTO updated_count
    FROM document_types
    WHERE slug IN ('invoice', 'UPD');
    IF updated_count <> 2 THEN
        RAISE EXCEPTION 'Expected 2 rows updated, got %', updated_count;
    END IF;
END $$;

COMMIT;

-- Down Migration — invoice без Счёт-Оферта, weights → NULL.
BEGIN;

UPDATE document_types
SET classification_keywords = ARRAY[
    '(?:^|\W)сч[её]т\s+на\s+оплату(?:\W|$)',
    '(?:^|\W)сч[её]т\s+№',
    '(?:^|\W)инвойс\s+№',
    '(?:^|\W)инвойс\s+на\s+оплату(?:\W|$)'
]::text[],
classification_keyword_weights = NULL
WHERE slug = 'invoice';

UPDATE document_types
SET classification_keyword_weights = NULL
WHERE slug = 'UPD';

COMMIT;
