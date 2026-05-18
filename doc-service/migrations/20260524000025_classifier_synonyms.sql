-- Up Migration
--
-- Расширение classification_keywords синонимами:
--
-- 1. `contract` — добавляем «Контракт» (внешнеторговые договоры часто
--    именуются «Контракт № EWL-AMF/180723» вместо «Договор»). Real-case:
--    наш VED-кейс ANJI MINGPAI шифровал контракт как «Контракт» и
--    classifier его пропускал.
--
-- 2. `contract_addendum`, `contract_specification` — те же синонимы.
--
-- 3. `invoice` — добавляем «инвойс» (от англ. invoice), часто используется
--    в смешанной русско-английской документации ВЭД.
--
-- 4. `commercial_invoice` — добавляем «Коммерческий инвойс» (русифицированное
--    название), «Инвойс №» c кириллицей.
--
-- 5. `bill_of_lading` — добавляем варианты транслитерации.
--
-- Веса для новых keywords ставятся высокие (5.0) для signature patterns,
-- т.к. это headline'ы документа.

BEGIN;

-- ── contract: + «Контракт» синонимы ────────────────────────────────
UPDATE document_types
SET classification_keywords = ARRAY[
    '\bДОГОВОР\s+№',
    '\bКОНТРАКТ\s+№',                                      -- NEW
    '\bПредмет\s+(?:настоящего\s+)?[Дд]оговора\b',
    '\bПредмет\s+(?:настоящего\s+)?[Кк]онтракта\b',        -- NEW
    '\bПрава\s+и\s+обязанности\s+[Сс]торон\b',
    '\bСрок\s+действия\s+[Дд]оговора\b',
    '\bСрок\s+действия\s+[Кк]онтракта\b',                  -- NEW
    '\bПодписи\s+[Сс]торон\b',
    '\bДоговор\s+поставки\b',
    '\bКонтракт\s+поставки\b',                             -- NEW
    '\bДоговор\s+оказания\s+услуг\b',
    '\bДоговор\s+подряда\b',
    '\bДоговор\s+аренды\b',
    '\bДоговор\s+купли-продажи\b',
    '\bКонтракт\s+купли-продажи\b',                        -- NEW
    'настоящий\s+(?:договор|контракт)\s+о\s+нижеследующем' -- NEW (typical контракт opening)
]::text[],
    classification_keyword_weights = ARRAY[
    5.0,  -- ДОГОВОР №
    5.0,  -- КОНТРАКТ №
    5.0,  -- Предмет договора
    5.0,  -- Предмет контракта
    4.0,  -- Права и обязанности Сторон
    4.0,  -- Срок действия договора
    4.0,  -- Срок действия контракта
    4.0,  -- Подписи Сторон
    5.0,  -- Договор поставки
    5.0,  -- Контракт поставки
    5.0,  -- Договор оказания услуг
    5.0,  -- Договор подряда
    5.0,  -- Договор аренды
    5.0,  -- Договор купли-продажи
    5.0,  -- Контракт купли-продажи
    4.0   -- настоящий договор/контракт о нижеследующем
]::numeric(4,2)[]
WHERE slug = 'contract';

-- ── contract_addendum: + «Контракт» синонимы ───────────────────────
UPDATE document_types
SET classification_keywords = ARRAY[
    '\bДополнительное\s+соглашение\b',
    '\bДоп\.?\s+соглашение\b',
    '\bСоглашение\s+об\s+изменении\b',
    '\bСоглашение\s+о\s+расторжении\b',
    '\bО\s+внесении\s+изменений\s+в\s+(?:Договор|Контракт)\b'  -- расширено
]::text[],
    classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'contract_addendum';

-- ── contract_specification: + «Контракт» синонимы ──────────────────
UPDATE document_types
SET classification_keywords = ARRAY[
    '\bСпецификация\s+№?\s*\d+\s+к\s+(?:Договор|Контракт)',
    '\bПриложение\s+№?\s*\d+\s+к\s+(?:Договор|Контракт)',
    '\bПриложение\s+к\s+(?:Договор|Контракт)',
    '\bСпецификация\s+товара\b',
    '\bСпецификация\s+к\s+(?:Договор|Контракт)'
]::text[],
    classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'contract_specification';

