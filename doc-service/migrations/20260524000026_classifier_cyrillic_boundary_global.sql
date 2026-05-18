-- Up Migration
--
-- Defensive bulk-fix для всех Cyrillic `\b`-патернов в classification_keywords.
--
-- ROOT CAUSE: JS regex `\b` (word boundary) работает только для ASCII
-- word-chars [A-Za-z0-9_]. Кириллические буквы НЕ считаются \w в V8.
-- Pattern `\bТТН\b` НИКОГДА не матчит русское «ТТН» — \b не срабатывает
-- на границе с кириллицей.
--
-- В миграции 25 пофиксили только contract. Защитная разведка показала
-- тот же баг в 30+ keywords других типов: AKT, TTN, UPD, CMR,
-- contract_addendum, cash_receipt, contract_specification, и другие.
-- Большинство keywords с `\b` рядом с кириллицей МОЛЧА не активируются,
-- классификация цепляется за более слабые fallback-паттерны (или вообще
-- провалится на NULL).
--
-- ФИКС: для каждого keyword'а заменяем
--   `\b[CYR]`  →  `(?:^|\W)[CYR]`
--   `[CYR]\b`  →  `[CYR](?:\W|$)`
-- Группа (?:^|\W) матчит начало строки ИЛИ любой не-word char (включая
-- пробел / перенос / любой Unicode-символ кроме `\w`). Работает и для
-- ASCII, и для Cyrillic. Захватывает 1 символ префикса/суффикса —
-- это компромисс ради совместимости, на длину match влияет минимально.
--
-- ASCII keywords (`\bCMR\b`, `\bprice\s+list\b`) — НЕ трогаем, для них
-- \b работает корректно.
--
-- Идемпотентность: regexp_replace стрелит только когда `\b` действительно
-- стоит рядом с кириллицей. Если паттерн уже починен — `\b` рядом нет,
-- ничего не меняется.

-- ─── Bulk update через регулярки ───────────────────────────────────────
DO $$
DECLARE
  rec RECORD;
  patched TEXT[];
  pattern TEXT;
  new_pattern TEXT;
  did_change BOOLEAN;
  total_patches INT := 0;
BEGIN
  FOR rec IN SELECT slug, classification_keywords FROM document_types
  LOOP
    patched := ARRAY[]::TEXT[];
    did_change := FALSE;

    FOREACH pattern IN ARRAY rec.classification_keywords
    LOOP
      -- Сохраняем оригинал для сравнения
      new_pattern := pattern;
      -- 1) \b перед кириллицей  →  (?:^|\W)
      new_pattern := regexp_replace(new_pattern, '\\b([А-Яа-яёЁ])', '(?:^|\W)\1', 'g');
      -- 2) кириллица перед \b  →  (?:\W|$)
      new_pattern := regexp_replace(new_pattern, '([А-Яа-яёЁ])\\b', '\1(?:\W|$)', 'g');

      patched := patched || new_pattern;
      IF new_pattern <> pattern THEN
        did_change := TRUE;
        total_patches := total_patches + 1;
        RAISE NOTICE 'patched %: % => %', rec.slug, pattern, new_pattern;
      END IF;
    END LOOP;

    IF did_change THEN
      UPDATE document_types
      SET classification_keywords = patched
      WHERE slug = rec.slug;
    END IF;
  END LOOP;
  RAISE NOTICE 'Total keyword patterns fixed: %', total_patches;
END
$$;

-- Sanity check: после миграции patterns с `\b` рядом с кириллицей не
-- должно остаться (мог пропустить случай — например \b в середине
-- multi-part-выражения; такие проверим вручную).
DO $$
DECLARE
  leftover_count INT;
BEGIN
  SELECT count(*) INTO leftover_count
  FROM document_types, unnest(classification_keywords) k
  WHERE k ~ '\\b[А-Яа-яёЁ]' OR k ~ '[А-Яа-яёЁ]\\b';
  IF leftover_count > 0 THEN
    RAISE NOTICE 'WARN: % keyword(s) still have Cyrillic \b — проверить вручную', leftover_count;
  ELSE
    RAISE NOTICE 'OK: no Cyrillic \b patterns remain';
  END IF;
END
$$;

-- Down Migration
--
-- Откат проблематичен — не сохраняем оригинал per-pattern. Best-effort:
-- обратная замена `(?:^|\W)` → `\b`. На практике откат маловероятен
-- (это bug-fix, а не feature), и точная реверсия не нужна.
DO $$
DECLARE
  rec RECORD;
  patched TEXT[];
  pattern TEXT;
  new_pattern TEXT;
BEGIN
  FOR rec IN SELECT slug, classification_keywords FROM document_types
  LOOP
    patched := ARRAY[]::TEXT[];
    FOREACH pattern IN ARRAY rec.classification_keywords
    LOOP
      new_pattern := pattern;
      new_pattern := regexp_replace(new_pattern, '\(\?:\^\|\\W\)([А-Яа-яёЁ])', '\\b\1', 'g');
      new_pattern := regexp_replace(new_pattern, '([А-Яа-яёЁ])\(\?:\\W\|\$\)', '\1\\b', 'g');
      patched := patched || new_pattern;
    END LOOP;
    UPDATE document_types SET classification_keywords = patched WHERE slug = rec.slug;
  END LOOP;
END
$$;
