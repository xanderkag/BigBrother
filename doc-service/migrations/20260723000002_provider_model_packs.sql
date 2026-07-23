-- Up Migration
--
-- MTI-2 (ТЗ docs/MTI_TZ_2026-05-31.md §2.1/§2.5): один provider = pack моделей.
--
-- Проблема: сегодня `provider_settings.model` — ОДНА строка. Чтобы иметь
-- sonnet+opus+haiku от Anthropic, приходится плодить 3 строки provider_settings
-- с одним и тем же (зашифрованным) ключом. Ключ дублируется, ротация правит
-- 3 строки, а per-job выбор модели уродлив.
--
-- Фикс: провайдер несёт МАССИВ моделей (`models`) + какая берётся по умолчанию
-- (`default_model`). Per-job override (`metadata._llm_model`) и per-type
-- (`metadata.preferred_model`) выбирают модель ВНУТРИ одного провайдера, не
-- меняя ключ/endpoint.
--
-- Backward-compat: legacy-колонку `model` НЕ дропаем (в отличие от буквы ТЗ §2.1
-- `DROP COLUMN model`) — резолвер читает default_model, а при NULL откатывается
-- на model. Это (а) держит откат безопасным, (б) не ломает старые снимки/строки,
-- (в) даёт мягкую миграцию. Дроп — отдельным шагом когда model перестанет
-- читаться где-либо.

BEGIN;

-- pack моделей провайдера: [{name, alias, vision, cost_tier}, ...].
-- name — то, что уходит в inference body.model (ollama-tag / anthropic model-id).
-- alias — короткое имя для per-job выбора ("opus"); резолвер найдёт по нему name.
ALTER TABLE provider_settings ADD COLUMN IF NOT EXISTS models JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN provider_settings.models IS
  'MTI-2 pack моделей провайдера: [{name, alias, vision, cost_tier: low|mid|high}]. name уходит в inference body.model; alias — для per-job выбора (metadata._llm_model). Пусто → одна модель из legacy-колонки model.';

-- какую модель брать если job/type не указали иное. NULL → откат на legacy model.
ALTER TABLE provider_settings ADD COLUMN IF NOT EXISTS default_model TEXT;
COMMENT ON COLUMN provider_settings.default_model IS
  'MTI-2: модель по умолчанию для провайдера. Приоритет: job._llm_model → type.preferred_model → default_model → legacy model. NULL → откат на колонку model.';

COMMENT ON COLUMN provider_settings.model IS
  'LEGACY (до MTI-2): одиночная модель. Оставлена для backward-compat/отката. Читается резолвером ТОЛЬКО когда default_model IS NULL. Новый код пишет models[]+default_model.';

-- ── Бэкфилл: существующая model → первый элемент pack + default_model ────────
-- Каждая текущая строка с непустой model получает pack из одной модели
-- (alias='default') и default_model=model. Существующие jobs/резолв не ломаются:
-- default_model==model, поведение идентично. vision берём с самой строки —
-- vision-провайдер (qwen3-vl) сохранит флаг на своей единственной модели.
UPDATE provider_settings
SET
  models = jsonb_build_array(
    jsonb_build_object(
      'name', model,
      'alias', 'default',
      'vision', COALESCE(vision, false),
      'cost_tier', NULL
    )
  ),
  default_model = model
WHERE model IS NOT NULL
  AND model <> ''
  AND (models IS NULL OR models = '[]'::jsonb);

COMMIT;

-- Down Migration
BEGIN;
ALTER TABLE provider_settings DROP COLUMN IF EXISTS models;
ALTER TABLE provider_settings DROP COLUMN IF EXISTS default_model;
COMMENT ON COLUMN provider_settings.model IS NULL;
COMMIT;
