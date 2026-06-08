-- Up Migration
--
-- Fix «только шапка» на длинных документах для 7 типов, у которых строки
-- таблицы описаны под legacy-именем `positions` (или отсутствуют вовсе),
-- а не под каноническим `items`.
--
-- Почему это ломало извлечение позиций:
--   * parser_kind='llm_extract' для документа >15KB OCR-текста авто-уходит
--     в двухпроходный режим (MultiPassLlmParser).
--   * Pass 2 (извлечение строк таблицы) запускается ТОЛЬКО если в схеме есть
--     ключ `items` (multipass-llm.ts:91 — `itemsSchema = properties.items ?`).
--   * У этих типов ключ назывался `positions` → Pass 2 не запускался →
--     на выходе только шапка. Короткие документы (один проход) извлекали
--     positions и подменяли на items на чтении (normalize-extracted.ts),
--     поэтому ломалось «в части документов» (длинные/многостраничные).
--
-- Миграция 0015 (canonical_items_schema) уже приводила 3 из этих типов к
-- items[], но на боевой БД правка не закрепилась (в журнале значится
-- применённой, а строки — в исходном состоянии от 0005). Эта миграция —
-- «последнее слово»: новый timestamp, гарантированно поверх всего.
--
-- Подход хирургический: сохраняем ВСЕ текущие поля шапки (exporter/buyer/
-- payment_terms/total_amount и т.п. — они извлекаются корректно, на них
-- жалоб нет), и только переименовываем `positions` → `items`, заменяя shape
-- строки на канонический ITEM_PROPERTIES (document-json-schemas.ts) +
-- type-specific доп. колонки. parser_kind не трогаем: короткие пойдут одним
-- проходом, длинные авто-уйдут в multipass, где Pass 2 теперь заработает.
--
-- Затронуто 7 типов:
--   commercial_invoice, packing_list, contract_specification,
--   customs_declaration, cash_receipt, bill_of_lading  — positions → items
--   UKD                                                 — добавлен items[]
--                                                          (строки корректировки)
--
-- Backward-compat: старые job'ы в БД (extracted с positions[]) продолжают
-- отображаться — normalize-extracted.ts мапит positions→items на чтении.

BEGIN;

-- ── commercial_invoice — базовый канонический items[19] ─────────────
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      ((llm_schema -> 'properties') - 'positions') || jsonb_build_object('items', '{
        "type": "array",
        "description": "Строки коммерческого инвойса. Если таблицы позиций нет — пустой массив.",
        "items": {"type": "object", "properties": {
          "line_no": {"type": "integer", "description": "Порядковый номер строки"},
          "code": {"type": "string", "description": "Артикул/код товара"},
          "barcode": {"type": "string", "description": "Штрих-код (EAN-13/UPC/GTIN)"},
          "name": {"type": "string", "description": "Наименование товара/услуги"},
          "hs_code": {"type": "string", "description": "Код ТН ВЭД (10 цифр РФ/ЕАЭС, 8 цифр ЕС)"},
          "country_of_origin": {"type": "string", "description": "Страна происхождения, ISO 3166-1 alpha-2"},
          "unit": {"type": "string", "description": "Единица измерения (шт, кг, м, л, упак)"},
          "qty": {"type": "number", "description": "Количество"},
          "qty_per_package": {"type": "number", "description": "Количество единиц в упаковке"},
          "packages": {"type": "number", "description": "Количество упаковок/мест"},
          "weight_net": {"type": "number", "description": "Вес нетто, кг"},
          "weight_gross": {"type": "number", "description": "Вес брутто, кг"},
          "price": {"type": "number", "description": "Цена за единицу без НДС"},
          "vat_rate": {"type": "number", "description": "Ставка НДС строки (0,10,20)"},
          "vat_amount": {"type": "number", "description": "Сумма НДС по строке"},
          "total_without_vat": {"type": "number", "description": "Стоимость без НДС"},
          "total_with_vat": {"type": "number", "description": "Стоимость с НДС"},
          "currency": {"type": "string", "description": "Валюта строки, ISO 4217"},
          "notes": {"type": "string", "description": "Комментарии в строке"}
        }}
      }'::jsonb)
    ),
    expected_fields = ARRAY(
      SELECT DISTINCT CASE WHEN f = 'positions' THEN 'items' ELSE f END
      FROM unnest(expected_fields || ARRAY['items']::text[]) AS f
    )
WHERE slug = 'commercial_invoice';

