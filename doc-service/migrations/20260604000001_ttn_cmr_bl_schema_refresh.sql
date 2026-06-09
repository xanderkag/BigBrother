-- EXT-TTN-1 (SLAI 2026-06-04 Q-TTN-CMR-BL-SCHEMA): обнуляем llm_schema
-- для типов где мы только что обновили TS-схему — чтобы парсер взял
-- свежую DOCUMENT_JSON_SCHEMAS[type] / EXTENDED_SCHEMAS[slug] вместо
-- старого DB-снимка.
--
-- TTN / CMR — builtin типы, схема в src/types/document-json-schemas.ts.
-- bill_of_lading — custom slug, схема в EXTENDED_SCHEMAS (новая BL_SCHEMA).
--
-- Также обнуляем expected_fields — берётся из EXPECTED_FIELDS{TTN,CMR}
-- который тоже обновлён (carrier, route, driver добавлены).
--
-- Admin может в любой момент переопределить через UI (Document Type Registry).

UPDATE document_types
   SET llm_schema = NULL,
       expected_fields = ARRAY[]::TEXT[],
       updated_at = now()
 WHERE slug IN ('TTN', 'ttn', 'CMR', 'cmr', 'bill_of_lading');
