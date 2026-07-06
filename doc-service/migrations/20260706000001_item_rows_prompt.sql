-- Up Migration
--
-- B (недобор позиций, 2026-07-06): на богатых упаковочных/инвойсных экселях
-- модель ужимала товарные строки (PI2025: 11 строк в листе PACKING → 1 позиция).
-- Диагноз: у `packing_list` llm_prompt = NULL (нет инструкции «все строки»),
-- у commercial_invoice/proforma_invoice/price_list её тоже нет. У `invoice`,
-- где инструкция есть, позиции берутся полно — прямая корреляция.
--
-- Фикс: дописать явную инструкцию «извлеки КАЖДУЮ товарную строку отдельным
-- объектом в items[], не суммируй, собери со всех листов/таблиц». Append-only,
-- с guard'ом NOT LIKE (идемпотентно). Forward-only.

BEGIN;

-- packing_list: промпт был NULL — задаём.
UPDATE document_types
   SET llm_prompt = COALESCE(llm_prompt, '') ||
     ' По позициям КРИТИЧНО: извлеки КАЖДУЮ товарную строку упаковочного листа отдельным объектом в items[] — НЕ суммируй, НЕ пропускай и НЕ сокращай строки, верни все до последней. Если в документе несколько таблиц или листов с позициями — собери строки из ВСЕХ. Заголовки, подытоги, итоговые и пустые строки в items НЕ включай.'
 WHERE slug = 'packing_list'
   AND (llm_prompt IS NULL OR llm_prompt NOT LIKE '%КАЖДУЮ товарную строку упаковочного%');

-- invoice-семейство + прайс: усилить «все позиции».
UPDATE document_types
   SET llm_prompt = COALESCE(llm_prompt, '') ||
     ' По позициям КРИТИЧНО: извлеки КАЖДУЮ строку товарной таблицы отдельным объектом в items[] — НЕ суммируй и НЕ пропускай строки, верни все до последней. Если позиции разбиты на несколько таблиц/листов — собери из всех.'
 WHERE slug IN ('commercial_invoice', 'proforma_invoice', 'price_list')
   AND (llm_prompt IS NULL OR llm_prompt NOT LIKE '%КАЖДУЮ строку товарной таблицы%');

DO $$
DECLARE p text;
BEGIN
  SELECT llm_prompt INTO p FROM document_types WHERE slug = 'packing_list';
  IF p IS NULL OR p NOT LIKE '%КАЖДУЮ товарную строку упаковочного%' THEN
    RAISE EXCEPTION 'packing_list item-rows prompt not applied';
  END IF;
  IF (SELECT llm_prompt FROM document_types WHERE slug = 'commercial_invoice') NOT LIKE '%КАЖДУЮ строку товарной таблицы%' THEN
    RAISE EXCEPTION 'commercial_invoice item-rows prompt not applied';
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_prompt = replace(llm_prompt,
     ' По позициям КРИТИЧНО: извлеки КАЖДУЮ товарную строку упаковочного листа отдельным объектом в items[] — НЕ суммируй, НЕ пропускай и НЕ сокращай строки, верни все до последней. Если в документе несколько таблиц или листов с позициями — собери строки из ВСЕХ. Заголовки, подытоги, итоговые и пустые строки в items НЕ включай.', '')
 WHERE slug = 'packing_list';
UPDATE document_types
   SET llm_prompt = replace(llm_prompt,
     ' По позициям КРИТИЧНО: извлеки КАЖДУЮ строку товарной таблицы отдельным объектом в items[] — НЕ суммируй и НЕ пропускай строки, верни все до последней. Если позиции разбиты на несколько таблиц/листов — собери из всех.', '')
 WHERE slug IN ('commercial_invoice', 'proforma_invoice', 'price_list');
COMMIT;
