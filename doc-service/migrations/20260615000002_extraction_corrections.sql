-- Up Migration
--
-- extraction_corrections — внутренний леджер ручных правок операторов.
--
-- Когда оператор редактирует extracted у job (PATCH /jobs/:id/extracted),
-- каждое изменённое поле фиксируется как before→after. Это самый ценный
-- сигнал для обучения: до сегодня правка просто перезаписывала extracted,
-- и разница (что система выдала vs на что исправил человек) терялась.
--
-- Копится как сырьё для ручного анализа «по типу/полю чаще всего промахи».
-- На сам job не влияет (extracted/confidence/status не трогаем).
--
-- Парная сущность к job_feedback: тот — внешний вердикт потребителей,
-- этот — внутренние правки наших операторов.

BEGIN;

CREATE TABLE IF NOT EXISTS extraction_corrections (
  id             BIGSERIAL PRIMARY KEY,
  job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  document_type  TEXT,           -- нормализованный outbound-slug (консистентный разбор «по типу»)
  field_path     TEXT NOT NULL,  -- leaf dot-path: 'parties.seller.inn', 'items.0.name'
  value_before   TEXT,           -- что выдала система (NULL если поля не было — ADDED)
  value_after    TEXT,           -- на что исправил человек (NULL если поле удалили — REMOVED)
  source_system  TEXT,           -- от какой системы пришёл документ (origin)
  corrected_by   TEXT,           -- кто правил (оператор)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE extraction_corrections IS
  'леджер ручных правок операторов для петли улучшения';

-- «по типу/полю чаще всего промахи» — основной аналитический срез.
CREATE INDEX IF NOT EXISTS idx_extraction_corrections_type_field
  ON extraction_corrections (document_type, field_path);

-- Доступ «все правки по конкретному job».
CREATE INDEX IF NOT EXISTS idx_extraction_corrections_job
  ON extraction_corrections (job_id);

-- Аналитический срез — «по системе-источнику, недавние сверху».
CREATE INDEX IF NOT EXISTS idx_extraction_corrections_source_time
  ON extraction_corrections (source_system, created_at DESC);

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_extraction_corrections_source_time;
DROP INDEX IF EXISTS idx_extraction_corrections_job;
DROP INDEX IF EXISTS idx_extraction_corrections_type_field;
DROP TABLE IF EXISTS extraction_corrections;

COMMIT;
