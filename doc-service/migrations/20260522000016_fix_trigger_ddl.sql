-- Up Migration
--
-- B3 в TECH_DEBT: исходная миграция 0001 пересоздавала trigger через
-- `DROP TRIGGER … + CREATE TRIGGER` — идемпотентно, но на горячей таблице
-- блочит запись на момент DDL. Postgres 14+ поддерживает
-- `CREATE OR REPLACE TRIGGER` — обновляет определение без сброса.
--
-- Эта миграция идемпотентна: если trigger уже существует с правильной
-- логикой — REPLACE его не сломает. Делаем то же самое для функции.

CREATE OR REPLACE FUNCTION jobs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION jobs_set_updated_at();

-- Down Migration
--
-- Откат не требуется: REPLACE-операции не оставляют побочных эффектов.
-- Trigger останется в БД с тем же определением что и в 0001.
SELECT 1;
