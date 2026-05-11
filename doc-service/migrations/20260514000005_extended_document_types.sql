-- Расширение каталога builtin-типов документов (CP5).
--
-- К исходным шести (invoice, factInvoice, UPD, TTN, CMR, AKT) добавляем
-- шесть новых типов, покрывающих смежные ниши:
--
--   payment_order        — платёжное поручение (банковский core)
--   commercial_invoice   — международный коммерческий инвойс (ВЭД)
--   packing_list         — упаковочный лист (ВЭД пара к invoice)
--   bill_of_lading       — коносамент / B/L (морская/мульти-модальная)
--   customs_declaration  — ГТД / Декларация на товары (таможня)
--   cash_receipt         — кассовый чек (розница, авансовые отчёты)
--
-- Все шесть — `parser_kind='llm_extract'`. Builtin regex-парсеров под них
-- мы не пишем: документы либо плохо ложатся на regex (таможня, B/L), либо
-- мультиязычные (commercial_invoice), либо мало кому нужны через regex,
-- учитывая что LLM с собственной схемой даёт качественный extract без
-- лишнего кода.
--
-- runtime обработки этих типов идёт через `GenericLlmParser` — он берёт
-- `llm_schema` и `expected_fields` из этой записи в БД, никаких
-- хардкод-схем для них не заводится. Это и есть демонстрация того, что
-- platform-as-product работает: новые типы добавляются миграцией (или
-- админом через UI после деплоя), без правок TypeScript-кода.
--
-- Все шесть помечены `is_builtin=true` — защищены от случайного DELETE
-- через API, но админ может деактивировать или подкрутить любую запись.

-- Up Migration

INSERT INTO document_types (
    slug, display_name, description, is_builtin, is_active, parser_kind,
    expected_fields, validators, classification_keywords,
    confidence_threshold, regex_fallback_threshold,
    llm_schema, llm_prompt
) VALUES

-- ============================================================================
-- 1. Платёжное поручение
-- ============================================================================
(
    'payment_order',
    'Платёжное поручение',
    'Платёжка по форме 0401060. Извлекаем плательщика/получателя (наименование, ИНН, КПП, счёт, БИК, банк), сумму, дату, назначение платежа. Структура жёсткая — модель справляется хорошо.',
    true, true, 'llm_extract',
    ARRAY['number', 'date', 'amount', 'payer.inn', 'payer.account', 'payee.inn', 'payee.account', 'purpose'],
    ARRAY[
        'inn_checksum:payer.inn',
        'inn_checksum:payee.inn',
        'parties_differ:payer.inn,payee.inn',
        'kpp_format:payer.kpp',
        'kpp_format:payee.kpp',
        'money_sanity:amount',
        'date_range'
    ],
    ARRAY[
        'платёжное\s+поручение',
        'платежное\s+поручение',
        '\bП\.?\s*П\.?\s*№',
        'БИК\s*\d{9}',
        'Поступ\.\s+в\s+банк\s+плат\.',
        'Списано\s+со\s+сч\.\s+плат\.'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер платёжного поручения"},
        "date": {"type": "string", "format": "date", "description": "Дата составления"},
        "date_charged": {"type": "string", "format": "date", "description": "Дата списания со счёта плательщика"},
        "amount": {"type": "number", "description": "Сумма цифрами в рублях"},
        "amount_text": {"type": "string", "description": "Сумма прописью"},
        "payment_kind": {"type": "string", "description": "Вид платежа: электронно, телеграфно, почтой"},
        "priority": {"type": "integer", "description": "Очерёдность платежа (1-5)"},
        "payer": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "kpp": {"type": "string"},
            "account": {"type": "string", "description": "Расчётный счёт, 20 цифр"},
            "bic": {"type": "string", "description": "БИК банка плательщика, 9 цифр"},
            "bank_name": {"type": "string"},
            "correspondent_account": {"type": "string"}
          }
        },
        "payee": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "kpp": {"type": "string"},
            "account": {"type": "string"},
            "bic": {"type": "string"},
            "bank_name": {"type": "string"},
            "correspondent_account": {"type": "string"}
          }
        },
        "purpose": {"type": "string", "description": "Назначение платежа целиком, включая текст про НДС"}
      }
    }'::jsonb,
    'Ты — парсер российского платёжного поручения (форма 0401060). Извлекай поля строго по схеме. Особое внимание: ИНН плательщика и получателя — это разные ИНН в одном документе, не путай. БИК — 9 цифр. Расчётный счёт — 20 цифр. Сумму прописью бери целиком как одну строку.'
),

