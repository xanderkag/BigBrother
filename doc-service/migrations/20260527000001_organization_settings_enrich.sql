-- Up Migration
--
-- Per-consumer toggle для enrich-стадии (DaData party-by-INN).
--
-- Когда enrich_enabled=true И DaData доступен (DADATA_API_KEY задан) —
-- orchestrator после extract обогащает результат официальной карточкой
-- ЕГРЮЛ по ИНН контрагентов и кладёт её в extracted._enrichment.
-- Default false — обогащение opt-in на потребителя (внешний вызов + стоит
-- денег у DaData).

ALTER TABLE organization_settings
    ADD COLUMN enrich_enabled BOOLEAN NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE organization_settings
    DROP COLUMN IF EXISTS enrich_enabled;
