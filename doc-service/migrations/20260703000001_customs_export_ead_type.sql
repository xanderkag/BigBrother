-- Up Migration
--
-- VANGA-VED-1 §3.4: новый тип `customs_export_ead` — экспортная декларация
-- ЕС (Export Accompanying Document / Ausfuhrbegleitdokument, ЭСД/EAD).
--
-- ЗАЧЕМ ОТДЕЛЬНЫЙ ТИП, а не расширение `export_declaration`:
-- наш `export_declaration` — русская ГТД/ДТ (графы 1-54, declaration_number
-- формата XXXXXXXX/DDMMYY/XXXXXXX, duties[], русская таможенная структура).
-- EU-EAD — структурно другой документ: ключ `mrn` (23HR030228018557B5),
-- `office_of_exit` (LTVK2000), `statistical_value` по позициям, консигнор/
-- декларант с EU-VAT (не ИНН). Смешивать в один тип = грязный union и
-- ложные классификации. GROUNDED: реальный комплект №2 Milka (Загреб HR).
--
-- parser_kind='llm_extract', tier='beta' (предварительная схема на реальных
-- данных, golden-set обкатки нет), organization_id NULL (глобальный),
-- is_builtin=false. GenericLlmParser обслуживает по llm_schema. Живой
-- LLM-классификатор авто-подхватывает из document_types.
--
-- classification_keywords — TITLE-ANCHORED. Латиница через \b осознанно;
-- MRN-маска (2 цифры + 2 буквы страны + 14 буквоцифр) — сильный якорь.
-- Forward-only, аддитивная миграция.

BEGIN;

INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'customs_export_ead',
    'Экспортная декларация ЕС (EAD / ЭСД)',
    'Export Accompanying Document (Ausfuhrbegleitdokument, ЭСД/EAD) — экспортная декларация страны ЕС: MRN, таможенный офис и офис выезда, консигнор/консигнат/декларант, страны отправления и назначения, идентификация транспорта, брутто-масса, позиции с ТН ВЭД, таможенной и статистической стоимостью.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['mrn','issue_date','consignor','consignee','country_dispatch','country_destination','gross_mass','items']::text[],
    ARRAY['date_range','money_sanity']::text[],
    ARRAY[
      '\bexport accompanying document\b',
      '\bausfuhrbegleitdokument\b',
      'экспортн[а-я]+\s+деклараци[яи]\s+ес',
      '\boffice of exit\b',
      '\bMRN\b',
      '\b\d{2}[A-Z]{2}[A-Z0-9]{14}\b'
    ]::text[],
    -- вес русского «экспортная декларация ЕС» = 7.0: строго выше generic
    -- 'экспортн[а-я]+ деклараци' (6.0) у export_declaration/ГТД, иначе
    -- EU-EAD на русском/двуязычный уходит в русскую ГТД (review VANGA-VED-1).
    ARRAY[6.0, 6.0, 7.0, 4.0, 3.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "mrn": {"type": "string", "description": "Movement Reference Number (например 23HR030228018557B5). Строка — ведущие символы значимы."},
        "issue_date": {"type": "string", "description": "Дата оформления YYYY-MM-DD"},
        "customs_office": {"type": "string", "description": "Таможенный офис оформления (например HR030228)"},
        "office_of_exit": {"type": "string", "description": "Офис/пункт выезда из ЕС (например LTVK2000)"},
        "reference_number": {"type": "string", "description": "Внутренний референс декларации (LRN/aes-…)"},
        "consignor": {
          "type": "object", "description": "Отправитель/консигнор (с EU-VAT если указан)",
          "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "vat_id": {"type": "string"}, "country": {"type": "string", "description": "ISO 3166 alpha-2"}}
        },
        "consignee": {
          "type": "object", "description": "Получатель/консигнат",
          "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}
        },
        "declarant": {
          "type": "object", "description": "Декларант / представитель",
          "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "vat_id": {"type": "string"}}
        },
        "country_dispatch": {"type": "string", "description": "Страна отправления, ISO 3166 alpha-2"},
        "country_destination": {"type": "string", "description": "Страна назначения, ISO 3166 alpha-2"},
        "transport_identity": {
          "type": "object", "description": "Идентификация транспорта на выезде",
          "properties": {"truck_plate": {"type": "string"}, "trailer_plate": {"type": "string"}}
        },
        "gross_mass": {"type": "number", "description": "Общая масса брутто, кг"},
        "total_packages": {"type": "integer", "description": "Общее число мест"},
        "currency": {"type": "string", "description": "Валюта стоимостей, ISO 4217"},
        "items": {
          "type": "array",
          "description": "Товарные позиции декларации",
          "items": {
            "type": "object",
            "properties": {
              "item_no": {"type": "integer", "description": "Номер позиции"},
              "description": {"type": "string", "description": "Наименование товара"},
              "hs_code": {"type": "string", "description": "Код ТН ВЭД (8 ЕС / 10 знаков), строкой без пробелов"},
              "customs_value": {"type": "number", "description": "Таможенная стоимость позиции"},
              "statistical_value": {"type": "number", "description": "Статистическая стоимость позиции"},
              "net_mass": {"type": "number", "description": "Масса нетто, кг"},
              "gross_mass": {"type": "number", "description": "Масса брутто, кг"},
              "packages": {"type": "integer", "description": "Число мест по позиции"}
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
    SELECT count(*) INTO added FROM document_types WHERE slug = 'customs_export_ead';
    IF added <> 1 THEN
        RAISE EXCEPTION 'Expected customs_export_ead type inserted, got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug = 'customs_export_ead';
COMMIT;
