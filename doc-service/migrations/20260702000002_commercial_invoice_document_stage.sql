-- Up Migration
--
-- Webhook schema 1.2 (SLAI дедуп/версии документов, 2026-07-02): document_stage.
-- commercial_invoice — DB-driven тип (llm_schema живёт в БД), поэтому хардкод-
-- правка INVOICE_SCHEMA (invoice/factInvoice/tax_invoice/upd в
-- document-json-schemas.ts) его НЕ покрывает. Добавляем поле document_stage
-- сюда, чтобы модель размечала ЧЕРНОВОЙ коммерческий инвойс — иначе projector
-- match-signals по умолчанию отдаёт 'final' (риск «черновик как финал», который
-- SLAI просил закрыть под их дедуп/версии).
--
-- proforma_invoice НЕ трогаем: computeDocumentStage() возвращает 'proforma'
-- по ТИПУ независимо от наличия поля (тип выигрывает). invoice / factInvoice /
-- tax_invoice / upd покрыты кодовой INVOICE_SCHEMA.
--
-- Техника аддитивная: NEW || EXISTING на уровне properties (конфликтный ключ
-- сохраняет СТАРОЕ значение). Forward-only.

BEGIN;

UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "document_stage": {
              "type": "string",
              "enum": ["draft", "proforma", "final"],
              "description": "Стадия документа. draft — если есть явный маркер черновика (watermark «DRAFT», «ПРОЕКТ», «предварительный»); final — если явно «FINAL»/«ORIGINAL»/чистовик. Нет явного маркера — опусти (по умолчанию трактуется как final)."
            }
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'commercial_invoice';

DO $$
DECLARE props jsonb;
BEGIN
  SELECT llm_schema->'properties' INTO props
    FROM document_types WHERE slug = 'commercial_invoice';
  IF props IS NULL THEN
    RAISE EXCEPTION 'commercial_invoice schema/properties missing';
  END IF;
  IF NOT (props ? 'document_stage') THEN RAISE EXCEPTION 'document_stage not added'; END IF;
  -- additive-only: существовавшие ключи на месте
  IF NOT (props ? 'total_amount') THEN RAISE EXCEPTION 'existing key total_amount clobbered'; END IF;
  IF NOT (props ? 'exporter')     THEN RAISE EXCEPTION 'existing key exporter clobbered'; END IF;
  IF NOT (props ? 'buyer')        THEN RAISE EXCEPTION 'existing key buyer clobbered'; END IF;
END $$;

-- Промпт перечисляет поля — дописываем document_stage (append-only, guard).
UPDATE document_types
   SET llm_prompt = llm_prompt ||
     ' document_stage — стадия документа: draft (явный маркер черновика: watermark «DRAFT»/«ПРОЕКТ»/«предварительный»); final (явно «FINAL»/«ORIGINAL»/чистовик). Нет явного маркера — опусти поле.'
 WHERE slug = 'commercial_invoice'
   AND llm_prompt NOT LIKE '%document_stage%';

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = (llm_schema #- '{properties,document_stage}')
 WHERE slug = 'commercial_invoice';
UPDATE document_types SET llm_prompt = replace(llm_prompt,
  ' document_stage — стадия документа: draft (явный маркер черновика: watermark «DRAFT»/«ПРОЕКТ»/«предварительный»); final (явно «FINAL»/«ORIGINAL»/чистовик). Нет явного маркера — опусти поле.', '')
 WHERE slug = 'commercial_invoice';
COMMIT;
