-- doc-service migration 002: Idempotency-Key support for POST /api/v1/jobs
--
-- A client retrying a job upload after a network glitch can send the same
-- Idempotency-Key header twice; the second request returns the existing
-- job's id/status instead of duplicating work. Keys are caller-supplied
-- strings (we cap their length in the route handler).
--
-- Idempotent re-run: every statement here is wrapped in IF NOT EXISTS so
-- the same SQL can be replayed against an already-migrated DB without
-- raising. This is the convention until we wire a proper migration
-- tracker (TECH_DEBT C3).

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index: NULL keys don't conflict with each other (jobs
-- without an Idempotency-Key are just normal jobs), but two non-NULL
-- keys with the same value collide and trigger the INSERT...ON CONFLICT
-- path in the application.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_jobs_idempotency_key
    ON jobs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