-- ── packing_list — items + package_type/dimensions/volume ───────────
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      ((llm_schema -> 'properties') - 'positions') || jsonb_build_object('items', '{
        "type": "array",
        "description": "Строки упаковочного листа.",
        "items": {"type": "object", "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string", "description": "Артикул/код товара"},
          "barcode": {"type": "string"},
          "name": {"type": "string", "description": "Наименование товара"},
          "hs_code": {"type": "string", "description": "Код ТН ВЭД"},
          "country_of_origin": {"type": "string", "description": "ISO 3166-1 alpha-2"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number", "description": "Количество мест"},
          "weight_net": {"type": "number", "description": "Вес нетто, кг"},
          "weight_gross": {"type": "number", "description": "Вес брутто, кг"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"},
          "package_type": {"type": "string", "description": "Тип упаковки (коробка, паллета, мешок)"},
          "dimensions": {"type": "string", "description": "Размеры одного места (L×W×H)"},
          "volume": {"type": "number", "description": "Объём одной упаковки, м³"}
        }}
      }'::jsonb)
    ),
    expected_fields = ARRAY(
      SELECT DISTINCT CASE WHEN f = 'positions' THEN 'items' ELSE f END
      FROM unnest(expected_fields || ARRAY['items']::text[]) AS f
    )
WHERE slug = 'packing_list';

-- ── contract_specification — items + delivery_term ──────────────────
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      ((llm_schema -> 'properties') - 'positions') || jsonb_build_object('items', '{
        "type": "array",
        "description": "Спецификация поставки: перечень позиций.",
        "items": {"type": "object", "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string", "description": "Артикул/код товара"},
          "barcode": {"type": "string"},
          "name": {"type": "string", "description": "Наименование товара/услуги"},
          "hs_code": {"type": "string", "description": "Код ТН ВЭД"},
          "country_of_origin": {"type": "string", "description": "ISO 3166-1 alpha-2"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number"},
          "weight_gross": {"type": "number"},
          "price": {"type": "number", "description": "Цена за единицу без НДС"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"},
          "delivery_term": {"type": "string", "description": "Срок поставки по этой позиции"}
        }}
      }'::jsonb)
    ),
    expected_fields = ARRAY(
      SELECT DISTINCT CASE WHEN f = 'positions' THEN 'items' ELSE f END
      FROM unnest(expected_fields || ARRAY['items']::text[]) AS f
    )
WHERE slug = 'contract_specification';

-- ── customs_declaration — items + invoice/customs/statistical_value ──
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      ((llm_schema -> 'properties') - 'positions') || jsonb_build_object('items', '{
        "type": "array",
        "description": "Товарные позиции декларации (Графа 31 и далее).",
        "items": {"type": "object", "properties": {
          "line_no": {"type": "integer", "description": "Номер товара (Графа 32)"},
          "code": {"type": "string"},
          "barcode": {"type": "string"},
          "name": {"type": "string", "description": "Описание товара (Графа 31)"},
          "hs_code": {"type": "string", "description": "Код ТН ВЭД (Графа 33), 10 цифр"},
          "country_of_origin": {"type": "string", "description": "Страна происхождения (Графа 34)"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number", "description": "Вес нетто (Графа 38)"},
          "weight_gross": {"type": "number", "description": "Вес брутто (Графа 35)"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"},
          "invoice_value": {"type": "number", "description": "Стоимость по инвойсу (Графа 42)"},
          "customs_value": {"type": "number", "description": "Таможенная стоимость (Графа 45)"},
          "statistical_value": {"type": "number", "description": "Статистическая стоимость (Графа 46)"}
        }}
      }'::jsonb)
    ),
    expected_fields = ARRAY(
      SELECT DISTINCT CASE WHEN f = 'positions' THEN 'items' ELSE f END
      FROM unnest(expected_fields || ARRAY['items']::text[]) AS f
    )
WHERE slug = 'customs_declaration';

-- ── cash_receipt — базовый канонический items ───────────────────────
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      ((llm_schema -> 'properties') - 'positions') || jsonb_build_object('items', '{
        "type": "array",
        "description": "Позиции чека.",
        "items": {"type": "object", "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string"},
          "barcode": {"type": "string"},
          "name": {"type": "string", "description": "Наименование товара/услуги"},
          "hs_code": {"type": "string"},
          "country_of_origin": {"type": "string"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number"},
          "weight_gross": {"type": "number"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"}
        }}
      }'::jsonb)
    ),
    expected_fields = ARRAY(
      SELECT DISTINCT CASE WHEN f = 'positions' THEN 'items' ELSE f END
      FROM unnest(expected_fields || ARRAY['items']::text[]) AS f
    )