-- ============================================================================
-- 2. Commercial Invoice
-- ============================================================================
(
    'commercial_invoice',
    'Commercial Invoice',
    'Международный коммерческий инвойс для ВЭД. Английский/мультиязычный. Содержит exporter, consignee, позиции с HS-кодами, Incoterms, валюта.',
    true, true, 'llm_extract',
    ARRAY['number', 'date', 'exporter.name', 'consignee.name', 'currency', 'total_amount'],
    ARRAY[
        'country_code:exporter.country',
        'country_code:consignee.country',
        'money_sanity:total_amount',
        'date_range'
    ],
    ARRAY[
        '\bcommercial\s+invoice\b',
        '\bINVOICE\s+No\.?\s*[A-Z0-9-]',
        'Incoterms?\s*[''"]?\s*\d{4}',
        '\bexporter\b.*\bconsignee\b',
        '\bcountry\s+of\s+origin\b'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Invoice number"},
        "date": {"type": "string", "format": "date"},
        "currency": {"type": "string", "description": "ISO-4217 код: USD, EUR, CNY, RUB"},
        "exporter": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "address": {"type": "string"},
            "country": {"type": "string", "description": "ISO-3166 alpha-2 (RU/CN/DE/...)"},
            "tax_id": {"type": "string", "description": "VAT/EORI/ИНН экспортёра"}
          }
        },
        "consignee": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "address": {"type": "string"},
            "country": {"type": "string"},
            "tax_id": {"type": "string"}
          }
        },
        "buyer": {"type": "object", "description": "Если отличается от consignee", "properties": {"name": {"type": "string"}, "address": {"type": "string"}}},
        "incoterms": {"type": "string", "description": "Например EXW Shanghai 2020, DAP Moscow 2020"},
        "payment_terms": {"type": "string", "description": "30 days net, T/T in advance и т.п."},
        "positions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "description": {"type": "string"},
              "hs_code": {"type": "string", "description": "Код ТН ВЭД, 6-10 цифр"},
              "qty": {"type": "number"},
              "unit": {"type": "string", "description": "pcs, kg, m, l..."},
              "unit_price": {"type": "number"},
              "total_price": {"type": "number"},
              "country_of_origin": {"type": "string"},
              "weight_net": {"type": "number"},
              "weight_gross": {"type": "number"}
            }
          }
        },
        "total_amount": {"type": "number"},
        "total_weight_net": {"type": "number"},
        "total_weight_gross": {"type": "number"}
      }
    }'::jsonb,
    'You are parsing a commercial invoice for international trade. Extract fields per schema strictly. Currency is ISO-4217 (USD/EUR/CNY). Countries are ISO-3166 alpha-2 codes. HS codes are 6 to 10 digit numbers. Если документ на русском — отвечай теми же значениями, но коды стран всегда в латинице (RU not РУ).'
),

-- ============================================================================
-- 3. Packing List
-- ============================================================================
(
    'packing_list',
    'Packing List',
    'Упаковочный лист, обычно идёт в комплекте с commercial_invoice. Места, вес нетто/брутто, объём, габариты упаковки.',
    true, true, 'llm_extract',
    ARRAY['number', 'date', 'total_packages', 'total_weight_gross', 'total_weight_net'],
    ARRAY[
        'weight_nett_le_gross',
        'date_range'
    ],
    ARRAY[
        '\bpacking\s+list\b',
        'упаковочный\s+лист',
        'packing\s+specification'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string"},
        "date": {"type": "string", "format": "date"},
        "exporter": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "invoice_number": {"type": "string", "description": "Ссылка на соответствующий commercial invoice"},
        "positions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "description": {"type": "string"},
              "package_type": {"type": "string", "description": "carton, pallet, box, bag"},
              "package_qty": {"type": "integer"},
              "items_per_package": {"type": "number"},
              "qty": {"type": "number"},
              "weight_net": {"type": "number"},
              "weight_gross": {"type": "number"},
              "dimensions": {"type": "string", "description": "LxWxH в см или м"},
              "volume": {"type": "number", "description": "м3"}
            }
          }
        },
        "total_packages": {"type": "integer"},
        "total_weight_net": {"type": "number"},
        "total_weight_gross": {"type": "number"},
        "total_volume": {"type": "number"}
      }
    }'::jsonb,
    NULL
),

