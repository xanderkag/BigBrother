-- Up Migration
--
-- EXT-CLASS-3 (SLAI classifier roadmap, последний эпик): международные ж/д накладные.
--   cim   — накладная ЦИМ/CIM (конвенция КОТИФ, Европа)
--   smgs  — накладная СМГС (СНГ + Китай + др.)
-- Оба: parser_kind=llm_extract, validators=date_range, глобальные, tier=experimental.
-- Схема ж/д накладной: стороны со страной, станции отправления/назначения,
-- вагон/контейнер, груз, маршрут следования, погранпереход.

BEGIN;

-- ── cim — Накладная ЦИМ / CIM ──────────────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'cim',
    'Ж/д накладная ЦИМ (CIM)',
    'Международная железнодорожная накладная по правилам ЦИМ/CIM (конвенция КОТИФ, Европа).',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','consignor','consignee','station_of_dispatch','station_of_destination','cargo']::text[],
    ARRAY['\bCIM\b','\bЦИМ\b','котиф','железнодорожн[а-я]+\s+накладн','rail\s+consignment']::text[],
    ARRAY[6.0, 6.0, 5.0, 4.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "description": "Дата YYYY-MM-DD"},
        "consignor": {"type": "object", "description": "Отправитель", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "consignee": {"type": "object", "description": "Получатель", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "carrier": {"type": "object", "description": "Перевозчик (ж/д)", "properties": {"name": {"type": "string"}}},
        "station_of_dispatch": {"type": "string", "description": "Станция отправления"},
        "station_of_destination": {"type": "string", "description": "Станция назначения"},
        "wagon_number": {"type": "string", "description": "Номер вагона"},
        "container_no": {"type": "string", "description": "Номер контейнера (ISO 6346)"},
        "route_via": {"type": "string", "description": "Маршрут следования / через"},
        "cargo": {"type": "object", "properties": {"description": {"type": "string"}, "weight_kg": {"type": "number"}, "packages": {"type": "number"}}}
      }
    }'::jsonb
);

-- ── smgs — Накладная СМГС ──────────────────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'smgs',
    'Ж/д накладная СМГС',
    'Международная железнодорожная накладная СМГС (Соглашение о международном ж/д грузовом сообщении: СНГ, Китай и др.).',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','consignor','consignee','station_of_dispatch','station_of_destination','wagon_number','cargo']::text[],
    ARRAY['\bСМГС\b','накладн[а-я]+\s+СМГС','прямо[а-я]+\s+международн[а-я]+\s+железнодорожн','соглашени[ея].{0,40}железнодорожн.{0,40}сообщени']::text[],
    ARRAY[6.0, 6.0, 4.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string"},
        "consignor": {"type": "object", "description": "Отправитель", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "consignee": {"type": "object", "description": "Получатель", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "carrier": {"type": "object", "properties": {"name": {"type": "string"}}},
        "station_of_dispatch": {"type": "string"},
        "station_of_destination": {"type": "string"},
        "wagon_number": {"type": "string"},
        "container_no": {"type": "string"},
        "border_crossing": {"type": "string", "description": "Погранпереход"},
        "route_via": {"type": "string"},
        "cargo": {"type": "object", "properties": {"description": {"type": "string"}, "weight_kg": {"type": "number"}, "packages": {"type": "number"}}}
      }
    }'::jsonb
);

-- Sanity check
DO $$
DECLARE added int;
BEGIN
    SELECT count(*) INTO added FROM document_types WHERE slug IN ('cim','smgs');
    IF added <> 2 THEN
        RAISE EXCEPTION 'Expected 2 EXT-CLASS-3 types, got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug IN ('cim','smgs');
COMMIT;
