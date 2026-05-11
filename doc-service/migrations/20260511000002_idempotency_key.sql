-- Idempotency-Key support for POST /api/v1/jobs.
--
-- Client retries with the same Idempotency-Key header return the existing
-- job rather than duplicating work. Keys live in the new column; the
-- partial unique index enforces the "one job per key" invariant while
-- leaving normal (key-less) jobs unaffected.

-- Up Migration

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index: NULL keys don't conflict with each other (jobs
-- without an Idempotency-Key are just normal jobs), but two non-NULL
-- keys with the same value collide and trigger the INSERT...ON CONFLICT
-- path in the application.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_jobs_idempotency_key
    ON jobs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS uniq_jobs_idempotency_key;
ALTER TABLE jobs DROP COLUMN IF EXISTS idempotency_key;