WHERE slug = 'cash_receipt';

-- ── bill_of_lading — items + marks_and_numbers/container_number ─────
UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      ((llm_schema -> 'properties') - 'positions') || jsonb_build_object('items', '{
        "type": "array",
        "description": "Грузовые места / лоты по коносаменту.",
        "items": {"type": "object", "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string"},
          "barcode": {"type": "string"},
          "name": {"type": "string", "description": "Описание груза"},
          "hs_code": {"type": "string"},
          "country_of_origin": {"type": "string"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number"},
          "weight_gross": {"type": "number"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"},
          "marks_and_numbers": {"type": "string", "description": "Маркировка и номера (стандартная графа B/L)"},
          "container_number": {"type": "string", "description": "Номер контейнера (ISO 6346)"}
        }}
      }'::jsonb)
    ),
    expected_fields = ARRAY(
      SELECT DISTINCT CASE WHEN f = 'positions' THEN 'items' ELSE f END
      FROM unnest(expected_fields || ARRAY['items']::text[]) AS f
    )
WHERE slug = 'bill_of_lading';

-- ── UKD — добавляем items[] (строки корректировки ДО/ПОСЛЕ) ─────────
UPDATE document_types
SET llm_schema = jsonb_set(llm_schema, '{properties,items}', '{
        "type": "array",
        "description": "Строки корректировки. Каждая — позиция исходного документа с показателями ДО и ПОСЛЕ.",
        "items": {"type": "object", "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string", "description": "Артикул/код товара"},
          "name": {"type": "string", "description": "Наименование товара/услуги"},
          "unit": {"type": "string"},
          "qty_before": {"type": "number", "description": "Количество ДО корректировки"},
          "qty_after": {"type": "number", "description": "Количество ПОСЛЕ корректировки"},
          "price_before": {"type": "number", "description": "Цена за единицу ДО"},
          "price_after": {"type": "number", "description": "Цена за единицу ПОСЛЕ"},
          "vat_rate": {"type": "number", "description": "Ставка НДС строки (0,10,20)"},
          "vat_before": {"type": "number", "description": "Сумма НДС строки ДО"},
          "vat_after": {"type": "number", "description": "Сумма НДС строки ПОСЛЕ"},
          "total_before": {"type": "number", "description": "Стоимость с НДС ДО"},
          "total_after": {"type": "number", "description": "Стоимость с НДС ПОСЛЕ"}
        }}
      }'::jsonb),
    expected_fields = ARRAY(
      SELECT DISTINCT f FROM unnest(expected_fields || ARRAY['items']::text[]) AS f
    ),
    llm_prompt = llm_prompt || E'\n- items[] — построчная корректировка: для каждой позиции line_no, name, code, unit, qty_before/qty_after, price_before/price_after, vat_rate, vat_before/vat_after, total_before/total_after (стоимость с НДС ДО и ПОСЛЕ). Если в УКД нет построчной таблицы — пустой массив.'
WHERE slug = 'UKD';

-- Sanity check — все 7 типов теперь имеют items[] в схеме
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM document_types
     WHERE slug IN ('commercial_invoice','packing_list','contract_specification',
                    'customs_declaration','cash_receipt','bill_of_lading','UKD')
       AND (llm_schema -> 'properties' ? 'items');
    IF n <> 7 THEN
        RAISE EXCEPTION 'Expected 7 types with items[] in schema, got %', n;
    END IF;
END $$;

COMMIT;

-- Down Migration
--
-- Best-effort откат: возвращаем legacy-имя массива `positions` для 6 типов
-- (shape остаётся канонический — точный исходный positions-shape из 0005 не
-- восстанавливаем). Для UKD — удаляем items[] полностью. llm_prompt UKD не
-- откатываем (не критично).

BEGIN;

UPDATE document_types
SET llm_schema = jsonb_set(
      llm_schema, '{properties}',
      ((llm_schema -> 'properties') - 'items')
        || jsonb_build_object('positions', llm_schema -> 'properties' -> 'items')
    ),
    expected_fields = ARRAY(
      SELECT DISTINCT CASE WHEN f = 'items' THEN 'positions' ELSE f END
      FROM unnest(expected_fields) AS f
    )
WHERE slug IN ('commercial_invoice','packing_list','contract_specification',
               'customs_declaration','cash_receipt','bill_of_lading');

UPDATE document_types
SET llm_schema = llm_schema #- '{properties,items}',
    expected_fields = ARRAY(SELECT f FROM unnest(expected_fields) AS f WHERE f <> 'items')
WHERE slug = 'UKD';

COMMIT;