-- ============================================================================
-- 4. Bill of Lading
-- ============================================================================
(
    'bill_of_lading',
    'Коносамент (B/L)',
    'Морская/мульти-модальная транспортная накладная. Отправитель, получатель, судно/рейс, порты, контейнеры.',
    true, true, 'llm_extract',
    ARRAY['bl_number', 'date', 'shipper.name', 'consignee.name', 'port_of_loading', 'port_of_discharge'],
    ARRAY[
        'country_code:shipper.country',
        'country_code:consignee.country',
        'date_range'
    ],
    ARRAY[
        '\bbill\s+of\s+lading\b',
        'коносамент',
        '\bB\s*/\s*L\s+No\.?\s+[A-Z0-9-]',
        '\bMaster\s+B/L\b',
        '\bHouse\s+B/L\b'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "bl_number": {"type": "string"},
        "bl_type": {"type": "string", "description": "Master / House / Sea Waybill"},
        "date": {"type": "string", "format": "date"},
        "shipper": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
        "notify_party": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}}},
        "carrier": {"type": "string", "description": "Перевозчик / линия (MAERSK, MSC и т.п.)"},
        "vessel_name": {"type": "string"},
        "voyage_number": {"type": "string"},
        "port_of_loading": {"type": "string"},
        "port_of_discharge": {"type": "string"},
        "place_of_delivery": {"type": "string"},
        "containers": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "container_number": {"type": "string", "description": "4 буквы + 7 цифр (ABCD1234567)"},
              "seal_number": {"type": "string"},
              "type": {"type": "string", "description": "20DV, 40HC, 40RF и т.п."},
              "packages": {"type": "integer"},
              "weight_gross": {"type": "number"},
              "measurement": {"type": "number"}
            }
          }
        },
        "total_packages": {"type": "integer"},
        "total_weight_gross": {"type": "number"},
        "freight_terms": {"type": "string", "description": "Prepaid / Collect / Pre-paid as agreed"}
      }
    }'::jsonb,
    'You are parsing a Bill of Lading. Container numbers strictly follow ISO 6346 format: 4 letters + 7 digits, no spaces. Vessel name + voyage number — separate fields, обычно в одной строке "MSC TINA / 425E". Carrier — это shipping line, не freight forwarder.'
),

-- ============================================================================
-- 5. Таможенная декларация (ГТД / ДТ)
-- ============================================================================
(
    'customs_declaration',
    'Таможенная декларация (ГТД)',
    'Декларация на товары (форма 0014001). Очень структурированный, табличный. Декларант, отправитель/получатель, графа 31 (товары), пошлины.',
    true, true, 'llm_extract',
    ARRAY['declaration_number', 'date', 'declarant.inn', 'declaration_type', 'positions'],
    ARRAY[
        'inn_checksum:declarant.inn',
        'inn_checksum:sender.inn',
        'inn_checksum:recipient.inn',
        'money_sanity:total_value',
        'money_sanity:customs_value',
        'date_range'
    ],
    ARRAY[
        '\bдекларация\s+на\s+товары\b',
        '\bГТД\b',
        '\bДТ\s*№?\s*\d{8}',
        'грузовая\s+таможенная\s+декларация',
        '\bТД\s*-?\s*[ИЭ]К\d'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "declaration_number": {"type": "string", "description": "Регномер формата XXXXXXXX/DDMMYY/XXXXXXX"},
        "date": {"type": "string", "format": "date"},
        "declaration_type": {"type": "string", "description": "ИМ40, ЭК10 и т.п."},
        "procedure_code": {"type": "string"},
        "declarant": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}}},
        "sender": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "country": {"type": "string"}, "address": {"type": "string"}}},
        "recipient": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "country": {"type": "string"}, "address": {"type": "string"}}},
        "trading_country": {"type": "string", "description": "Графа 11"},
        "origin_country": {"type": "string", "description": "Графа 16"},
        "destination_country": {"type": "string", "description": "Графа 17"},
        "transport_mode": {"type": "string", "description": "Код вида транспорта на границе (Графа 25)"},
        "currency": {"type": "string"},
        "total_value": {"type": "number", "description": "Общая стоимость по инвойсу"},
        "customs_value": {"type": "number", "description": "Таможенная стоимость"},
        "exchange_rate": {"type": "number"},
        "positions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "number": {"type": "integer", "description": "Порядковый номер товара (Графа 32)"},
              "description": {"type": "string"},
              "hs_code": {"type": "string", "description": "Код ТН ВЭД, 10 цифр"},
              "country_of_origin": {"type": "string"},
              "gross_weight": {"type": "number"},
              "net_weight": {"type": "number"},
              "qty": {"type": "number"},
              "unit": {"type": "string"},
              "invoice_value": {"type": "number"},
              "customs_value": {"type": "number"},
              "statistical_value": {"type": "number"}
            }
          }
        },
        "duties": {
          "type": "array",
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
        }
      }
    }'::jsonb,
    'Ты — парсер российской декларации на товары (ДТ, бывшая ГТД). Регномер декларации имеет жёсткий формат: пост ФТС/дата/порядковый. Коды ТН ВЭД — 10 цифр. Виды платежей: 1010 (сбор), 2010 (пошлина), 5010 (НДС). Графа 31 — товары, может быть много страниц.'
),

