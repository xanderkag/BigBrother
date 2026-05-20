-- Phase F — 4 новых глобальных типа документов (складские + договорные).
--
-- Добавляем:
--   power_of_attorney    — Доверенность (М-2 / М-2а)
--   warehouse_receipt    — Акт о приёме-передаче ТМЦ на хранение (МХ-1)
--   warehouse_return     — Акт о возврате ТМЦ с хранения (МХ-3)
--   material_requisition — Требование-накладная (М-11)
--
-- Все четыре — `parser_kind='llm_extract'`, обслуживаются GenericLlmParser
-- (схема + expected_fields из этой записи). Кастомные TS-парсеры не пишем.
--
-- tier='experimental' — типы только заведены, нет accumulated данных и
-- замера на golden-set'е. organization_id NULL — глобальные/shared
-- (видны всем тенантам). is_builtin=false — админ может деактивировать.
--
-- Путевой лист (4-С / 4-П) сознательно НЕ добавляем — существующий тип
-- `waybill` уже покрывает путевой лист.
--
-- classification_keywords хранятся как plain-литералы: классификатор
-- компилирует каждый через `new RegExp(raw, 'i')` и матчит подстрокой
-- (без \b — кириллический \b в JS-regex не работает, см. keywords.ts).
-- Дефисные коды (м-2, мх-1, м-11) — литералы regex'а, спецсимволов нет.

BEGIN;

INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords,
    llm_prompt, llm_schema
) VALUES

-- ── power_of_attorney (Доверенность М-2 / М-2а) ────────────────────
(
    'power_of_attorney',
    'Доверенность (М-2/М-2а)',
    'Доверенность на получение ТМЦ (формы М-2 / М-2а). Доверитель уполномочивает представителя получать товарно-материальные ценности у поставщика. Срок действия ограничен.',
    false, true, 'llm_extract', 'experimental', NULL,
    ARRAY['number','date','principal','representative','valid_until','authority']::text[],
    ARRAY['date_range']::text[],
    ARRAY[
        'доверенность',
        'м-2',
        'доверяю',
        'уполномочивает',
        'представлять интересы'
    ]::text[],
    NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер доверенности"},
        "date": {"type": "string", "format": "date", "description": "Дата выдачи"},
        "valid_until": {"type": "string", "format": "date", "description": "Срок действия (до какой даты)"},
        "principal": {"type": "object", "description": "Доверитель (организация)", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}}},
        "representative": {"type": "object", "description": "Представитель (физлицо)", "properties": {"fio": {"type": "string"}, "position": {"type": "string"}, "passport": {"type": "string"}}},
        "supplier": {"type": "object", "description": "Поставщик, у которого получают ТМЦ", "properties": {"name": {"type": "string"}}},
        "basis": {"type": "string", "description": "Документ-основание (счёт/договор), по которому получают ТМЦ"},
        "authority": {"type": "string", "description": "Что доверено: получить такие-то ТМЦ"},
        "positions": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "qty": {"type": "number"}, "unit": {"type": "string"}}}}
      }
    }'::jsonb
),

-- ── warehouse_receipt (Акт приёма-передачи на хранение, МХ-1) ───────
(
    'warehouse_receipt',
    'Акт о приёме-передаче ТМЦ на хранение (МХ-1)',
    'Акт по форме МХ-1: поклажедатель передаёт товарно-материальные ценности хранителю на ответственное хранение. Перечень позиций, общая стоимость.',
    false, true, 'llm_extract', 'experimental', NULL,
    ARRAY['number','date','depositor','custodian','positions','total']::text[],
    ARRAY['date_range']::text[],
    ARRAY[
        'мх-1',
        'акт о приёме-передаче',
        'на хранение',
        'поклажедатель',
        'хранитель'
    ]::text[],
    NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "format": "date"},
        "depositor": {"type": "object", "description": "Поклажедатель", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}}},
        "custodian": {"type": "object", "description": "Хранитель", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}}},
        "storage_place": {"type": "string", "description": "Место хранения / склад"},
        "storage_term": {"type": "string", "description": "Срок хранения"},
        "positions": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "code": {"type": "string"}, "qty": {"type": "number"}, "unit": {"type": "string"}, "price": {"type": "number"}, "total": {"type": "number"}}}},
        "total": {"type": "number", "description": "Общая стоимость переданных ТМЦ"}
      }
    }'::jsonb
),

-- ── warehouse_return (Акт о возврате с хранения, МХ-3) ──────────────
(
    'warehouse_return',
    'Акт о возврате ТМЦ с хранения (МХ-3)',
    'Акт по форме МХ-3: хранитель возвращает поклажедателю ранее принятые на хранение ТМЦ. Перечень возвращаемых позиций.',
    false, true, 'llm_extract', 'experimental', NULL,
    ARRAY['number','date','depositor','custodian','positions']::text[],
    ARRAY['date_range']::text[],
    ARRAY[
        'мх-3',
        'акт о возврате',
        'с хранения',
        'возврат тмц'
    ]::text[],
    NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "format": "date"},
        "depositor": {"type": "object", "description": "Поклажедатель", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}}},
        "custodian": {"type": "object", "description": "Хранитель", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}}},
        "base_doc_number": {"type": "string", "description": "Номер исходного акта МХ-1, по которому возвращают"},
        "base_doc_date": {"type": "string", "format": "date"},
        "positions": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "code": {"type": "string"}, "qty": {"type": "number"}, "unit": {"type": "string"}, "price": {"type": "number"}, "total": {"type": "number"}}}},
        "total": {"type": "number"}
      }
    }'::jsonb
),

-- ── material_requisition (Требование-накладная, М-11) ───────────────
(
    'material_requisition',
    'Требование-накладная (М-11)',
    'Требование-накладная по форме М-11: внутренний отпуск материалов со склада подразделению (отправитель → получатель). Перечень материалов.',
    false, true, 'llm_extract', 'experimental', NULL,
    ARRAY['number','date','sender','receiver','positions','warehouse']::text[],
    ARRAY['date_range']::text[],
    ARRAY[
        'м-11',
        'требование-накладная',
        'требование',
        'отпуск материалов'
    ]::text[],
    NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "format": "date"},
        "organization_name": {"type": "string"},
        "warehouse": {"type": "string", "description": "Склад / структурное подразделение-отправитель"},
        "sender": {"type": "object", "description": "Отправитель (подразделение/МОЛ)", "properties": {"name": {"type": "string"}, "responsible_fio": {"type": "string"}}},
        "receiver": {"type": "object", "description": "Получатель (подразделение/МОЛ)", "properties": {"name": {"type": "string"}, "responsible_fio": {"type": "string"}}},
        "basis": {"type": "string", "description": "Основание отпуска"},
        "positions": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "code": {"type": "string"}, "qty": {"type": "number"}, "unit": {"type": "string"}, "price": {"type": "number"}, "total": {"type": "number"}}}}
      }
    }'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- Sanity check
DO $$
DECLARE added int;
BEGIN
    SELECT count(*) INTO added FROM document_types
    WHERE slug IN ('power_of_attorney', 'warehouse_receipt', 'warehouse_return', 'material_requisition');
    IF added <> 4 THEN
        RAISE EXCEPTION 'Expected 4 new Phase F types, got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug IN (
    'power_of_attorney',
    'warehouse_receipt',
    'warehouse_return',
    'material_requisition'
);
COMMIT;
