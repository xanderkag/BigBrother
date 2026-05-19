-- Up Migration
--
-- 1. contract_specification — headline regex слишком жадный. Все текущие
--    patterns требуют «Спецификация ... к Договор» в одном фрагменте,
--    но реальные spec-документы из ЭДО разделяют это строкой с датой:
--
--      Спецификация №1
--      от «12» мая 2026 г.
--      к Договору №  143/221.04
--
--    `\s+` в regex матчит \n, но между «№1» и «к» есть literal text
--    («от «12» мая 2026 г.») — pattern не срабатывает. В результате
--    classifier фолбэчит на contract через «Подписи Сторон» (weight 4.0)
--    в теле документа.
--
--    Решение: добавляем standalone headline pattern «Спецификация №N»
--    без требования следующего «к Договор». В title window (chars 0-500)
--    он получает effective weight 5.0 × 1.5 = 7.5 — перебивает contract'овский
--    «Подписи Сторон» (4.0). В body (ссылка из тела договора на спецификацию)
--    обычные 5.0 — что НЕ перебивает contract'овский title-match
--    «^Договор № …» (weight 20.0 ровно потому, что title-position match
--    из migration 0024).
--
--    Real-case 2026-05-18 (EDO smoke): spec-1.docx + spec-5.docx
--    классифицировались как contract вместо contract_specification.
--
-- 2. transfer_note — формализуем in-place правки от manual SQL update
--    (пользователь добавил «накладная на перемещение» прямо в БД во
--    время EDO-smoke кейса). Migration делает state БД и репозитория
--    согласованным; для свежего разворота 0028 → 0030 даст итоговую
--    форму без промежуточного дёргания вручную.
--
--    Real text format (1С): «Накладная на перемещение № 1127 от 14 мая
--    2026 г.» — keyword «перемещение товаров» (с обязательным словом
--    «товаров») не ловил его, поэтому peremeshchenie.pdf падал в null.

BEGIN;

-- ── contract_specification ─────────────────────────────────────────
UPDATE document_types
SET classification_keywords = ARRAY[
    '(?:^|\W)Спецификация\s+№?\s*\d+\s+к\s+(?:Договор|Контракт)',
    '(?:^|\W)Приложение\s+№?\s*\d+\s+к\s+(?:Договор|Контракт)',
    '(?:^|\W)Приложение\s+к\s+(?:Договор|Контракт)',
    '(?:^|\W)Спецификация\s+товара(?:\W|$)',
    '(?:^|\W)Спецификация\s+к\s+(?:Договор|Контракт)',
    '(?:^|\W)Спецификация\s+№?\s*\d+(?:\W|$)'  -- NEW: standalone headline
]::text[],
classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0, 5.0]::numeric(4,2)[]
WHERE slug = 'contract_specification';

-- ── transfer_note ──────────────────────────────────────────────────
-- Формализация manual SQL-патча: «накладная на перемещение» для 1С-формата.
UPDATE document_types
SET classification_keywords = ARRAY[
    'перемещение\s+товаров',
    'накладная\s+на\s+перемещение',                           -- formalized from manual SQL
    '\bТОРГ-?13\b',
    'отправитель.{0,40}получатель.{0,200}склад',
    '(?:склад|места?\s+хранения).{0,80}(?:откуда|куда|источник|назначение)'
]::text[],
classification_keyword_weights = ARRAY[6.0, 6.0, 5.0, 3.0, 3.0]::numeric(4,2)[]
WHERE slug = 'transfer_note';

-- Sanity check
DO $$
DECLARE updated_count int;
BEGIN
    SELECT count(*) INTO updated_count
    FROM document_types
    WHERE slug IN ('contract_specification', 'transfer_note');
    IF updated_count <> 2 THEN
        RAISE EXCEPTION 'Expected 2 rows updated, got %', updated_count;
    END IF;
END $$;

COMMIT;

-- Down Migration — откат к состоянию migration 0028 + 0025/0026 для spec.
BEGIN;

UPDATE document_types
SET classification_keywords = ARRAY[
    '(?:^|\W)Спецификация\s+№?\s*\d+\s+к\s+(?:Договор|Контракт)',
    '(?:^|\W)Приложение\s+№?\s*\d+\s+к\s+(?:Договор|Контракт)',
    '(?:^|\W)Приложение\s+к\s+(?:Договор|Контракт)',
    '(?:^|\W)Спецификация\s+товара(?:\W|$)',
    '(?:^|\W)Спецификация\s+к\s+(?:Договор|Контракт)'
]::text[],
classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'contract_specification';

UPDATE document_types
SET classification_keywords = ARRAY[
    'перемещение\s+товаров',
    '\bТОРГ-?13\b',
    'отправитель.{0,40}получатель.{0,200}склад',
    '(?:склад|места?\s+хранения).{0,80}(?:откуда|куда|источник|назначение)'
]::text[],
classification_keyword_weights = ARRAY[6.0, 5.0, 3.0, 3.0]::numeric(4,2)[]
WHERE slug = 'transfer_note';

COMMIT;
