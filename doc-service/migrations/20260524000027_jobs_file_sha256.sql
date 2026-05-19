-- Up Migration
--
-- SHA-256 file hash caching. Optimization #4 из roadmap.
--
-- Use case: SLAI / client может re-upload тот же файл (например после
-- edit в их UI, или ретрай webhook'а который не дошёл). Сейчас каждый
-- upload = новый job + новый LLM extract (~$0.01-0.05/doc + 100-600s
-- latency).
--
-- С SHA-256 caching: при upload вычисляем хэш файла. Если в БД есть
-- job с тем же hash в той же организации со status='done' и age < 24h,
-- возвращаем тот же job_id с заголовком X-Parsdocs-Cached: 1 — клиент
-- получает результат мгновенно, без повторной обработки.
--
-- Дополняет Idempotency-Key:
--   - Idempotency-Key — client-side контроль (клиент знает что ретрает)
--   - SHA-256 — server-side dedupe (защита от двух разных клиентов
--     которые загрузили один и тот же документ)
--
-- Колонка nullable — старые jobs не пересчитываем; новые upload'ы
-- заполнят. Индекс partial — только не-null значения, экономит storage.

BEGIN;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS file_sha256 char(64);

-- Partial index — только не-null. PRO: меньше storage, быстрее scan
-- при cache lookup (typical case — hit или miss за O(log N))
CREATE INDEX IF NOT EXISTS idx_jobs_file_sha256
  ON jobs (file_sha256, organization_id, created_at DESC)
  WHERE file_sha256 IS NOT NULL AND status = 'done';

COMMENT ON COLUMN jobs.file_sha256 IS
  'SHA-256 hash оригинального файла (hex lowercase, 64 chars). '
  'Заполняется в routes/jobs.ts при upload. Используется для cache lookup. '
  'Nullable — старые jobs до миграции 0027 не имеют hash.';

COMMIT;

-- Down Migration
BEGIN;
DROP INDEX IF EXISTS idx_jobs_file_sha256;
ALTER TABLE jobs DROP COLUMN IF EXISTS file_sha256;
COMMIT;
