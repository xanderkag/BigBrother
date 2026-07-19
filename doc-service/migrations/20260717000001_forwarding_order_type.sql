-- Up Migration
--
-- Новый тип forwarding_order — «Поручение экспедитору» (анализ 2026-07-17:
-- 48 из 59 в transport_request были поручениями экспедитору, не заявками
-- перевозчику). У поручения ДРУГАЯ модель сторон: Клиент / Экспедитор /
-- Грузоотправитель / Грузополучатель (а не заказчик↔перевозчик). Из-за
-- несовпадения заказчик (client) не извлекался 0/59, а классификатор колебался
-- (classify_uncertain на всех needs_review). Плюс поручение бывает на ОДНО
-- плечо (авиа/авто/жд/море) или на всю перевозку — фиксируем полем leg.
--
-- transport_request остаётся для настоящих заявок перевозчику (11 шт.).
-- parser_kind=llm_extract, tier=beta, organization_id NULL (глобальный),
-- is_builtin=false. classification_keywords: кириллица матчится ПОДСТРОКОЙ.
-- Forward-only, аддитивная миграция.

BEGIN;

INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_prompt, llm_schema
) VALUES (
    'forwarding_order',
    'Поручение экспедитору',
    'Поручение (заявка) экспедитору на организацию доставки/экспедирования груза. Модель сторон: Клиент (заказчик экспедирования) — Экспедитор (исполнитель, ТЭК) — Грузоотправитель — Грузополучатель. Отличается от transport_request (заявка перевозчику, заказчик↔перевозчик). Бывает на одно плечо перевозки (авиа/авто/жд/море) или на всю перевозку.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['number','date','client','expeditor','shipper','consignee','leg','route','cargo','rate']::text[],
    ARRAY[]::text[],
    ARRAY['поручение экспедитору','поручение (заявка) экспедитору','настоящее поручение направляется','на организацию доставки груза','поручение экспедитору №','транспортно-экспедиционных услуг']::text[],
    ARRAY[9.0, 9.0, 7.0, 6.0, 8.0, 5.0]::numeric(4,2)[],
    'Это ПОРУЧЕНИЕ ЭКСПЕДИТОРУ (поручение/заявка экспедитору на организацию доставки груза). НЕ путай стороны — здесь их четыре:
- client — КЛИЕНТ (он же Заказчик) — тот, кто заказывает экспедирование (грузовладелец). Ищи метку «Клиент»/«Заказчик»/«далее — Клиент». Реквизиты: name, inn, kpp, address, phone.
- expeditor — ЭКСПЕДИТОР — исполнитель поручения, транспортно-экспедиционная компания. Метки «Экспедитор»/«Куда:»/«ТЭК». Реквизиты те же.
- shipper — ГРУЗООТПРАВИТЕЛЬ (может быть иностранный, напр. китайский поставщик).
- consignee — ГРУЗОПОЛУЧАТЕЛЬ.
- carrier — ФАКТИЧЕСКИЙ перевозчик, ТОЛЬКО если явно указан отдельно от экспедитора (часто отсутствует — тогда null).
ВАЖНО: Экспедитор — это НЕ carrier. Клиента НЕ пропускай.
- leg — плечо перевозки: если поручение на одно плечо — укажи air|road|rail|sea (авиа/авто/жд/море), если на весь маршрут — whole_route. Подсказки: «АВИА», «авто», «ж/д», «море», номер рейса/борта → плечо.
- route — loading (точки погрузки: название, адрес, город, дата ISO, контакт), unloading (точки разгрузки аналогично), intermediate_stops. Если точек несколько — массив.
- cargo — наименование, вес брутто/нетто (кг), объём (м³), число мест, упаковка, класс опасности, HS-код.
- rate — ставка/стоимость услуг с валютой, если указана.
- number, date — номер и дата поручения (date в ISO YYYY-MM-DD).
Если поля нет — null.',
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер поручения"},
        "date": {"type": "string", "description": "Дата поручения, YYYY-MM-DD"},
        "leg": {"type": "string", "description": "Плечо: air|road|rail|sea|whole_route"},
        "client": {"type": "object", "description": "Клиент/Заказчик (грузовладелец)", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}, "phone": {"type": "string"}}},
        "expeditor": {"type": "object", "description": "Экспедитор (исполнитель, ТЭК)", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}, "phone": {"type": "string"}}},
        "shipper": {"type": "object", "description": "Грузоотправитель", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "consignee": {"type": "object", "description": "Грузополучатель", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "carrier": {"type": "object", "description": "Фактический перевозчик, если указан отдельно", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}},
        "route": {"type": "object", "properties": {"loading": {"type": "array", "items": {"type": "object"}}, "unloading": {"type": "array", "items": {"type": "object"}}, "intermediate_stops": {"type": "array", "items": {"type": "object"}}}},
        "cargo": {"type": "object", "properties": {"name": {"type": "string"}, "weight_gross_kg": {"type": "number"}, "weight_net_kg": {"type": "number"}, "volume_m3": {"type": "number"}, "places": {"type": "number"}, "packaging": {"type": "string"}, "hs_code": {"type": "string"}, "hazard_class": {"type": "string"}}},
        "rate": {"type": "object", "properties": {"amount": {"type": "number"}, "currency": {"type": "string"}, "description": {"type": "string"}}},
        "order_ref": {"type": "string", "description": "Ссылка на договор/заказ/букинг"}
      },
      "required": ["number"]
    }'::jsonb
);

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug = 'forwarding_order' AND organization_id IS NULL;
COMMIT;
