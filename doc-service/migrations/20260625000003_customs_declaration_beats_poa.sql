-- Up Migration
--
-- Боевой батч 2026-06-25: декларация на товары (ГТД/ДТ) `GTD_10228010...` ушла в
-- `power_of_attorney`. Причина: у power_of_attorney ключ `доверенность` (голое
-- слово) вес 6 — выше, чем `декларация на товары` (вес 5) у customs_declaration.
-- В ДТ декларант действует «на основании доверенности» → PoA ложно выигрывал.
-- Голый `доверенность` жадный: ловит счета/акты/ДТ, где доверенность лишь упомянута.
--
-- Фикс:
--   1. customs_declaration: «ДЕКЛАРАЦИЯ НА ТОВАРЫ» — ОПРЕДЕЛЯЮЩИЙ заголовок ДТ
--      (только у деклараций) → вес 5→8, чтобы уверенно бить PoA даже без title-boost.
--   2. power_of_attorney: `доверенность` → анкер на ЗАГОЛОВОК `(?:^|\n)\s*доверенность`
--      (реальная доверенность = заголовок в начале строки; «на основании доверенности»
--      в теле больше не триггерит). Бэкап-ключи (м-2/доверяю/уполномочивает) остаются.

BEGIN;

-- 1. Поднять вес definitive-заголовка декларации (index 1 = «декларация на товары»).
UPDATE document_types
   SET classification_keyword_weights[1] = 8.0
 WHERE slug = 'customs_declaration'
   AND classification_keywords[1] = '(?:^|\W)декларация\s+на\s+товары(?:\W|$)';

-- 2. Заякорить голый `доверенность` на заголовок.
UPDATE document_types
   SET classification_keywords =
         array_replace(classification_keywords, 'доверенность', '(?:^|\n)\s*доверенность')
 WHERE slug = 'power_of_attorney';

DO $$
DECLARE dt_w numeric; poa_anchored int;
BEGIN
  SELECT classification_keyword_weights[1] INTO dt_w
    FROM document_types WHERE slug='customs_declaration';
  IF dt_w <> 8.0 THEN
    RAISE EXCEPTION 'customs_declaration heading weight not 8 (got %)', dt_w;
  END IF;
  SELECT count(*) INTO poa_anchored FROM document_types
    WHERE slug='power_of_attorney'
      AND '(?:^|\n)\s*доверенность' = ANY(classification_keywords)
      AND NOT ('доверенность' = ANY(classification_keywords));
  IF poa_anchored <> 1 THEN
    RAISE EXCEPTION 'power_of_attorney доверенность not anchored cleanly';
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET classification_keyword_weights[1] = 5.0
 WHERE slug = 'customs_declaration'
   AND classification_keywords[1] = '(?:^|\W)декларация\s+на\s+товары(?:\W|$)';
UPDATE document_types
   SET classification_keywords =
         array_replace(classification_keywords, '(?:^|\n)\s*доверенность', 'доверенность')
 WHERE slug = 'power_of_attorney';
COMMIT;
