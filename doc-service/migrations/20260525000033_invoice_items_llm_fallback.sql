-- Up Migration
--
-- P0 (2026-05-20, фрахт-счета SLAI): invoice извлекался только regex'ом
-- (header-поля), а items[] всегда пустой — regex принципиально не вытаскивает
-- таблицу позиций. Для SLAI items[] обязателен: каждая строка фрахт-счёта =
-- рейс (госномер, заказ, маршрут), по ней привязывается машина и заказ.
--
-- Почему LLM не запускался: InvoiceParser возвращает regex-результат если
-- его completeness-confidence >= regex_fallback_threshold. expected_fields
-- были {number,date,seller,buyer,total} — все 5 находятся regex'ом →
-- confidence 1.0 → LLM-fallback никогда не срабатывал.
--
-- Решение:
-- 1. Добавляем `items` в expected_fields. Теперь regex находит 5 из 6 полей
--    (items ему не доступен) → completeness 0.83.
-- 2. Поднимаем regex_fallback_threshold 0.70 → 0.90. 0.83 < 0.90 → парсер
--    всегда уходит в LLM /extract, который заполняет items[] (включая
--    транспортные атрибуты vehicle_plate/order_ref/route_from/route_to —
--    они описаны в каноничной ITEM_PROPERTIES схеме).
-- 3. Добавляем llm_prompt с явной инструкцией парсить транспортные атрибуты
--    из текста строки (в фрахт-счетах они зашиты в name).
--
-- Trade-off: теперь КАЖДЫЙ invoice проходит через LLM (медленнее, чем чистый
-- regex). Для SLAI это осознанный выбор — полнота items[] важнее latency,
-- локальный Qwen бесплатен. Простые товарные счета тоже выиграют (получат
-- структурированные items[] вместо пустого массива).

BEGIN;

UPDATE document_types
SET
  expected_fields = ARRAY['number', 'date', 'seller', 'buyer', 'total', 'items']::text[],
  regex_fallback_threshold = 0.90,
  llm_prompt = 'Это счёт на оплату (часто — счёт перевозчика за транспортные услуги). '
    || 'Извлеки все поля шапки (номер, дата, продавец/покупатель с ИНН/КПП/адрес/банк, итого, НДС) '
    || 'и ОБЯЗАТЕЛЬНО заполни items[] — по строке на каждую позицию таблицы. '
    || 'Для счетов перевозчиков транспортные атрибуты строки зашиты в текст наименования, например: '
    || '"Перевозка груза. Заказ: T-2025-006. Маршрут: Москва → Краснодар. Госномер: А123ВС797." — '
    || 'распарси из него order_ref (после "Заказ:"), vehicle_plate (после "Госномер:", в верхнем регистре без пробелов), '
    || 'route_from и route_to (из "Маршрут: A → B"). Если поля нет — null. '
    || 'У ИП КПП отсутствует — оставь null, это не ошибка. '
    || 'seller и buyer — это РАЗНЫЕ стороны, не путай их ИНН.'
WHERE slug = 'invoice';

COMMIT;

-- Down Migration
BEGIN;

UPDATE document_types
SET
  expected_fields = ARRAY['number', 'date', 'seller', 'buyer', 'total']::text[],
  regex_fallback_threshold = 0.700,
  llm_prompt = NULL
WHERE slug = 'invoice';

COMMIT;
