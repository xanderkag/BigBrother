-- Up Migration
--
-- Оценка стоимости ₽/док (owner-запрос 2026-07-13, триггер ~600₽ на eval-БКТ):
-- добавляем число OCR-страниц per-job. Стоимость Yandex Vision — ₽/страница
-- (печатный 0.13 / таблица 1.22), поэтому для расчёта нужен счётчик страниц.
-- Заполняется на finalize из ocr.pages.length. Аддитивно, nullable (legacy → NULL).
-- LLM-токены уже есть в jobs.llm_usage (миграция 20260708000001).

BEGIN;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ocr_pages integer;
COMMIT;

-- Down Migration
BEGIN;
ALTER TABLE jobs DROP COLUMN IF EXISTS ocr_pages;
COMMIT;
