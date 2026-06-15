-- Up Migration
--
-- job_feedback — внешний фидбек о качестве извлечения по job'у.
--
-- Потребительские системы (клиент №1 — SLAI) присылают вердикт «насколько
-- хорошо распознан/извлечён документ» через POST /api/v1/jobs/:id/feedback.
-- Это сырьё для ручного анализа гипотез по улучшению пайплайна — НЕ влияет
-- на сам job (не меняет extracted/confidence/status).
--
-- Старт простой — на уровне вердикта (correct|partial|incorrect) + коммент.
-- Заложен задел на field-level детализацию (JSONB fields[]) на будущее.
--
-- source_system берётся из АУТЕНТИФИЦИРОВАННОГО caller'а (named API key /
-- service-аккаунт), а не из тела запроса — нельзя подделать источник оценки.

BEGIN;

CREATE TABLE IF NOT EXISTS job_feedback (
  id             BIGSERIAL PRIMARY KEY,
  job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_system  TEXT NOT NULL,  -- кто прислал оценку (имя системы из авторизованного ключа)
  verdict        TEXT NOT NULL CHECK (verdict IN ('correct', 'partial', 'incorrect')),
  comment        TEXT,
  fields         JSONB,          -- опц. детализация по полям на будущее: [{path, note?, correct_value?}]
  rated_by       TEXT,           -- опц. идентификатор конечного пользователя на стороне внешней системы
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE job_feedback IS
  'Внешний фидбек потребителей (SLAI и др.) о качестве извлечения по job. Сырьё для ручного цикла улучшений; на сам job не влияет.';

-- Доступ «весь фидбек по конкретному job».
CREATE INDEX IF NOT EXISTS idx_job_feedback_job
  ON job_feedback (job_id);

-- Аналитический срез — «по системе, недавние сверху» (разбор качества по системе).
CREATE INDEX IF NOT EXISTS idx_job_feedback_source_time
  ON job_feedback (source_system, created_at DESC);

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_job_feedback_source_time;
DROP INDEX IF EXISTS idx_job_feedback_job;
DROP TABLE IF EXISTS job_feedback;

COMMIT;
