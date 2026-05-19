-- Up Migration
--
-- Новые типы из реального ЭДО-кейса 2026-05-18:
--
-- 1. UKD (Универсальный Корректировочный Документ) — аналог УПД, но для
--    корректировок (изменение цены/количества по уже выставленному УПД).
--    Статусы: 1 = с НДС (полный, как УПД-1), 2 = без НДС (упрощённый).
--    Формат заголовка: «УКД (статус 1) № 9 от 28 апреля 2026 г.»
--
-- 2. transfer_note (Перемещение товаров) — внутренние перемещения между
--    складами организации (часто ТОРГ-13 или аналог). Не для внешнего
--    оборота, для учётной системы. Real-case: «Перемещение товаров
--    (Белгородэнергосбыт) № 1127 от 14 мая 2026 г.»

BEGIN;

-- ── UKD (Универсальный Корректировочный Документ) ──────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_prompt, llm_schema
) VALUES (
    'UKD',
    'Корректировочный УПД (УКД)',
    'Универсальный корректировочный документ. Исправление выставленного УПД (изменение цены, количества, возврат). Статусы: 1 — с НДС (как УПД-1), 2 — без НДС.',
    false, true, 'llm_extract',
    ARRAY['number','date','status','base_doc_number','base_doc_date','seller_name','seller_inn','buyer_name','buyer_inn','currency','total_before','total_after','vat_before','vat_after']::text[],
    ARRAY[
        '\bУКД\b',
        'корректировочн[а-я]+\s+(?:счет|документ)',
        'универсальн[а-я]+\s+корректировочн[а-я]+',
        'к\s+(?:счет|счёт)-фактур[еу]\s+№?\s*\d+',
        '(?:увеличение|уменьшение)\s+стоимости'
    ]::text[],
    ARRAY[6.0, 5.0, 5.0, 4.0, 3.0]::numeric(4,2)[],
    'Извлеки из универсального корректировочного документа (УКД):
- number — номер УКД
- date — дата (YYYY-MM-DD)
- status — 1 (с НДС) или 2 (без НДС)
- base_doc_number — номер исходного документа (УПД/счёт-фактуры) который корректируется
- base_doc_date — дата исходного документа
- seller_name / seller_inn — продавец (10 или 12 цифр)
- buyer_name / buyer_inn — покупатель
- currency — ISO 4217 (обычно RUB)
- total_before / total_after — суммы ДО и ПОСЛЕ корректировки
- vat_before / vat_after — НДС ДО и ПОСЛЕ
- correction_kind — "увеличение" / "уменьшение" / null

Если поле не указано — null, не выдумывай. ИНН ровно 10 или 12 цифр.',
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "status": {"type": "integer", "description": "1 — с НДС, 2 — без НДС"},
        "base_doc_number": {"type": "string"},
        "base_doc_date": {"type": "string"},
        "seller_name": {"type": "string"},
        "seller_inn": {"type": "string"},
        "buyer_name": {"type": "string"},
        "buyer_inn": {"type": "string"},
        "currency": {"type": "string"},
        "total_before": {"type": "number"},
        "total_after": {"type": "number"},
        "vat_before": {"type": "number"},
        "vat_after": {"type": "number"},
        "correction_kind": {"type": "string"}
      }
    }'::jsonb
);

-- ── transfer_note (Перемещение товаров, внутреннее) ────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_prompt, llm_schema
) VALUES (
    'transfer_note',
    'Перемещение товаров (ТОРГ-13)',
    'Внутренний документ перемещения товаров между складами организации. Аналог ТОРГ-13 формы. Не для внешнего оборота, для учётной системы (1С/SAP).',
    false, true, 'llm_extract',
    ARRAY['number','date','organization_name','organization_inn','source_warehouse','target_warehouse','responsible_fio','items']::text[],
    ARRAY[
        'перемещение\s+товаров',
        '\bТОРГ-?13\b',
        'отправитель.{0,40}получатель.{0,200}склад',
        '(?:склад|места?\s+хранения).{0,80}(?:откуда|куда|источник|назначение)'
    ]::text[],
    ARRAY[6.0, 5.0, 3.0, 3.0]::numeric(4,2)[],
    'Извлеки из накладной на перемещение товаров (внутреннее перемещение между складами):
- number — номер документа
- date — дата (YYYY-MM-DD)
- organization_name — наименование организации
- organization_inn — ИНН организации
- source_warehouse — склад-отправитель
- target_warehouse — склад-получатель
- responsible_fio — ответственное лицо (если указан)
- items — массив товаров: {name, code, qty, unit, price, total}

Если поле не указано — null.',
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "organization_name": {"type": "string"},
        "organization_inn": {"type": "string"},
        "source_warehouse": {"type": "string"},
        "target_warehouse": {"type": "string"},
        "responsible_fio": {"type": "string"},
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string"},
              "code": {"type": "string"},
              "qty": {"type": "number"},
              "unit": {"type": "string"},
              "price": {"type": "number"},
              "total": {"type": "number"}
            }
          }
        }
      }
    }'::jsonb
);

-- Sanity check
DO $$
DECLARE added int;
BEGIN
    SELECT count(*) INTO added FROM document_types
    WHERE slug IN ('UKD', 'transfer_note');
    IF added <> 2 THEN
        RAISE EXCEPTION 'Expected 2 new types (UKD, transfer_note), got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug IN ('UKD', 'transfer_note');
COMMIT;
