-- Up Migration
--
-- F16 (SLAI ТЗ v1.0): добавляем тип документа `transport_request` —
-- заявка на перевозку. Документ-первичка между заказчиком логистики и
-- перевозчиком/экспедитором, фиксирующий договорённости ДО фактической
-- перевозки (что везём, откуда-куда, какой машиной/водителем, в какие
-- сроки, за какую ставку).
--
-- Особенности:
-- - На «открытом рынке» vehicle/driver могут быть NULL — перевозчик
--   подбирает машину после акцепта заявки
-- - Multi-stop: route.loading и route.unloading могут быть массивами
-- - Часто содержит спец. температурный режим (рефрижератор), класс ADR
-- - Связан с parent_contract_number (договор-основание)
--
-- См. SLAI ТЗ v1.0 раздел 3.2 для acceptance критериев.

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
    'transport_request',
    'Заявка на перевозку',
    'Заявка на перевозку — документ-первичка между заказчиком логистики и перевозчиком/экспедитором, фиксирующий договорённости ДО фактической перевозки (груз, маршрут, ТС, водитель, сроки, ставка). На открытом рынке vehicle/driver могут быть NULL. F16 для SLAI ТЗ v1.0.',
    true,
    true,
    'llm_extract',
    0.6,
    0.7,
    ARRAY['number','date','client','carrier','route','cargo','rate'],
    ARRAY[
        'inn_checksum:client.inn',
        'inn_checksum:carrier.inn',
        'date_range:date',
        'vehicle_plate:vehicle.plate'
    ],
    ARRAY[
        'заявка\s+(?:№|на\s+перевозку|на\s+транспортные\s+услуги|на\s+автоперевозку)',
        'заявка-договор\s+на\s+перевозку'
    ],
    'Это заявка на перевозку. Договорённость заказчика с перевозчиком ДО рейса. Извлеки:

- Номер и дату заявки
- Заказчика (client) — грузовладелец, с реквизитами ИНН/КПП/адрес/телефон
- Перевозчика (carrier) — исполнитель, с реквизитами
- Маршрут:
  - loading: точка(и) погрузки — название склада/площадки, адрес, город, datetime в ISO, контакт+телефон
    NB: если несколько точек погрузки — отдай массив объектов
  - unloading: точка(и) разгрузки — аналогично
  - intermediate_stops: промежуточные остановки если есть
- Груз (cargo): наименование, масса в тоннах, объём в м³, мест (паллет/коробов),
  температурный режим как в документе ("+4°C ÷ +6°C"), класс ADR/ДОПОГ если опасный
- ТС (vehicle): plate (А123АА777), model, vin, year, capacity_t.
  ВАЖНО: на открытом рынке vehicle может быть NULL — оставь поле пустым если в заявке не указано
- Прицеп (trailer): plate, model, type ("изотерм"/"рефрижератор"/"тент"), объём
- Водитель (driver): ФИО, вод.удостоверение, паспорт, телефон.
  ВАЖНО: тоже может быть NULL на открытом рынке
- Ставка (rate): сумма, валюта ISO 4217, vat_included (bool), vat_rate (число),
  payment_terms как написано ("Безнал, 10 банковских дней", "100% предоплата")
- additional_terms: доп. условия / штрафы текстом
- contact_responsible: ответственный логист со стороны заказчика
- parent_contract_number, parent_contract_date — договор-основание',
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "format": "date"},
        "client": {
          "type": "object",
          "properties": {
            "name": {"type": "string"}, "inn": {"type": "string"},
            "kpp": {"type": "string"}, "address": {"type": "string"},
            "phone": {"type": "string"}
          }
        },
        "carrier": {
          "type": "object",
          "properties": {
            "name": {"type": "string"}, "inn": {"type": "string"},
            "kpp": {"type": "string"}, "address": {"type": "string"},
            "phone": {"type": "string"}
          }
        },
        "route": {
          "type": "object",
          "properties": {
            "loading": {
              "type": ["object", "array"],
              "properties": {
                "name": {"type": "string"}, "address": {"type": "string"},
                "city": {"type": "string"}, "datetime": {"type": "string"},
                "contact": {"type": "string"}
              }
            },
            "unloading": {
              "type": ["object", "array"],
              "properties": {
                "name": {"type": "string"}, "address": {"type": "string"},
                "city": {"type": "string"}, "datetime": {"type": "string"},
                "contact": {"type": "string"}
              }
            },
            "intermediate_stops": {"type": "array", "items": {"type": "object"}}
          }
        },
        "cargo": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "weight_t": {"type": "number"},
            "volume_m3": {"type": "number"},
            "places": {"type": "number"},
            "temperature": {"type": "string"},
            "dangerous_class": {"type": "string"},
            "customs_info": {"type": "string"}
          }
        },
        "vehicle": {
          "type": "object",
          "properties": {
            "plate": {"type": "string"}, "model": {"type": "string"},
            "vin": {"type": "string"}, "year": {"type": "number"},
            "capacity_t": {"type": "number"}
          }
        },
        "trailer": {
          "type": "object",
          "properties": {
            "plate": {"type": "string"}, "model": {"type": "string"},
            "type": {"type": "string"}, "volume_m3": {"type": "number"}
          }
        },
        "driver": {
          "type": "object",
          "properties": {
            "fio": {"type": "string"}, "license": {"type": "string"},
            "passport": {"type": "string"}, "phone": {"type": "string"}
          }
        },
        "rate": {
          "type": "object",
          "properties": {
            "amount": {"type": "number"}, "currency": {"type": "string"},
            "vat_included": {"type": "boolean"}, "vat_rate": {"type": "number"},
            "payment_terms": {"type": "string"}
          }
        },
        "additional_terms": {"type": "string"},
        "contact_responsible": {
          "type": "object",
          "properties": {
            "fio": {"type": "string"}, "phone": {"type": "string"},
            "email": {"type": "string"}
          }
        },
        "parent_contract_number": {"type": "string"},
        "parent_contract_date": {"type": "string"}
      }
    }'::jsonb
) ON CONFLICT (slug) DO NOTHING;

-- Down Migration
DELETE FROM document_types WHERE slug = 'transport_request' AND is_builtin = true;
