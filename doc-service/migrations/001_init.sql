-- doc-service: initial schema
-- Loaded automatically by the postgres container via /docker-entrypoint-initdb.d on first boot.
-- For an existing database, run via `npm run migrate`.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done', 'failed', 'needs_review')),

    -- Source file
    file_name       TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    file_size       BIGINT NOT NULL,
    mime_type       TEXT NOT NULL,

    -- Classification
    document_hint   TEXT,                 -- caller-supplied: invoice | TTN | CMR | UPD | AKT
    document_type   TEXT,                 -- detected by classifier; final value

    -- OCR result
    ocr_engine      TEXT,                 -- pdf-text | tesseract | vision-llm | yandex
    raw_text        TEXT,
    confidence      NUMERIC(4, 3),        -- 0.000 .. 1.000

    -- Structured extraction
    extracted       JSONB,
    extracted_corrected_at TIMESTAMPTZ,   -- set by PATCH /extracted

    -- Caller context
    metadata        JSONB,                -- echoed back unchanged

    -- Webhook delivery
    webhook_url            TEXT,
    webhook_attempts       INTEGER NOT NULL DEFAULT 0,
    webhook_delivered_at   TIMESTAMPTZ,
    webhook_last_error     TEXT,

    -- Bookkeeping
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_status        ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_document_type ON jobs (document_type);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at    ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_pending_webhook
    ON jobs (webhook_url, status)
    WHERE webhook_url IS NOT NULL AND webhook_delivered_at IS NULL;

CREATE OR REPLACE FUNCTION jobs_set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;
CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION jobs_set_updated_at();
