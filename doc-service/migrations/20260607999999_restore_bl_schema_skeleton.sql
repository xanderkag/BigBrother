-- Fix collision между моей 20260604000001 (обнулила llm_schema для
-- bill_of_lading чтобы TS fallback заработал) и 20260608000001 от
-- другого агента (ожидает что llm_schema(bill_of_lading) уже содержит
-- properties.{positions|items}). Sanity-check в 20260608000001 fails:
-- "Expected 7 types with items[] in schema, got 6" потому что для
-- bill_of_lading.llm_schema=NULL.
--
-- Решение: восстанавливаем минимальный skeleton llm_schema для
-- bill_of_lading со скромным items[] (LLM подхватит расширенную
-- BL_SCHEMA из EXTENDED_SCHEMAS на runtime через resolver всё равно).
-- Sanity-check 7 типов снова сходится.

UPDATE document_types
   SET llm_schema = jsonb_build_object(
         'type', 'object',
         'properties', jsonb_build_object(
           'items', jsonb_build_object(
             'type', 'array',
             'description', 'Items для bill_of_lading. Расширенная BL_SCHEMA подхватывается из EXTENDED_SCHEMAS на runtime.',
             'items', jsonb_build_object(
               'type', 'object',
               'properties', jsonb_build_object(
                 'name', jsonb_build_object('type', 'string')
               )
             )
           )
         )
       )
 WHERE slug IN ('bill_of_lading')
   AND llm_schema IS NULL;
