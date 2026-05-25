-- Up Migration
--
-- extraction-from-image (item A, 2026-05-25): отмечаем, какие LLM-провайдеры
-- vision-capable. Когда resolved-провайдер vision=true, doc-service шлёт
-- первую страницу документа в /v1/extract как image_base64 — модель
-- извлекает поля НАПРЯМУЮ из картинки (бенч Qwen2.5-VL: 90% exact / 96%
-- critical vs 68% text-only). Для text-only провайдеров (phi4 и т.п.)
-- vision=false → классический text-путь, поведение не меняется (hybrid:
-- text остаётся быстрым).
--
-- Default false — новый столбец не меняет ничего, пока админ/seed явно не
-- включит vision у конкретных строк.
--
-- Forward-only. Idempotent: ADD COLUMN IF NOT EXISTS + UPDATE по фиксированным id.

BEGIN;

ALTER TABLE provider_settings
    ADD COLUMN IF NOT EXISTS vision boolean NOT NULL DEFAULT false;

-- Включаем vision у реально multimodal-провайдеров (seed из
-- 20260524000023_local_llm_provider_per_model). qwen2.5-vl добавляется
-- здесь же на будущее (slot может быть заведён админом/последующим seed'ом).
UPDATE provider_settings
SET vision = true
WHERE id IN (
    'local-mistral-small-31',
    'local-minicpm-v',
    'local-qwen-vl-7b',
    'local-qwen25-vl',
    'local-llama32-vision'
);

-- Claude — vision-capable, если такой провайдер заведён.
UPDATE provider_settings
SET vision = true
WHERE kind = 'llm'
  AND id IN ('claude', 'anthropic');

COMMIT;

-- Down Migration

BEGIN;

ALTER TABLE provider_settings
    DROP COLUMN IF EXISTS vision;

COMMIT;
