-- Добавляем resolution_config на document_types.
-- Колонка описывает как резолюционный пайплайн должен привязывать
-- документ этого типа к бизнес-сущностям и матчить номенклатуру.
--
-- Пример для TTN:
-- {
--   "entity_links": [
--     {
--       "list_type":    "cargo_units",
--       "match_fields": ["cargo_number", "waybill_number"],
--       "on_not_found": "needs_review"
--     }
--   ],
--   "item_matching": {
--     "list_type":      "nomenclature",
--     "items_field":    "items",
--     "name_field":     "name",
--     "code_field":     "code",
--     "on_not_found":   "warn"
--   }
-- }
--
-- on_not_found: "needs_review" | "warn" | "ignore"  (default: "needs_review")

ALTER TABLE document_types
  ADD COLUMN resolution_config JSONB;

COMMENT ON COLUMN document_types.resolution_config IS
  'Конфиг резолюционного пайплайна. entity_links[] — привязка к справочникам. '
  'item_matching — матчинг строк документа. on_not_found: needs_review|warn|ignore.';
