-- Up Migration
--
-- Полный расход токенов на документ.
--
-- Что было сломано: токены возвращались только внутри `ExtractDebug`, а
-- multipass гонит Pass 1 (шапку) с include_debug=true, но все N чанков с
-- позициями — с include_debug=false. Их расход не приходил вовсе. Плюс
-- `jobs.last_llm_call` хранит лишь ПОСЛЕДНИЙ вызов. Итог: «токены на документ»
-- показывали стоимость одной шапки, занижение росло с числом позиций
-- (инвойс на 53 позиции считался как один маленький запрос). Любые ₽/док,
-- посчитанные из этого, были бы ложью.
--
-- Теперь inference-service отдаёт `usage` в КАЖДОМ ответе, doc-service
-- складывает их по всем вызовам джобы (classify + все проходы extract +
-- verify + vision) и кладёт итог сюда.
--
-- Форма:
--   {
--     "calls":               7,     -- всего LLM-вызовов за джобу
--     "prompt_tokens":   18432,     -- сумма по измеренным вызовам
--     "output_tokens":    2015,
--     "calls_without_usage": 0      -- сколько вызовов НЕ вернули usage
--   }
--
-- `calls_without_usage > 0` означает, что суммы НЕПОЛНЫ (stub / qwen_vl / старый
-- inference не сообщают usage). Такие вызовы считаются НЕИЗМЕРЕННЫМИ, а не
-- нулевыми: производные оценки (₽/док) по такой строке — нижняя граница, и
-- потребитель обязан это учитывать. Молча занулять — способ соврать тише.
--
-- NULL = джоба обработана до этой миграции (или без LLM вовсе).
-- Аддитивно, forward-only.

BEGIN;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS llm_usage JSONB;

COMMENT ON COLUMN jobs.llm_usage IS
  'Суммарный расход токенов LLM за джобу: {calls, prompt_tokens, output_tokens, calls_without_usage}. calls_without_usage>0 → суммы неполны (backend не сообщил usage).';

-- Аналитический срез для ₽/док: «сколько токенов съел документ».
CREATE INDEX IF NOT EXISTS idx_jobs_llm_usage_tokens
  ON jobs (((llm_usage ->> 'prompt_tokens')::bigint))
  WHERE llm_usage IS NOT NULL;

COMMIT;

-- Down Migration
BEGIN;
DROP INDEX IF EXISTS idx_jobs_llm_usage_tokens;
ALTER TABLE jobs DROP COLUMN IF EXISTS llm_usage;
COMMIT;
