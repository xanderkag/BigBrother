-- Up Migration
--
-- Расширение списка типов (PARSING_SPEC.md Раздел E, §3.27–3.30): складские /
-- внутренние учётные документы. Все — experimental, parser_kind=llm_extract,
-- validators=date_range, глобальные (organization_id IS NULL), классификация по
-- литералам. LLM-промпт не задаём — generic-extract по llm_schema.
--
--   3.27 power_of_attorney   — Доверенность (М-2 / М-2а)
--   3.28 warehouse_receipt   — Приём-передача ТМЦ на хранение (МХ-1)
--   3.29 warehouse_return    — Возврат ТМЦ с хранения (МХ-3)
--   3.30 material_requisition — Требование-накладная (М-11)
--
-- tier по умолчанию 'experimental', organization_id NULL (глобальный) —
-- defaults колонок, явно не указываем.

BEGIN;

-- ── 3.27 power_of_attorney — Доверенность (М-2 / М-2а) ──────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'power_of_attorney',
    'Доверенность (М-2 / М-2а)',
    'Доверенность на получение ТМЦ / представление интересов (формы М-2, М-2а).',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','principal','representative','valid_until','authority']::text[],
    ARRAY['доверенность','м-2','доверяю','уполномочивает','представлять интересы']::text[],
    ARRAY[6.0, 5.0, 3.0, 3.0, 3.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "description": "Дата выдачи YYYY-MM-DD"},
        "valid_until": {"type": "string", "description": "Действительна до YYYY-MM-DD"},
        "principal": {
          "type": "object", "description": "Доверитель (кто выдал)",
          "properties": {
            "name": {"type": "string"}, "inn": {"type": "string"},
            "kpp": {"type": "string"}, "address": {"type": "string"}
          }
        },
        "representative": {
          "type": "object", "description": "Доверенное лицо (на кого выдана)",
          "properties": {
            "fio": {"type": "string"}, "position": {"type": "string"},
            "passport": {"type": "string"}
          }
        },
        "supplier": {"type": "object", "properties": {"name": {"type": "string"}}, "description": "Поставщик/от кого получают ТМЦ"},
        "basis": {"type": "string", "description": "Основание (счёт/договор)"},
        "authority": {"type": "string", "description": "Полномочия / что доверяется"},
        "positions": {
          "type": "array",
          "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "qty": {"type": "number"}, "unit": {"type": "string"}
          }}
        }
      }
    }'::jsonb
);

-- ── 3.28 warehouse_receipt — Приём-передача ТМЦ на хранение (МХ-1) ──
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'warehouse_receipt',
    'Приём-передача ТМЦ на хранение (МХ-1)',
    'Акт о приёме-передаче товарно-материальных ценностей на хранение (форма МХ-1).',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','depositor','custodian','positions','total']::text[],
    ARRAY['мх-1','акт о приёме-передаче','на хранение','поклажедатель','хранитель']::text[],
    ARRAY[6.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "depositor": {
          "type": "object", "description": "Поклажедатель (сдаёт на хранение)",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}}
        },
        "custodian": {
          "type": "object", "description": "Хранитель (принимает на хранение)",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}}
        },
        "storage_place": {"type": "string", "description": "Место хранения"},
        "storage_term": {"type": "string", "description": "Срок хранения"},
        "positions": {
          "type": "array",
          "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "code": {"type": "string"}, "qty": {"type": "number"},
            "unit": {"type": "string"}, "price": {"type": "number"}, "total": {"type": "number"}
          }}
        },
        "total": {"type": "number"}
      }
    }'::jsonb
);

-- ── 3.29 warehouse_return — Возврат ТМЦ с хранения (МХ-3) ───────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'warehouse_return',
    'Возврат ТМЦ с хранения (МХ-3)',
    'Акт о возврате товарно-материальных ценностей, сданных на хранение (форма МХ-3).',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','depositor','custodian','positions']::text[],
    ARRAY['мх-3','акт о возврате','с хранения','возврат тмц']::text[],
    ARRAY[6.0, 5.0, 4.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "depositor": {
          "type": "object", "description": "Поклажедатель (кому возвращают)",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}}
        },
        "custodian": {
          "type": "object", "description": "Хранитель (кто возвращает)",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}}
        },
        "base_doc_number": {"type": "string", "description": "Номер исходного МХ-1"},
        "base_doc_date": {"type": "string", "description": "Дата исходного МХ-1"},
        "positions": {
          "type": "array",
          "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "code": {"type": "string"}, "qty": {"type": "number"},
            "unit": {"type": "string"}, "price": {"type": "number"}, "total": {"type": "number"}
          }}
        },
        "total": {"type": "number"}
      }
    }'::jsonb
);

-- ── 3.30 material_requisition — Требование-накладная (М-11) ─────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'material_requisition',
    'Требование-накладная (М-11)',
    'Требование-накладная на отпуск/перемещение материалов внутри организации (форма М-11).',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','sender','receiver','positions','warehouse']::text[],
    ARRAY['м-11','требование-накладная','требование','отпуск материалов']::text[],
    ARRAY[6.0, 6.0, 3.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "organization_name": {"type": "string"},
        "warehouse": {"type": "string", "description": "Склад-отправитель"},
        "sender": {
          "type": "object", "description": "Отправитель (структурное подразделение)",
          "properties": {"name": {"type": "string"}, "responsible_fio": {"type": "string"}}
        },
        "receiver": {
          "type": "object", "description": "Получатель (структурное подразделение)",
          "properties": {"name": {"type": "string"}, "responsible_fio": {"type": "string"}}
        },
        "basis": {"type": "string"},
        "positions": {
          "type": "array",
          "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "code": {"type": "string"}, "qty": {"type": "number"},
            "unit": {"type": "string"}, "price": {"type": "number"}, "total": {"type": "number"}
          }}
        }
      }
    }'::jsonb
);

-- Sanity check
DO $$
DECLARE added int;
BEGIN
    SELECT count(*) INTO added FROM document_types
    WHERE slug IN ('power_of_attorney','warehouse_receipt','warehouse_return','material_requisition');
    IF added <> 4 THEN
        RAISE EXCEPTION 'Expected 4 new warehouse/internal types, got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug IN ('power_of_attorney','warehouse_receipt','warehouse_return','material_requisition');
COMMIT;
