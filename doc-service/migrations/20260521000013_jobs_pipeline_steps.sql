-- Up Migration
--
-- Pipeline observability — per-job step events.
--
-- Зачем: live-прогресс в UI Upload показывает реальные шаги обработки
-- (PDF-text → Tesseract → Vision LLM → Parse → Validate → Resolution)
-- вместо общего "processing". Также — пост-мортем при ошибках: оператор
-- видит на какой именно ступени job упал и сколько прошло до этого момента.
--
-- Структура одной записи (JSON):
--   { "step": "ocr.tesseract", "status": "done", "at": "...", "duration_ms": 1234,
--     "details": { "confidence": 0.92, "engine": "tesseract" } }
--
-- step: классификатор стадии. Ожидаемые значения:
--   upload, classify, ocr.<engine>, parse.<kind>, validate, resolve, finalize
-- status: 'started' | 'done' | 'failed' | 'skipped'
--
-- Хранится как JSONB-массив (append-only). Растёт ~10-20 событий на job,
-- что для JSONB — копейки. Индекса не делаем — данные читаются только по
-- jobId + не используются в WHERE.

ALTER TABLE jobs ADD COLUMN pipeline_steps JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN jobs.pipeline_steps IS
  'Append-only список событий пайплайна: { step, status, at, duration_ms?, details? }. '
  'Заполняется оркестратором на каждой стадии. Используется UI для live-прогресса '
  'и пост-мортема при ошибках.';

-- Down Migration
ALTER TABLE jobs DROP COLUMN IF EXISTS pipeline_steps;
