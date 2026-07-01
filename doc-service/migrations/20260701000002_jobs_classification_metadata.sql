-- Up Migration
--
-- jobs.classification — метаданные LLM-классификатора (production LLM classifier).
--
-- На КАЖДОМ документе прогоняется LLM-классификатор (qwen3.6:27b) поверх
-- keyword+filename prior'а. Результат — не только финальный document_type, но и
-- богатая трасса «почему этот тип»: что сказал keyword-prior, что сказал LLM,
-- каким методом выбран финал, сколько занял classify-вызов, кандидаты, флаг
-- «не опознан». Всё это читает UI (job detail) для наблюдаемости.
--
-- Отдельная nullable jsonb-колонка (а не запихивание в pipeline_steps) —
-- фронту проще: одно поле job.classification фиксированной формы, не надо
-- искать нужный step в массиве. Additive, nullable — legacy job'ы до миграции
-- просто без этого поля (UI показывает старую classify-стадию из pipeline_steps).
--
-- Форма (см. src/pipeline/classifier/llm-classifier.ts ClassificationMetadata):
--   {
--     "type": "<slug|null>",
--     "confidence": <0..1>,
--     "method": "llm"|"keyword"|"filename"|"fallback"|"hint",
--     "duration_ms": <int|null>,
--     "llm_said": "<raw slug|unknown|null>",
--     "keyword_said": {"type": "<slug>", "score": <0..1>} | null,
--     "candidates": [{"type": "<slug>", "score": <0..1>}, ...],
--     "unknown": <bool>
--   }

BEGIN;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS classification JSONB;

COMMENT ON COLUMN jobs.classification IS
  'Метаданные LLM-классификатора: {type, confidence, method, duration_ms, llm_said, keyword_said, candidates, unknown}. Питает UI job detail. NULL для legacy jobs до внедрения.';

COMMIT;

-- Down Migration

BEGIN;

ALTER TABLE jobs DROP COLUMN IF EXISTS classification;

COMMIT;
