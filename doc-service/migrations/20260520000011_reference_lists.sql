-- Resolution Engine v1: справочники (reference lists) и привязка документов.
--
-- Архитектура:
--   reference_list_types   — типы справочников (scoped на организацию)
--   reference_list_entries — записи (flexible JSONB + search_keys[] для матчинга)
--   job_entity_links       — результат привязки job → сущность
--   job_item_matches       — результат матчинга строк документа → номенклатура
--
-- Матчинг:
--   v1 — точный поиск по search_keys[] (GIN-индекс, O(1))
--   v2 — fuzzy по display_name (pg_trgm, индекс уже подготовлен)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Типы справочников (per-organization)
-- ---------------------------------------------------------------------------
CREATE TABLE reference_list_types (
  slug            TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,          -- 'Грузовые единицы'
  search_hint     TEXT,                   -- 'Номер ГЕ, SSCC, штрихкод'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, organization_id)
);

-- ---------------------------------------------------------------------------
-- Записи справочника
-- ---------------------------------------------------------------------------
CREATE TABLE reference_list_entries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  list_type_slug  TEXT        NOT NULL,
  organization_id UUID        NOT NULL,
  external_id     TEXT,                    -- ID во внешней системе (ERP/WMS)
  display_name    TEXT        NOT NULL,    -- 'ГЕ-00012345 / Паллет А'
  -- Все ключи, по которым может прийти матч из поля extracted:
  --   ['ГЕ-00012345', '00012345', '370123400012345']
  search_keys     TEXT[]      NOT NULL DEFAULT '{}',
  data            JSONB       NOT NULL DEFAULT '{}',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  synced_at       TIMESTAMPTZ,             -- последняя синхронизация извне
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rle_type_fk
    FOREIGN KEY (list_type_slug, organization_id)
    REFERENCES reference_list_types(slug, organization_id)
    ON DELETE CASCADE,

  -- Дедупликация при bulk-sync: external_id уникален в пределах типа+орг
  CONSTRAINT rle_external_id_unique
    UNIQUE NULLS NOT DISTINCT (list_type_slug, organization_id, external_id)
);

-- Exact-поиск по ключам (GIN, O(1) при наличии индекса)
CREATE INDEX rle_search_keys_gin
  ON reference_list_entries USING GIN(search_keys);

-- Fuzzy-поиск по имени (pg_trgm; используется в v2, индекс готовим сейчас)
CREATE INDEX rle_display_name_trgm
  ON reference_list_entries USING GIN(display_name gin_trgm_ops);

-- Быстрый фильтр по типу + организации
CREATE INDEX rle_org_type_active_idx
  ON reference_list_entries(organization_id, list_type_slug)
  WHERE is_active;

-- ---------------------------------------------------------------------------
-- Привязка job → сущность из справочника
-- ---------------------------------------------------------------------------
CREATE TABLE job_entity_links (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  organization_id UUID        NOT NULL,
  list_type_slug  TEXT        NOT NULL,
  entry_id        UUID        REFERENCES reference_list_entries(id) ON DELETE SET NULL,
  -- entry_id IS NULL означает не найдено (status='not_found')

  match_score     NUMERIC(4,3),            -- 0.000 … 1.000
  match_method    TEXT,                    -- 'exact' | 'fuzzy' | 'llm' | 'manual'
  match_field     TEXT,                    -- поле из extracted ('cargo_number')
  match_value     TEXT,                    -- значение ('ГЕ-00012345')

  -- suggested  — система предложила, ждём подтверждения оператора
  -- confirmed  — оператор принял
  -- rejected   — оператор отверг (entry_id может быть заменён вручную)
  -- not_found  — явно зафиксировано «нет в справочнике»
  status          TEXT        NOT NULL DEFAULT 'suggested',

  confirmed_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT jel_status_ck
    CHECK (status IN ('suggested', 'confirmed', 'rejected', 'not_found'))
);

CREATE INDEX jel_job_idx ON job_entity_links(job_id);

-- ---------------------------------------------------------------------------
-- Матчинг строк документа → номенклатурный справочник
-- ---------------------------------------------------------------------------
CREATE TABLE job_item_matches (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  organization_id UUID        NOT NULL,
  list_type_slug  TEXT        NOT NULL,    -- обычно 'nomenclature'
  item_index      INT         NOT NULL,    -- порядковый номер строки в документе
  item_raw        JSONB       NOT NULL,    -- {name, code, qty, price, ...} как распознано

  entry_id        UUID        REFERENCES reference_list_entries(id) ON DELETE SET NULL,
  match_score     NUMERIC(4,3),
  match_method    TEXT,
  status          TEXT        NOT NULL DEFAULT 'suggested',
  -- Проблемы при сверке: ['price_mismatch', 'qty_over', 'not_in_catalog']
  issues          TEXT[]      NOT NULL DEFAULT '{}',

  confirmed_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT jim_status_ck
    CHECK (status IN ('suggested', 'confirmed', 'rejected', 'not_found'))
);

CREATE INDEX jim_job_idx ON job_item_matches(job_id);