-- ============================================================================
-- 6. Кассовый чек
-- ============================================================================
(
    'cash_receipt',
    'Кассовый чек',
    'Чек ККТ онлайн-кассы (54-ФЗ). ФН/ФД/ФП, продавец, позиции, способ оплаты. Применяется в авансовых отчётах и розничной верификации.',
    true, true, 'llm_extract',
    ARRAY['merchant.name', 'merchant.inn', 'date_time', 'total', 'fn_number'],
    ARRAY[
        'inn_checksum:merchant.inn',
        'money_sanity:total',
        'date_range'
    ],
    ARRAY[
        '\bкассовый\s+чек\b',
        '\bФН\s+\d{16}',
        '\bФД\s+\d',
        '\bФПД?\b\s*\d',
        '\bКАССА\b',
        'ИТОГ\b.*\d',
        '54-ФЗ'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "merchant": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "address": {"type": "string"},
            "store_id": {"type": "string"}
          }
        },
        "check_number": {"type": "string", "description": "Порядковый номер чека (смены/документа)"},
        "shift_number": {"type": "string"},
        "date_time": {"type": "string", "description": "Дата и время в формате YYYY-MM-DD HH:MM"},
        "cashier_name": {"type": "string"},
        "fn_number": {"type": "string", "description": "Номер фискального накопителя, 16 цифр"},
        "fd_number": {"type": "string", "description": "Номер фискального документа"},
        "fp": {"type": "string", "description": "Фискальный признак документа, 10 цифр"},
        "kkt_serial": {"type": "string", "description": "Заводской номер ККТ"},
        "ofd_name": {"type": "string", "description": "Название ОФД"},
        "positions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string"},
              "qty": {"type": "number"},
              "unit": {"type": "string"},
              "price": {"type": "number"},
              "total": {"type": "number"},
              "vat_rate": {"type": "string", "description": "20%, 10%, 0%, без НДС"},
              "vat_amount": {"type": "number"}
            }
          }
        },
        "total": {"type": "number"},
        "vat_amount": {"type": "number"},
        "payment_method": {"type": "string", "description": "НАЛИЧНЫМИ / БЕЗНАЛИЧНЫМИ / СМЕШАННАЯ"},
        "payment_cash": {"type": "number"},
        "payment_card": {"type": "number"},
        "check_type": {"type": "string", "description": "Приход / Возврат прихода / Расход"}
      }
    }'::jsonb,
    'Ты — парсер кассового чека ККТ (54-ФЗ). Обязательно ищи и извлекай ФН (16 цифр), ФД (порядковый номер) и ФП (10 цифр) — это идентификаторы чека в системе ОФД, по ним проверяется подлинность. Дата и время — обычно в одной строке. Признак расчёта (приход/возврат) на одной из верхних строк чека.'
)
ON CONFLICT (slug) DO NOTHING;

-- Down Migration

DELETE FROM document_types WHERE slug IN (
    'payment_order',
    'commercial_invoice',
    'packing_list',
    'bill_of_lading',
    'customs_declaration',
    'cash_receipt'
);
