-- Up Migration
--
-- Боевой кейс 2026-07-01: `Act_260126-013*.pdf` (АКТ ОКАЗАННЫХ УСЛУГ) уходили в
-- wire_transfer_application, `Act_260127-051*.pdf` — в customs_declaration.
--
-- Root cause: у AKT ключ `(?:^|\W)акт(?:\W|$)\s+(оказанных|выполненных|сдачи)`
-- НЕ матчит «АКТ ОКАЗАННЫХ»: `(?:\W|$)` съедает единственный пробел после «акт»,
-- а следующему `\s+` уже нечего съесть. Итог: AKT скорит 0, а wire_transfer
-- (ключ SWIFT, вес 2 — в акте есть банковский SWIFT исполнителя) выигрывает.
--
-- Фикс (дополняет content-scoring, не заменяет):
--   1. Ключ[1] → `(?:^|\W)акт\s+(?:оказанн|выполненн|сдачи-приёмки|сдачи-приемки|
--      приёма-сдачи|приема-сдачи|об\s+оказании)` — один разделитель, ловит все
--      падежи/варианты заголовка акта услуг.
--   2. Веса AKT (были NULL→1.0): definitive-заголовок акта услуг = вес 3.0
--      (title-boost ×1.5 = 4.5) — уверенно бьёт SWIFT(2.0)/спурьёзные матчи.
--      Ключ[2] `акт об оказании` = вес 3.0 тоже.
--
-- Отдельно filename-сигнал (classifier/filename-signal.ts, `Act_`→AKT) даёт
-- аддитивный boost — вместе гарантируют корректную классификацию.
--
-- Второй кейс того же батча: `VAT_invoice_260127-051*.pdf` (заголовок
-- «СЧЕТ-ФАКТУРА») ушёл в customs_declaration. Причина: ВЭД-счёт-фактура в
-- строках товаров ссылается на номер ДТ → customs-ключ (вес 8, поднят
-- миграцией 20260625000003) перебивает factInvoice, у которого веса NULL→1.0.
-- Заголовок «СЧЕТ-ФАКТУРА» — ОПРЕДЕЛЯЮЩИЙ маркер типа; поднимаем его вес до 6
-- (в шапке ×1.5 title-boost = 9 > 8), чтобы definitive-заголовок бил ссылку на ДТ.

BEGIN;

-- AKT: чиним regex «АКТ ОКАЗАННЫХ» + веса.
UPDATE document_types
   SET classification_keywords[1] =
         '(?:^|\W)акт\s+(?:оказанн|выполненн|сдачи-приёмки|сдачи-приемки|приёма-сдачи|приема-сдачи|об\s+оказании)',
       classification_keyword_weights = ARRAY[3.0, 3.0]::numeric[]
 WHERE slug = 'AKT';

-- factInvoice: definitive-заголовок «счёт-фактура» → вес 6 (бьёт ссылку на ДТ).
UPDATE document_types
   SET classification_keyword_weights = ARRAY[6.0, 6.0]::numeric[]
 WHERE slug = 'factInvoice'
   AND array_length(classification_keywords, 1) = 2;

DO $$
DECLARE akt_w numeric; fi_w numeric;
BEGIN
  SELECT classification_keyword_weights[1] INTO akt_w
    FROM document_types WHERE slug = 'AKT';
  IF akt_w <> 3.0 THEN
    RAISE EXCEPTION 'AKT weight[1] not 3.0 (got %)', akt_w;
  END IF;
  SELECT classification_keyword_weights[1] INTO fi_w
    FROM document_types WHERE slug = 'factInvoice';
  IF fi_w <> 6.0 THEN
    RAISE EXCEPTION 'factInvoice weight[1] not 6.0 (got %)', fi_w;
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET classification_keywords[1] =
         '(?:^|\W)акт(?:\W|$)\s+(оказанных|выполненных|сдачи)',
       classification_keyword_weights = NULL
 WHERE slug = 'AKT';
UPDATE document_types
   SET classification_keyword_weights = NULL
 WHERE slug = 'factInvoice';
COMMIT;
