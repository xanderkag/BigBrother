-- Колонка для дебаг-следа LLM-вызова: финальный prompt и сырой ответ
-- модели ДО нашего JSON-парсинга. Главный use-case — отладочная петля
-- тюнинга prompt'а: оператор видит extracted кривой, открывает job,
-- смотрит «что отправили в модель / что получили обратно», понимает
-- куда тыкать.
--
-- Структура { prompt, raw_response, model, backend, at } — захватывается
-- inference-service'ом по флагу `include_debug=true` в запросе. Доступ
-- только админам с Bearer-токеном (через job API). На стороне БД —
-- обычный JSONB без шифрования, потому что это уже на одной БД с
-- raw_text документа.

-- Up Migration

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_llm_call JSONB;

-- Down Migration

ALTER TABLE jobs DROP COLUMN IF EXISTS last_llm_call;
