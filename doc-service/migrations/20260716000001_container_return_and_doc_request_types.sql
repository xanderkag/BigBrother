-- Up Migration
--
-- Два новых типа по анализу боевого прогона 2026-07-16 (185 «не опознан»
-- из ~630; из НЕ-фото хвоста два повторяющихся документа без типа в каталоге):
--
--   empty_container_return — «Инструкция по возврату порожнего контейнера»
--                            (~20 хитов в прогоне). Операционный ВЭД-документ:
--                            терминал/депо возврата, срок, номера порожних
--                            контейнеров, линия. НЕ транспортная накладная.
--   document_request       — «Запрос документов» / запрос на досыл. Перечень
--                            запрашиваемых документов, срок, ссылка на заказ.
--
-- Оба: parser_kind='llm_extract', tier='beta' (golden нет), organization_id
-- NULL (глобальные), is_builtin=false. GenericLlmParser обслуживает по
-- llm_schema+expected_fields; живой LLM-классификатор авто-подхватывает.
-- classification_keywords: кириллица матчится ПОДСТРОКОЙ (без \b — см.
-- keywords.ts); латиница — с \b. weights по длине совпадают с keywords.
-- Forward-only, аддитивная миграция.

BEGIN;

-- ── empty_container_return — Инструкция по возврату порожнего контейнера ──
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'empty_container_return',
    'Инструкция по возврату порожнего контейнера',
    'Операционная инструкция по возврату/сдаче порожнего контейнера после выгрузки: терминал или депо возврата, адрес, крайний срок возврата, номера контейнеров, судоходная линия/перевозчик. НЕ транспортная накладная и НЕ booking — это указание по возврату пустого контейнера.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['container_numbers','return_terminal','return_deadline','shipping_line']::text[],
    ARRAY[]::text[],
    ARRAY['инструкция по возврату','возврат порожн','порожнего контейнера','сдача порожн','вывоз порожн','empty container return','return of empty container']::text[],
    ARRAY[8.0, 7.0, 7.0, 5.0, 5.0, 6.0, 6.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "container_numbers": {"type": "array", "items": {"type": "string"}, "description": "Номера порожних контейнеров к возврату (ISO 6346)"},
        "return_terminal": {"type": "string", "description": "Терминал / депо возврата порожнего контейнера"},
        "return_address": {"type": "string", "description": "Адрес места возврата"},
        "return_deadline": {"type": "string", "description": "Крайний срок возврата (дата), YYYY-MM-DD или как в документе"},
        "shipping_line": {"type": "string", "description": "Судоходная линия / перевозчик, кому возвращается контейнер"},
        "order_ref": {"type": "string", "description": "Ссылка на заказ / букинг / коносамент"},
        "instructions": {"type": "string", "description": "Краткое резюме особых указаний по возврату"}
      }
    }'::jsonb
);

-- ── document_request — Запрос документов ─────────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'document_request',
    'Запрос документов',
    'Запрос на предоставление / досыл документов: перечень запрашиваемых документов, кто запрашивает и кому адресован, срок, ссылка на заказ/сделку. Короткое письмо-обращение, НЕ сам документ из перечня.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['requested_documents','order_ref','requester']::text[],
    ARRAY[]::text[],
    ARRAY['запрос документ','просим предоставить','просим направить','предоставить следующие','запрос на предоставление','request for document']::text[],
    ARRAY[8.0, 5.0, 5.0, 5.0, 7.0, 6.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "requested_documents": {"type": "array", "items": {"type": "string"}, "description": "Перечень запрашиваемых документов"},
        "order_ref": {"type": "string", "description": "Ссылка на заказ / сделку / контейнер"},
        "requester": {"type": "string", "description": "Кто запрашивает (компания / отдел / лицо)"},
        "recipient": {"type": "string", "description": "Кому адресован запрос"},
        "deadline": {"type": "string", "description": "Срок предоставления документов"},
        "subject": {"type": "string", "description": "Тема / суть запроса"}
      }
    }'::jsonb
);

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug IN ('empty_container_return', 'document_request') AND organization_id IS NULL;
COMMIT;
