-- Up Migration
--
-- EXT-CLASS-1 (SLAI classifier roadmap, Q-CLASS-MATRIX): новые типы.
--   special_permit  — спецразрешение на крупногабаритный/тяжеловесный транспорт (Росавтодор)
--   booking_request — заявка-бронь на перевозку (экспедитор/форвардер)
-- Оба: parser_kind=llm_extract, validators=date_range, глобальные, tier=experimental
-- (defaults). Тюнинг классификатора waybill — отдельно, на ревью (не здесь).

BEGIN;

-- ── special_permit — Спецразрешение (крупногабарит/тяжеловес) ───────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'special_permit',
    'Спецразрешение на перевозку (крупногабарит/тяжеловес)',
    'Специальное разрешение на движение крупногабаритного и/или тяжеловесного ТС (Росавтодор / орган власти).',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','valid_until','issued_by','carrier','vehicle','route','dimensions']::text[],
    ARRAY['специальн[а-я]+\s+разрешени','спецразрешени','росавтодор','крупногабаритн','тяжеловесн']::text[],
    ARRAY[6.0, 6.0, 5.0, 3.0, 3.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер разрешения"},
        "date": {"type": "string", "description": "Дата выдачи YYYY-MM-DD"},
        "valid_from": {"type": "string", "description": "Действительно с YYYY-MM-DD"},
        "valid_until": {"type": "string", "description": "Действительно по YYYY-MM-DD"},
        "issued_by": {"type": "string", "description": "Орган, выдавший разрешение (Росавтодор и т.п.)"},
        "permit_kind": {"type": "string", "description": "крупногабаритный / тяжеловесный / оба"},
        "carrier": {
          "type": "object", "description": "Перевозчик / заявитель",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}
        },
        "vehicle": {
          "type": "object", "description": "Транспортное средство",
          "properties": {"plate": {"type": "string"}, "model": {"type": "string"}, "trailer_plate": {"type": "string"}}
        },
        "route": {
          "type": "object", "description": "Маршрут движения",
          "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "description": {"type": "string"}}
        },
        "cargo": {"type": "object", "properties": {"description": {"type": "string"}}},
        "dimensions": {
          "type": "object", "description": "Габариты/масса",
          "properties": {
            "length_m": {"type": "number"}, "width_m": {"type": "number"}, "height_m": {"type": "number"},
            "weight_t": {"type": "number"}, "axle_load_t": {"type": "number"}
          }
        }
      }
    }'::jsonb
);

-- ── booking_request — Заявка-бронь на перевозку (форвардер) ─────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, validators,
    expected_fields, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'booking_request',
    'Заявка-бронь на перевозку',
    'Заявка/бронирование перевозки от экспедитора (форвардера). Близка к transport_request; заявитель — экспедитор.',
    false, true, 'llm_extract', ARRAY['date_range']::text[],
    ARRAY['number','date','requestor','carrier','route','cargo']::text[],
    ARRAY['заявка-бронь','бронировани[ея]\s+перевозк','\bbooking\b','букинг','подтверждени[ея]\s+брони']::text[],
    ARRAY[6.0, 5.0, 4.0, 4.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер заявки/брони"},
        "date": {"type": "string", "description": "Дата YYYY-MM-DD"},
        "requestor": {
          "type": "object", "description": "Заявитель (обычно экспедитор/форвардер)",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kind": {"type": "string", "description": "forwarder/shipper/other"}}
        },
        "carrier": {
          "type": "object", "description": "Перевозчик",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}
        },
        "route": {
          "type": "object", "description": "Маршрут",
          "properties": {"loading": {"type": "string"}, "unloading": {"type": "string"}}
        },
        "cargo": {
          "type": "object", "description": "Груз",
          "properties": {"name": {"type": "string"}, "weight_t": {"type": "number"}, "volume_m3": {"type": "number"}}
        },
        "vehicle": {
          "type": "object", "properties": {"plate": {"type": "string"}, "model": {"type": "string"}}
        },
        "rate": {
          "type": "object", "description": "Ставка",
          "properties": {"amount": {"type": "number"}, "currency": {"type": "string"}}
        }
      }
    }'::jsonb
);

-- Sanity check
DO $$
DECLARE added int;
BEGIN
    SELECT count(*) INTO added FROM document_types WHERE slug IN ('special_permit','booking_request');
    IF added <> 2 THEN
        RAISE EXCEPTION 'Expected 2 EXT-CLASS-1 types, got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug IN ('special_permit','booking_request');
COMMIT;
