-- Document-type multi-tenancy (TECH_DEBT CP7, фаза 1).
--
-- Делаем document_types ownable организацией, сохраняя builtin + shared
-- типы глобальными. Потребители (ВЭД, Финансы и далее) — каждый отдельная
-- organization со своим набором кастомных типов.
--
-- Семантика organization_id:
--   NULL              ⇒ глобальный / shared / builtin тип (виден всем);
--   <org uuid>        ⇒ tenant-owned, виден только этой орг + super_admin.
--
-- Slug остаётся глобально уникальным (natural key). organization_id рулит
-- ТОЛЬКО видимостью/владением, НЕ смыслом slug'а: 'invoice' значит одно и то
-- же везде, webhook-контракт slug-based.
--
-- Builtin-типы ВСЕГДА глобальны (organization_id IS NULL, is_builtin=true).
-- Назначить builtin тенанту нельзя — стережёт CHECK chk_builtin_is_global.
--
-- Существующие типы (6 builtin + текущие 19 custom) backfill'ить не нужно:
-- колонка default NULL ⇒ все они становятся GLOBAL, как и задумано.

-- Up Migration

ALTER TABLE document_types
    ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX idx_document_types_org ON document_types (organization_id);

-- Guard: builtin-типы не могут быть tenant-scoped.
ALTER TABLE document_types
    ADD CONSTRAINT chk_builtin_is_global
    CHECK (NOT (is_builtin = true AND organization_id IS NOT NULL));

-- Down Migration

ALTER TABLE document_types DROP CONSTRAINT IF EXISTS chk_builtin_is_global;
DROP INDEX IF EXISTS idx_document_types_org;
ALTER TABLE document_types DROP COLUMN IF EXISTS organization_id;