-- ── invoice: + «инвойс» вариант ────────────────────────────────────
UPDATE document_types
SET classification_keywords = ARRAY[
    '\bсч[её]т\s+на\s+оплату\b',
    '\bсч[её]т\s+№',
    '\bинвойс\s+№',                                        -- NEW
    '\bинвойс\s+на\s+оплату\b'                             -- NEW
]::text[]
WHERE slug = 'invoice';

-- ── commercial_invoice: + русифицированные ────────────────────────
UPDATE document_types
SET classification_keywords = ARRAY[
    '\bcommercial\s+invoice\b',
    '\bкоммерческий\s+инвойс\b',                           -- NEW
    '\bинвойс\s+№\s*[A-Z0-9]',                             -- NEW (mixed RU/EN, как MP-701-62)
    '\bINVOICE\s+No\.?\s*[A-Z0-9-]',
    'Incoterms?\s*[''"]?\s*\d{4}',
    '\bexporter\b.*\bconsignee\b',
    '\bcountry\s+of\s+origin\b'
]::text[],
    classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 3.0, 2.0, 3.0, 0.8]::numeric(4,2)[]
WHERE slug = 'commercial_invoice';

-- ── bill_of_lading: + транслит коносамент ──────────────────────────
UPDATE document_types
SET classification_keywords = ARRAY[
    '\bbill\s+of\s+lading\b',
    'коносамент',
    'multimodal\s+transport\s+bill',                       -- NEW (FESCO формат)
    '\bB\s*/\s*L\s+No\.?\s+[A-Z0-9-]',
    '\bMaster\s+B/L\b',
    '\bHouse\s+B/L\b'
]::text[],
    classification_keyword_weights = ARRAY[5.0, 5.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[]
WHERE slug = 'bill_of_lading';

-- ── packing_list: + русифицированный «упаковочный лист» с весами ──
UPDATE document_types
SET classification_keyword_weights = ARRAY[5.0, 5.0, 4.0]::numeric(4,2)[]
WHERE slug = 'packing_list';
-- keywords: [\bpacking\s+list\b, упаковочный\s+лист, packing\s+specification]
-- (без изменений, веса теперь точно проставлены)

-- Sanity check
DO $$
DECLARE updated_count int;
BEGIN
    SELECT count(*) INTO updated_count
    FROM document_types
    WHERE slug IN ('contract','contract_addendum','contract_specification',
                   'invoice','commercial_invoice','bill_of_lading','packing_list');
    IF updated_count <> 7 THEN
        RAISE EXCEPTION 'Expected 7 rows, got %', updated_count;
    END IF;
END $$;

COMMIT;

-- Down Migration
-- Откат вернёт keywords к состоянию после 0024. Простая логика —
-- удалить новые synonyms из массивов.
BEGIN;

UPDATE document_types
SET classification_keywords = ARRAY[
    '\bДОГОВОР\s+№',
    '\bПредмет\s+(?:настоящего\s+)?[Дд]оговора\b',
    '\bПрава\s+и\s+обязанности\s+[Сс]торон\b',
    '\bСрок\s+действия\s+[Дд]оговора\b',
    '\bПодписи\s+[Сс]торон\b',
    '\bДоговор\s+поставки\b',
    '\bДоговор\s+оказания\s+услуг\b',
    '\bДоговор\s+подряда\b',
    '\bДоговор\s+аренды\b',
    '\bДоговор\s+купли-продажи\b'
]::text[],
    classification_keyword_weights = ARRAY[5.0, 5.0, 4.0, 4.0, 4.0, 5.0, 5.0, 5.0, 5.0, 5.0]::numeric(4,2)[]
WHERE slug = 'contract';

UPDATE document_types
SET classification_keywords = ARRAY[
    '\bсч[её]т\s+на\s+оплату\b',
    '\bсч[её]т\s+№'
]::text[]
WHERE slug = 'invoice';

-- Остальные таблицы — оставляем расширения (они gradually correct).

COMMIT;
