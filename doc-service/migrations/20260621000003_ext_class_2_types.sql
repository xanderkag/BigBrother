-- Up Migration
--
-- EXT-CLASS-2 (SLAI classifier roadmap, P1): ВЭД-типы.
--   awb                       — авианакладная (Air Waybill, IATA)
--   manifest                  — грузовой манифест (cargo manifest)
--   phytosanitary_certificate — фитосанитарный сертификат
--   veterinary_certificate    — ветеринарный сертификат
-- Все: parser_kind=llm_extract, validators=date_range, глобальные, tier=experimental.
-- Тюнинг commercial_invoice под ВЭД (incoterms/hs_code/...) — отдельно, на ревью.

BEGIN;

-- ── awb — Авианакладная (Air Waybill) ──────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'awb',
    'Авианакладная (Air Waybill)',
    'Авиагрузовая накладная IATA (Air Waybill). 11-значный номер, авиакомпания, аэропорты, рейс, вес, сборы.',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['awb_number','date','airline','shipper','consignee','airport_of_departure','airport_of_destination','gross_weight_kg']::text[],
    ARRAY['air\s*waybill','\bawb\b','авианакладн','авиагрузов','авиаперевозк']::text[],
    ARRAY[6.0, 6.0, 5.0, 4.0, 3.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "awb_number": {"type": "string", "description": "Номер AWB (11 цифр IATA)"},
        "date": {"type": "string", "description": "Дата YYYY-MM-DD"},
        "airline": {"type": "string", "description": "Авиакомпания-перевозчик"},
        "shipper": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}}},
        "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}}},
        "airport_of_departure": {"type": "string", "description": "Аэропорт отправления (код/город)"},
        "airport_of_destination": {"type": "string", "description": "Аэропорт назначения"},
        "flight_no": {"type": "string"},
        "flight_date": {"type": "string"},
        "pieces": {"type": "number", "description": "Количество мест"},
        "gross_weight_kg": {"type": "number"},
        "chargeable_weight_kg": {"type": "number"},
        "nature_of_goods": {"type": "string", "description": "Описание груза"},
        "charges": {"type": "object", "properties": {"amount": {"type": "number"}, "currency": {"type": "string"}}}
      }
    }'::jsonb
);

-- ── manifest — Грузовой манифест ───────────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'manifest',
    'Грузовой манифест (cargo manifest)',
    'Грузовой манифест рейса/судна: список грузов по коносаментам/AWB.',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','carrier','items']::text[],
    ARRAY['cargo\s*manifest','грузов[а-я]+\s+манифест','\bманифест\b','\bmanifest\b']::text[],
    ARRAY[6.0, 6.0, 5.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "carrier": {"type": "object", "description": "Перевозчик / линия", "properties": {"name": {"type": "string"}}},
        "vessel_or_flight": {"type": "object", "properties": {"name": {"type": "string"}, "voyage_or_flight_no": {"type": "string"}}},
        "port_of_loading": {"type": "string"},
        "port_of_discharge": {"type": "string"},
        "items": {
          "type": "array",
          "items": {"type": "object", "properties": {
            "bl_or_awb_no": {"type": "string"}, "container_no": {"type": "string"},
            "description": {"type": "string"}, "packages": {"type": "number"},
            "weight_kg": {"type": "number"}, "shipper": {"type": "string"}, "consignee": {"type": "string"}
          }}
        }
      }
    }'::jsonb
);

-- ── phytosanitary_certificate — Фитосанитарный сертификат ───────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'phytosanitary_certificate',
    'Фитосанитарный сертификат',
    'Фитосанитарный сертификат на продукцию растительного происхождения (карантин растений).',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','exporter','consignee','country_of_origin','product_description']::text[],
    ARRAY['фитосанитарн','phytosanitary','фитосертификат','карантин[а-я]*\s+растен']::text[],
    ARRAY[6.0, 6.0, 5.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "issuing_organization": {"type": "string", "description": "Орган выдачи (НОКЗР и т.п.)"},
        "exporter": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}}},
        "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}}},
        "country_of_origin": {"type": "string"},
        "country_of_destination": {"type": "string"},
        "product_description": {"type": "string"},
        "botanical_name": {"type": "string"},
        "quantity": {"type": "string"},
        "point_of_entry": {"type": "string"},
        "treatment": {"type": "object", "properties": {"type": {"type": "string"}, "chemical": {"type": "string"}, "date": {"type": "string"}}}
      }
    }'::jsonb
);

-- ── veterinary_certificate — Ветеринарный сертификат ───────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'veterinary_certificate',
    'Ветеринарный сертификат',
    'Ветеринарный сопроводительный сертификат на продукцию животного происхождения.',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','exporter','consignee','country_of_origin','product']::text[],
    ARRAY['ветеринарн[а-я]+\s+(сертификат|свидетельств|сопроводительн)','veterinary\s+certificate','ветсертификат']::text[],
    ARRAY[6.0, 6.0, 5.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "issuing_authority": {"type": "string", "description": "Госветслужба / орган выдачи"},
        "exporter": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}}},
        "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}}},
        "country_of_origin": {"type": "string"},
        "country_of_destination": {"type": "string"},
        "product": {"type": "string", "description": "Продукция/животные"},
        "quantity": {"type": "string"},
        "transport": {"type": "string"},
        "veterinary_requirements": {"type": "string"}
      }
    }'::jsonb
);

-- Sanity check
DO $$
DECLARE added int;
BEGIN
    SELECT count(*) INTO added FROM document_types
    WHERE slug IN ('awb','manifest','phytosanitary_certificate','veterinary_certificate');
    IF added <> 4 THEN
        RAISE EXCEPTION 'Expected 4 EXT-CLASS-2 types, got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug IN ('awb','manifest','phytosanitary_certificate','veterinary_certificate');
COMMIT;
