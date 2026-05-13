-- Up Migration
--
-- Phase B: расширяем enum допустимых значений `document_types.parser_kind`
-- значением 'llm_extract_multipass' — двухпроходный LLM-парсер для
-- длинных документов с большим items[].
--
-- Старые типы продолжают работать без изменений; админ может через UI
-- переключить любой тип на multipass-режим, либо оставить 'llm_extract'
-- и положиться на auto-detect по размеру OCR-текста (orchestrator
-- активирует multipass когда rawText.length > config.thresholds.multipassAutoBytes).

ALTER TABLE document_types DROP CONSTRAINT IF EXISTS document_types_parser_kind_check;
ALTER TABLE document_types ADD CONSTRAINT document_types_parser_kind_check
  CHECK (parser_kind IN ('builtin:invoice_regex', 'builtin:upd_regex', 'llm_extract', 'llm_extract_multipass'));

-- Down Migration
ALTER TABLE document_types DROP CONSTRAINT IF EXISTS document_types_parser_kind_check;
ALTER TABLE document_types ADD CONSTRAINT document_types_parser_kind_check
  CHECK (parser_kind IN ('builtin:invoice_regex', 'builtin:upd_regex', 'llm_extract'));
