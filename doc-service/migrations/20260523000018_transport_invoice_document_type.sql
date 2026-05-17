-- Up Migration
--
-- F17 (SLAI ТЗ v1.0): добавляем тип документа `transport_invoice` —
-- транспортная накладная формы 2013 (Постановление Правительства РФ
-- № 272 от 15.04.2011).
--
-- Контекст: с 2013 года эта форма заменила собой ТТН (форма 1-Т) для
-- случаев когда автомобильный перевозчик не является продавцом и нужен
-- отдельный документ перевозки. Старая ТТН (1-Т) продолжает использоваться
-- в учётных пайплайнах но новые контракты на перевозку оформляются
-- через ТН формы 2013.
--
-- Отличия от старой ТТН (см. WAYBILL_SCHEMA и TRANSPORT_INVOICE_SCHEMA
-- в document-json-schemas.ts):
--   - НЕТ товарного раздела (раздел 1 ТТН-1.2)
--   - Графа 8 «Условия перевозки» (температура, опасный груз)
--   - Графа 15 «Стоимость услуг перевозки»
--   - Графы 6 и 7 «Сроки погрузки/выгрузки»
--   - 4 точки подписей (отправитель / водитель-приём / водитель-сдача / получатель)
--
-- Стратегия:
--   - parser_kind = 'llm_extract' — нет regex'ов под форму 2013, только LLM
--   - llm_schema — соответствует TRANSPORT_INVOICE_SCHEMA в коде
--   - classification_keywords — синхронизированы с shared/classifier-rules.json
--     Pattern weight 1.1 > TTN (1.0): если ссылка на «Постановление № 272»
--     встретилась — это точно новая форма, не старая ТТН
--   - validators — стандартные ИНН checksum + date_range + vehicle_plate

INSERT INTO document_types (
    slug,
    display_name,
    description,
    is_builtin,
    is_active,
    parser_kind,
    confidence_threshold,
    regex_fallback_threshold,
    expected_fields,
    validators,
    classification_keywords,
    llm_prompt,
    llm_schema
) VALUES (
    'transport_invoice',
    'Транспортная накладная (форма 2013)',
    'Транспортная накладная формы 2013 — утверждена Пост. Правительства РФ № 272 от 15.04.2011. Заменила ТТН (форма 1-Т) с 2013 года для оформления автоперевозок когда перевозчик не является продавцом. Без товарного раздела. F17 для SLAI ТЗ v1.0.',
    true,
    true,
    'llm_extract',
    0.6,
    0.7,
    ARRAY['number','date','shipper','consignee','carrier','vehicle','driver','loading_point','unloading_point','cargo_summary'],
    ARRAY[
        'inn_checksum:shipper.inn',
        'inn_checksum:consignee.inn',
        'inn_checksum:carrier.inn',
        'date_range:date',
        'vehicle_plate:vehicle.plate'
    ],
    ARRAY[
        'Постановлен\w+\s+Правительства\s+РФ.{0,80}272',
        'приложение\s+№\s*4\s+к\s+Правилам\s+перевозок\s+грузов',
        'условия\s+перевозки.{0,500}стоимость\s+услуг\s+перевозки'
    ],
    'Это транспортная накладная формы 2013 (Постановление Правительства РФ № 272). Отличие от ТТН (форма 1-Т) — нет товарного раздела, груз описан общим описанием. Извлеки:

- Номер и дату транспортной накладной
- Грузоотправителя (графа 1) с реквизитами (ИНН, КПП, адрес)
- Грузополучателя (графа 2) с реквизитами
- Перевозчика (графа 10) с реквизитами
- Плательщика за перевозку если отличается от отправителя
- Описание груза (графа 3) текстом
- Сводные характеристики груза (графа 4): места, масса нетто/брутто, объём, класс опасности
- Условия перевозки (графа 8): температура, влажность, особые отметки
- Заявленную стоимость груза (графа 5)
- Сроки погрузки (графа 6) и выгрузки (графа 7) в ISO формате
- ТС (графы 11+13): госномер тягача (А123БВ77), модель, прицеп
- Водителя: ФИО, серия+номер вод.удостоверения, телефон
- Точку погрузки (графа 6): адрес, город, страна ISO-3166
- Точку разгрузки (графа 7): адрес, город, страна
- Стоимость услуг перевозки (графа 15): сумма, валюта, НДС
- Экспедитора (графа 9) если перевозка через экспедитора
- Прилагаемые документы (графа 16): паспорта, сертификаты, СНТ
- Расстояние перевозки в км

В transport_invoice items[] заполняется ТОЛЬКО если есть приложение
со списком позиций. Обычно груз описан текстом в cargo_description.',
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "format": "date"},
        "shipper": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}}},
        "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}}},
        "carrier": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}}},
        "payer": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}},
        "cargo_description": {"type": "string"},
        "items": {"type": "array", "items": {"type": "object"}},
        "cargo_summary": {
          "type": "object",
          "properties": {
            "places": {"type": "number"},
            "weight_gross": {"type": "number"},
            "weight_nett": {"type": "number"},
            "volume_m3": {"type": "number"},
            "dangerous_class": {"type": "string"}
          }
        },
        "conditions": {
          "type": "object",
          "properties": {
            "temperature_min_c": {"type": "number"},
            "temperature_max_c": {"type": "number"},
            "humidity": {"type": "string"},
            "special_marks": {"type": "string"}
          }
        },
        "declared_value": {"type": "number"},
        "delivery_terms": {
          "type": "object",
          "properties": {
            "pickup_datetime": {"type": "string"},
            "delivery_datetime": {"type": "string"}
          }
        },
        "vehicle": {
          "type": "object",
          "properties": {
            "plate": {"type": "string"}, "model": {"type": "string"},
            "trailer_plate": {"type": "string"}, "trailer_model": {"type": "string"},
            "weight_unladen": {"type": "number"}
          }
        },
        "driver": {
          "type": "object",
          "properties": {"fio": {"type": "string"}, "license": {"type": "string"}, "phone": {"type": "string"}}
        },
        "loading_point": {
          "type": "object",
          "properties": {"address": {"type": "string"}, "city": {"type": "string"}, "country": {"type": "string"}}
        },
        "unloading_point": {
          "type": "object",
          "properties": {"address": {"type": "string"}, "city": {"type": "string"}, "country": {"type": "string"}}
        },
        "service_cost": {
          "type": "object",
          "properties": {
            "amount": {"type": "number"}, "currency": {"type": "string"},
            "vat_rate": {"type": "number"}, "vat_amount": {"type": "number"},
            "amount_with_vat": {"type": "number"}
          }
        },
        "forwarder": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}},
        "transport_docs": {"type": "array", "items": {"type": "string"}},
        "distance_km": {"type": "number"}
      }
    }'::jsonb
) ON CONFLICT (slug) DO NOTHING;

-- Down Migration
DELETE FROM document_types WHERE slug = 'transport_invoice' AND is_builtin = true;
