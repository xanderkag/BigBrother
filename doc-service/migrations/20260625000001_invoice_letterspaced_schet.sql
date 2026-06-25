-- Up Migration
--
-- Транспортные счета (СЧЁТ на услуги) с жирным блоком банковских реквизитов
-- (SWIFT / банк-корреспондент для RUB/EUR/USD) ошибочно классифицировались как
-- `wire_transfer_application` (платёжка), у которой в схеме НЕТ позиций → строка
-- услуги терялась целиком.
--
-- Причина (подтверждено на проде): заголовок «С Ч Е Т» набран ВРАЗРЯДКУ (буквы
-- через пробел), а invoice-ключ `сч[её]т\s+№` разрядку не матчит → invoice
-- набирал 0, а wire_transfer выигрывал на SWIFT-кодах. Настоящих маркеров
-- платёжки («заявление на перевод» / «платёжное поручение») в этих документах нет.
--
-- Фикс: добавить invoice DB-ключ, толерантный к разрядке между буквами «СЧЁТ»
-- (`с\s*ч\s*[её]\s*т`), с высоким весом 6 (в шапке ×1.5 title-boost = 9), чтобы
-- счёт уверенно обходил платёжку. `\s*` = 0+ пробелов, поэтому обычное «счёт №»
-- тоже покрывается (сигнал не теряется). Классификатор Stage 1 = DB-правила, так
-- что этого ключа достаточно (см. classifier/keywords.ts).

BEGIN;

UPDATE document_types
   SET classification_keywords =
         classification_keywords || ARRAY['(?:^|\W)с\s*ч\s*[её]\s*т\s*(?:№|no|n°|nº|#|на\s+оплату)']::text[],
       classification_keyword_weights =
         classification_keyword_weights || ARRAY[6.0]::numeric(4,2)[]
 WHERE slug = 'invoice';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM document_types
   WHERE slug = 'invoice'
     AND '(?:^|\W)с\s*ч\s*[её]\s*т\s*(?:№|no|n°|nº|#|на\s+оплату)' = ANY(classification_keywords)
     AND array_length(classification_keywords, 1) = array_length(classification_keyword_weights, 1);
  IF n <> 1 THEN
    RAISE EXCEPTION 'invoice letter-spaced СЧЁТ keyword not added cleanly (n=%)', n;
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET classification_keywords =
         classification_keywords[1:array_length(classification_keywords, 1) - 1],
       classification_keyword_weights =
         classification_keyword_weights[1:array_length(classification_keyword_weights, 1) - 1]
 WHERE slug = 'invoice'
   AND classification_keywords[array_length(classification_keywords, 1)] =
         '(?:^|\W)с\s*ч\s*[её]\s*т\s*(?:№|no|n°|nº|#|на\s+оплату)';
COMMIT;
