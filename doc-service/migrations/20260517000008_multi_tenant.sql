-- Multi-tenant фундамент (фаза 1).
--
-- Закладываем структуру под обслуживание нескольких независимых клиентов:
--   organizations — клиент / дивизион / внешний контрагент;
--   projects — рабочее пространство внутри организации;
--   users — пользователи системы;
--   user_project_access — N:M между пользователем и (organization, project).
--
-- Все рабочие сущности (сейчас — jobs и audit_log) получают scope-колонки
-- organization_id / project_id. Существующие строки backfill'ятся ссылкой
-- на дефолтную System-организацию и Default-проект; новые job'ы без
-- явного указания тоже падают туда.
--
-- В этой миграции НЕ делаем:
--   1. Tenant'инг document_types / provider_settings — пока они глобальные.
--      Расширим позже когда понадобится «свои типы у клиента X».
--   2. Реальный per-user authentication. Сегодня один Bearer-токен
--      по-прежнему = System super_admin. Personal access tokens или OAuth
--      положим отдельной волной.
--   3. Полное enforcement ролей в endpoint'ах. Сегодня всё работает как
--      super_admin. Манагерские/viewer-роли есть в БД, но в коде проверки
--      будут вписаны постепенно.

-- Up Migration

-- Чтобы gen_random_uuid() работал без зависимости от pg_crypto:
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    type         TEXT NOT NULL DEFAULT 'external_company'
                 CHECK (type IN ('internal_division', 'external_company', 'test', 'system')),
    status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'archived')),
    metadata     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived')),
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects (organization_id);

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE,
    display_name    TEXT NOT NULL,
    -- Для super_admin может быть NULL (он не принадлежит конкретной организации).
    -- Для org_admin определяет его организацию-владельца.
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    role            TEXT NOT NULL DEFAULT 'manager'
                    CHECK (role IN ('super_admin', 'org_admin', 'manager', 'viewer')),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'blocked')),
    -- Personal access token (опционально, hashed). Пока единый Bearer API_KEY,
    -- так что у системного юзера это поле NULL. Когда введём per-user токены —
    -- кладём sha256 от plaintext'а сюда (плейн никогда не храним).
    api_token_hash  TEXT,
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users (organization_id) WHERE organization_id IS NOT NULL;

-- N:M доступ. Менеджер может быть в нескольких проектах одной или
-- разных организаций. UNIQUE (user, project) — один пользователь в
-- одном проекте имеет ровно одну роль.
CREATE TABLE IF NOT EXISTS user_project_access (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'manager'
                    CHECK (role IN ('admin', 'manager', 'viewer')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_upa_user ON user_project_access (user_id);
CREATE INDEX IF NOT EXISTS idx_upa_project ON user_project_access (project_id);

-- Updated_at триггеры — переиспользуем jobs_set_updated_at из миграции 001.
DROP TRIGGER IF EXISTS trg_organizations_updated_at ON organizations;
CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();

-- ============================================================================
-- Scope-колонки на существующих рабочих таблицах
-- ============================================================================

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS organization_id  UUID REFERENCES organizations(id),
    ADD COLUMN IF NOT EXISTS project_id       UUID REFERENCES projects(id),
    ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id);

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id),
    ADD COLUMN IF NOT EXISTS actor_user_id   UUID REFERENCES users(id);

-- ============================================================================
-- Seed: System-организация, Default-проект, System-пользователь
-- ============================================================================
-- Используем стабильные UUID-константы. Это даёт нам:
--   - воспроизводимый seed (всегда те же id у дефолтов);
--   - возможность ссылаться на них из кода как на «известные» (см. constants.ts).
-- Сами UUID — произвольные, выбраны read-friendly префиксы, но это просто id.

DO $$
DECLARE
    sys_org_id   UUID := '00000000-0000-0000-0000-00000000a001';
    sys_proj_id  UUID := '00000000-0000-0000-0000-00000000a002';
    sys_user_id  UUID := '00000000-0000-0000-0000-00000000a003';
BEGIN
    INSERT INTO organizations (id, name, type, status)
    VALUES (sys_org_id, 'System', 'system', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO projects (id, organization_id, name, description, status)
    VALUES (sys_proj_id, sys_org_id, 'Default',
            'Системный проект по умолчанию. Все job-ы без явно указанного project_id попадают сюда.',
            'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO users (id, display_name, role, status, organization_id)
    VALUES (sys_user_id, 'System Admin', 'super_admin', 'active', NULL)
    ON CONFLICT (id) DO NOTHING;

    -- Backfill: все ранее созданные jobs / audit_log → дефолтные scope.
    UPDATE jobs
       SET organization_id = sys_org_id,
           project_id = sys_proj_id,
           created_by_user_id = sys_user_id
     WHERE organization_id IS NULL;

    UPDATE audit_log
       SET organization_id = sys_org_id,
           actor_user_id = sys_user_id
     WHERE organization_id IS NULL;
END $$;

-- После backfill'а делаем jobs scope обязательным. audit_log оставляем
-- nullable: некоторые операции (например — будущие system-job sweeper'ы)
-- могут писать в audit без user-контекста.
ALTER TABLE jobs ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE jobs ALTER COLUMN project_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_org_proj_created
    ON jobs (organization_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_at
    ON audit_log (organization_id, at DESC);

-- Down Migration

ALTER TABLE jobs
    DROP COLUMN IF EXISTS organization_id,
    DROP COLUMN IF EXISTS project_id,
    DROP COLUMN IF EXISTS created_by_user_id;

ALTER TABLE audit_log
    DROP COLUMN IF EXISTS organization_id,
    DROP COLUMN IF EXISTS actor_user_id;

DROP INDEX IF EXISTS idx_jobs_org_proj_created;
DROP INDEX IF EXISTS idx_audit_org_at;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
DROP TRIGGER IF EXISTS trg_organizations_updated_at ON organizations;

DROP TABLE IF EXISTS user_project_access;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS organizations;
