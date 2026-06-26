-- Up Migration
--
-- Аудит провалов извлечения 2026-06-26: для customs_declaration (ДТ/ГТД) часть
-- граф ДТ либо была вычищена ранними миграциями, либо никогда не извлекалась.
--
--   - Графы 16/17 (страна происхождения/назначения), Графа 47 (таможенные платежи
--     duties[]) и declarant.kpp были добавлены в 0514, но 0522 при канонизации
--     positions->items затёр их часть. Текущий прод ИХ УЖЕ содержит, поэтому
--     восстановление здесь — идемпотентно-аддитивное (merge NEW||EXISTING: при
--     конфликте побеждает существующее значение, ничего не затирается).
--   - Графы 44/15/20/9/54 и preceding_documents НИКОГДА не были в схеме — модель
--     их не заполняла. Явный запрос пользователя на ПОЛНЫЙ разбор ДТ.
--
-- Техника строго аддитивная: jsonb_set(..., NEW || EXISTING) — порядок слияния
-- гарантирует, что любой уже существующий ключ сохраняет своё значение.
-- items[] (канонический ключ позиций после 0522/0608) НЕ ТРОГАЕМ.

BEGIN;

-- 1. Top-level: восстановить 16/17/47 + добавить новые 44/15/20/9/54 и preceding_documents.
--    NEW || EXISTING => существующие ключи (origin_country, destination_country, duties)
--    сохраняют свои значения; новые добавляются.
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties}',
         '{
            "origin_country": {"type": "string", "description": "Страна происхождения (Графа 16)"},
            "destination_country": {"type": "string", "description": "Страна назначения (Графа 17)"},
            "departure_country": {"type": "string", "description": "Страна отправления (Графа 15)"},
            "delivery_terms": {"type": "string", "description": "Условия поставки/Incoterms (Графа 20), напр. CIP Москва"},
            "place_and_date": {"type": "string", "description": "Место и дата декларирования (Графа 54)"},
            "financial_settlement_person": {
              "type": "object",
              "description": "Лицо, ответственное за финансовое урегулирование (Графа 9)",
              "properties": {
                "name": {"type": "string"},
                "inn": {"type": "string"},
                "country": {"type": "string"}
              }
            },
            "duties": {
              "type": "array",
              "description": "Таможенные платежи (Графа 47)",
              "items": {
                "type": "object",
                "properties": {
                  "type": {"type": "string", "description": "1010 — таможенный сбор, 2010 — пошлина, 5010 — НДС"},
                  "base": {"type": "number"},
                  "rate": {"type": "string", "description": "20%, 7.5%, 5 EUR/kg и т.п."},
                  "amount": {"type": "number"},
                  "currency": {"type": "string"}
                }
              }
            },
            "documents": {
              "type": "array",
              "description": "Представленные документы (Графа 44)",
              "items": {
                "type": "object",
                "properties": {
                  "code": {"type": "string"},
                  "number": {"type": "string"},
                  "date": {"type": "string"}
                }
              }
            },
            "preceding_documents": {
              "type": "array",
              "description": "Предшествующие документы (Графа 40/44)",
              "items": {
                "type": "object",
                "properties": {
                  "type": {"type": "string"},
                  "number": {"type": "string"},
                  "date": {"type": "string"}
                }
              }
            }
          }'::jsonb || (llm_schema->'properties')
       )
 WHERE slug = 'customs_declaration';

-- 2. Nested: declarant.kpp (восстановление, идемпотентно через NEW || EXISTING).
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,declarant,properties}',
         '{"kpp": {"type": "string", "description": "КПП декларанта"}}'::jsonb
           || (llm_schema#>'{properties,declarant,properties}')
       )
 WHERE slug = 'customs_declaration';

-- 3. Дописать в llm_prompt инструкцию извлекать Графу 47 и Графу 44 (сохраняя текст).
UPDATE document_types
   SET llm_prompt = llm_prompt
        || ' Графа 47 — таможенные платежи: для каждого вида извлеки код вида (1010 сбор / 2010 пошлина / 5010 НДС), основу начисления, ставку и сумму. Графа 44 — представленные документы: извлеки код, номер и дату каждого документа.'
 WHERE slug = 'customs_declaration';

-- Верификация: все целевые ключи должны присутствовать после апдейта.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(k, ', ') INTO missing
  FROM (
    SELECT k FROM unnest(ARRAY[
      'origin_country','destination_country','departure_country','delivery_terms',
      'place_and_date','financial_settlement_person','duties','documents','preceding_documents'
    ]) AS k
    WHERE NOT (
      (SELECT llm_schema->'properties' FROM document_types WHERE slug='customs_declaration') ? k
    )
  ) s;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'customs_declaration: top-level keys missing after update: %', missing;
  END IF;

  IF NOT (
    (SELECT llm_schema#>'{properties,declarant,properties}' FROM document_types WHERE slug='customs_declaration') ? 'kpp'
  ) THEN
    RAISE EXCEPTION 'customs_declaration: declarant.kpp missing after update';
  END IF;

  IF (SELECT llm_prompt FROM document_types WHERE slug='customs_declaration') NOT LIKE '%Графа 47%' THEN
    RAISE EXCEPTION 'customs_declaration: llm_prompt not extended with Графа 47';
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;

-- Снять только добавленные новые ключи (16/17/47/declarant.kpp существовали ДО этой
-- миграции на проде — их НЕ удаляем, чтобы не разрушить более раннее состояние).
UPDATE document_types
   SET llm_schema = llm_schema #- '{properties,departure_country}'
                               #- '{properties,delivery_terms}'
                               #- '{properties,place_and_date}'
                               #- '{properties,financial_settlement_person}'
                               #- '{properties,documents}'
                               #- '{properties,preceding_documents}'
 WHERE slug = 'customs_declaration';

UPDATE document_types
   SET llm_prompt = replace(
         llm_prompt,
         ' Графа 47 — таможенные платежи: для каждого вида извлеки код вида (1010 сбор / 2010 пошлина / 5010 НДС), основу начисления, ставку и сумму. Графа 44 — представленные документы: извлеки код, номер и дату каждого документа.',
         ''
       )
 WHERE slug = 'customs_declaration';

COMMIT;
