-- Up Migration
--
-- F18 (SLAI ТЗ v1.0): добавляем тип документа `waybill` — путевой лист.
--
-- Контекст: SLAI запросили 10 типов документов в Фазе 1 интеграции.
-- Большинство (invoice, UPD, TTN, AKT, payment_order, factInvoice, CMR)
-- уже есть. `waybill` — новый, в Фазе 1 запланирован на Неделю 6.
--
-- Путевой лист — документ для водителя, подтверждающий выезд ТС на маршрут.
-- Формы: 4-С (грузовой), 4-П (легковой), ПЛ-1 (такси). Содержит маршрут,
-- расход топлива, медосмотр водителя, техосмотр ТС. Не имеет товарной
-- части (груз указывается общим объёмом без перечисления позиций).
--
-- Стратегия:
-- - `parser_kind = 'llm_extract'` — нет regex'ов под путевой лист, LLM
-- - `llm_schema` — копия WAYBILL_SCHEMA из document-json-schemas.ts
-- - `classification_keywords` — синхронизированы с shared/classifier-rules.json
-- - `validators` — стандартные ИНН checksum + date_range
-- - `confidence_threshold` = 0.6 (нижний порог acceptance)
-- - `regex_fallback_threshold` = не применим (LLM путь)

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
    'waybill',
    'Путевой лист',
    'Путевой лист водителя (формы 4-С грузовой, 4-П легковой, ПЛ-1 такси). Подтверждает выезд ТС на маршрут, маршрут, расход топлива, медосмотр водителя и техосмотр ТС. Не содержит товарной части — груз указывается общим объёмом, без перечисления позиций. F18 для SLAI ТЗ v1.0.',
    true,                                                    -- builtin
    true,                                                    -- активен
    'llm_extract',                                           -- через LLM (нет regex)
    0.6,                                                     -- confidence_threshold
    0.7,                                                     -- regex_fallback (не применим, но для соответствия NOT NULL)
    ARRAY['number','date','organization','vehicle','driver','route','odometer_start'],
    ARRAY[
        'inn_checksum:organization.inn',
        'date_range:date',
        'vehicle_plate:vehicle.plate'
    ],
    ARRAY[
        '\bпутевой\s+лист\b',
        'форма\s+4-С',
        'форма\s+4-П',
        'форма\s+ПЛ-1'
    ],
    -- llm_prompt: специфические инструкции для путевого листа
    'Это путевой лист водителя. Извлеки:
- Номер и дату путевого листа
- Форму (4-С грузовой / 4-П легковой / ПЛ-1 такси)
- Организацию-владельца ТС с реквизитами (ИНН, КПП, адрес)
- ТС: госномер (А123БВ77), марку, тип, VIN
- Прицеп если есть
- Водителя: ФИО, вод.удостоверение, табельный номер
- Маршрут: откуда, куда, промежуточные остановки, цель
- Время выезда и возврата
- Показания спидометра при выезде и возврате, пробег
- Топливо: тип, норма расхода, выдано, остатки, факт расход
- Предрейсовый медосмотр (passed, время, ФИО медработника)
- Предрейсовый техосмотр (passed, время, ФИО механика)
- Описание груза и общий вес (если указано)

В путевом листе НЕ должно быть items[] — это не накладная.',
    -- llm_schema: см. WAYBILL_SCHEMA в document-json-schemas.ts
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "format": "date"},
        "form": {"type": "string"},
        "organization": {
          "type": "object",
          "properties": {
            "name": {"type": "string"}, "inn": {"type": "string"},
            "kpp": {"type": "string"}, "address": {"type": "string"}
          }
        },
        "vehicle": {
          "type": "object",
          "properties": {
            "plate": {"type": "string"}, "model": {"type": "string"},
            "type": {"type": "string"}, "vin": {"type": "string"},
            "registration_certificate": {"type": "string"}
          }
        },
        "trailer": {
          "type": "object",
          "properties": {"plate": {"type": "string"}, "model": {"type": "string"}}
        },
        "driver": {
          "type": "object",
          "properties": {
            "fio": {"type": "string"}, "license": {"type": "string"},
            "tab_number": {"type": "string"}, "passport": {"type": "string"}
          }
        },
        "route": {
          "type": "object",
          "properties": {
            "departure_point": {"type": "string"},
            "destination_point": {"type": "string"},
            "intermediate_stops": {"type": "array", "items": {"type": "string"}},
            "purpose": {"type": "string"}
          }
        },
        "departure_time": {"type": "string"},
        "return_time": {"type": "string"},
        "odometer_start": {"type": "number"},
        "odometer_end": {"type": "number"},
        "distance_total": {"type": "number"},
        "fuel": {
          "type": "object",
          "properties": {
            "fuel_type": {"type": "string"},
            "rate_per_100km": {"type": "number"},
            "issued_volume": {"type": "number"},
            "remaining_start": {"type": "number"},
            "remaining_end": {"type": "number"},
            "consumed_volume": {"type": "number"}
          }
        },
        "medical_check": {
          "type": "object",
          "properties": {
            "passed": {"type": "boolean"}, "timestamp": {"type": "string"},
            "doctor_signature": {"type": "string"}
          }
        },
        "technical_check": {
          "type": "object",
          "properties": {
            "passed": {"type": "boolean"}, "timestamp": {"type": "string"},
            "mechanic_signature": {"type": "string"}
          }
        },
        "cargo_description": {"type": "string"},
        "cargo_weight": {"type": "number"},
        "notes": {"type": "string"}
      }
    }'::jsonb
) ON CONFLICT (slug) DO NOTHING;
-- ON CONFLICT — на случай если миграция уже была применена через
-- другой механизм (например, ручное seed). Идемпотентна.

-- Down Migration
DELETE FROM document_types WHERE slug = 'waybill' AND is_builtin = true;
