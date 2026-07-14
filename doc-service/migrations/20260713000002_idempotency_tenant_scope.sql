-- Up Migration
--
-- audit #1: idempotency-ключ был ГЛОБАЛЬНЫМ (unique index только по
-- idempotency_key). Последствия: (1) один тенант мог узнать факт+статус чужой
-- задачи (short-circuit отдавал чужой job_id/status); (2) коллизия ключа между
-- тенантами «проглатывала» легитимную загрузку одного, отправляя её на чужую
-- задачу. Делаем ключ tenant-scoped: unique (organization_id, idempotency_key).
-- Теперь один и тот же ключ у разных орг — не конфликт; scoped lookup + access-
-- check в POST /jobs закрывают disclosure.
--
-- ⚠️ Заметка на применение: если в БД уже есть дубликаты (organization_id,
-- idempotency_key) — их не может быть (старый глобальный unique был строже), так
-- что CREATE UNIQUE пройдёт. Forward-only, аддитивная переиндексация.

BEGIN;
DROP INDEX IF EXISTS uniq_jobs_idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_jobs_org_idempotency_key
    ON jobs (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
COMMIT;

-- Down Migration
BEGIN;
DROP INDEX IF EXISTS uniq_jobs_org_idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_jobs_idempotency_key
    ON jobs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
COMMIT;
