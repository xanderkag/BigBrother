-- Up Migration
--
-- Phase A v2 для DB-seeded типов: апгрейд llm_schema до канонического items[]
-- с 19 полями на строку. Унифицирует имя массива (positions → items) и
-- расширяет shape под реальные потребности учёта.
--
-- Затронуто 6 типов:
--   commercial_invoice         (positions[9] → items[19+])
--   packing_list               (positions[9] → items[19+package_type/dimensions/volume])
--   customs_declaration        (positions[11] → items[19+invoice_value/customs_value/statistical_value])
--   cash_receipt               (positions[7] → items[19])
--   contract_specification     (positions[10] → items[19+delivery_term])
--   bill_of_lading             (нет positions → добавлен items[19+marks_and_numbers])
--
-- payment_order, contract, contract_addendum — пропущены: документы без
-- табличной части или со специфической структурой, items[] не имеет смысла.
--
-- expected_fields: 'positions' → 'items' для двух типов где он явно был.
--
-- Backward-compat: jobs обработанные до миграции содержат extracted с
-- `positions[]`. normalize-extracted.ts на read-пути копирует в `items[]`,
-- так что старые data в UI отображаются без проблем.
--
-- Down migration возвращает schemas из 0005/0006 (post-seed state). Если
-- админ правил схему через UI после 0005/0006 и хочет откатиться к своему
-- кастому — нужно делать через UI вручную.

-- ============================================================================
-- commercial_invoice
-- ============================================================================
UPDATE document_types SET llm_schema = '{
  "type": "object",
  "properties": {
    "number": {"type": "string", "description": "Номер инвойса"},
    "date": {"type": "string", "format": "date"},
    "currency": {"type": "string", "description": "Валюта инвойса (ISO 4217)"},
    "exchange_rate": {"type": "number", "description": "Курс к валюте учёта"},
    "incoterms": {"type": "string", "description": "Incoterms (EXW, FCA, CIF, DAP, ...)"},
    "place_of_delivery": {"type": "string"},
    "port_of_loading": {"type": "string"},
    "port_of_discharge": {"type": "string"},
    "shipper": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
    "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
    "notify_party": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
    "total_value": {"type": "number", "description": "Общая стоимость по инвойсу"},
    "total_weight_net": {"type": "number"},
    "total_weight_gross": {"type": "number"},
    "total_packages": {"type": "integer"},
    "items": {
      "type": "array",
      "description": "Строки коммерческого инвойса",
      "items": {
        "type": "object",
        "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string", "description": "Артикул/код товара"},
          "barcode": {"type": "string"},
          "name": {"type": "string", "description": "Описание товара"},
          "hs_code": {"type": "string", "description": "Код ТН ВЭД (10 цифр РФ / 8 цифр ЕС)"},
          "country_of_origin": {"type": "string"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number"},
          "weight_gross": {"type": "number"},
          "price": {"type": "number", "description": "Цена за единицу"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"}
        }
      }
    }
  }
}'::jsonb,
expected_fields = ARRAY['number', 'date', 'shipper', 'consignee', 'total_value', 'items']
WHERE slug = 'commercial_invoice';

-- ============================================================================
-- packing_list — items + специфика упаковочного листа (package_type, volume)
-- ============================================================================
UPDATE document_types SET llm_schema = '{
  "type": "object",
  "properties": {
    "number": {"type": "string"},
    "date": {"type": "string", "format": "date"},
    "invoice_reference": {"type": "string", "description": "Ссылка на связанный инвойс"},
    "shipper": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
    "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
    "total_packages": {"type": "integer"},
    "total_weight_net": {"type": "number"},
    "total_weight_gross": {"type": "number"},
    "total_volume": {"type": "number"},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string"},
          "barcode": {"type": "string"},
          "name": {"type": "string"},
          "hs_code": {"type": "string"},
          "country_of_origin": {"type": "string"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number", "description": "Количество мест"},
          "weight_net": {"type": "number"},
          "weight_gross": {"type": "number"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"},
          "package_type": {"type": "string", "description": "Тип упаковки (коробка, паллета, мешок)"},
          "dimensions": {"type": "string", "description": "Размеры одного места (L×W×H)"},
          "volume": {"type": "number", "description": "Объём одной упаковки, м³"}
        }
      }
    }
  }
}'::jsonb,
expected_fields = ARRAY['number', 'date', 'shipper', 'consignee', 'total_packages', 'items']
WHERE slug = 'packing_list';

-- ============================================================================
-- customs_declaration — items + специфика ГТД (invoice_value/customs_value/statistical_value)
-- ============================================================================
UPDATE document_types SET llm_schema = '{
  "type": "object",
  "properties": {
    "declaration_number": {"type": "string", "description": "Регистрационный номер ДТ (Графа 7)"},
    "declaration_type": {"type": "string", "description": "Тип декларации (Графа 1: ЭК, ИМ, ...)"},
    "date": {"type": "string", "format": "date"},
    "declarant": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "country": {"type": "string"}, "address": {"type": "string"}}},
    "sender": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "country": {"type": "string"}, "address": {"type": "string"}}},
    "recipient": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "country": {"type": "string"}, "address": {"type": "string"}}},
    "trading_country": {"type": "string", "description": "Графа 11"},
    "currency": {"type": "string", "description": "Валюта (Графа 22)"},
    "exchange_rate": {"type": "number", "description": "Курс валюты (Графа 23)"},
    "transport_mode": {"type": "string", "description": "Код вида транспорта на границе (Графа 25)"},
    "procedure_code": {"type": "string", "description": "Код процедуры (Графа 37)"},
    "total_amount": {"type": "number"},
    "total_weight_net": {"type": "number"},
    "total_weight_gross": {"type": "number"},
    "items": {
      "type": "array",
      "description": "Товарные позиции декларации",
      "items": {
        "type": "object",
        "properties": {
          "line_no": {"type": "integer", "description": "Номер товара (Графа 32)"},
          "code": {"type": "string"},
          "barcode": {"type": "string"},
          "name": {"type": "string", "description": "Описание товара (Графа 31)"},
          "hs_code": {"type": "string", "description": "Код ТН ВЭД (Графа 33), 10 цифр"},
          "country_of_origin": {"type": "string", "description": "Страна происхождения (Графа 34)"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number", "description": "Вес нетто (Графа 38)"},
          "weight_gross": {"type": "number", "description": "Вес брутто (Графа 35)"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"},
          "invoice_value": {"type": "number", "description": "Стоимость по инвойсу (Графа 42)"},
          "customs_value": {"type": "number", "description": "Таможенная стоимость (Графа 45)"},
          "statistical_value": {"type": "number", "description": "Статистическая стоимость (Графа 46)"}
        }
      }
    }
  }
}'::jsonb,
expected_fields = ARRAY['declaration_number', 'date', 'declarant.inn', 'declaration_type', 'items']
WHERE slug = 'customs_declaration';

-- ============================================================================
-- cash_receipt
-- ============================================================================
UPDATE document_types SET llm_schema = '{
  "type": "object",
  "properties": {
    "fn_number": {"type": "string", "description": "Номер ФН (фискального накопителя)"},
    "fd_number": {"type": "string", "description": "Номер ФД"},
    "fpd": {"type": "string", "description": "Фискальный признак"},
    "shift_number": {"type": "string"},
    "receipt_number": {"type": "string"},
    "date": {"type": "string", "format": "date"},
    "time": {"type": "string"},
    "merchant": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "address": {"type": "string"}}},
    "operation_kind": {"type": "string", "description": "Приход / возврат прихода / расход / возврат расхода"},
    "payment_method": {"type": "string", "description": "Наличные / безналичные / предоплата / постоплата"},
    "total": {"type": "number"},
    "vat_amount": {"type": "number"},
    "vat_rate": {"type": "number"},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string"},
          "barcode": {"type": "string"},
          "name": {"type": "string"},
          "hs_code": {"type": "string"},
          "country_of_origin": {"type": "string"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number"},
          "weight_gross": {"type": "number"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"}
        }
      }
    }
  }
}'::jsonb,
expected_fields = ARRAY['date', 'merchant.inn', 'total', 'items']
WHERE slug = 'cash_receipt';

-- ============================================================================
-- contract_specification
-- ============================================================================
UPDATE document_types SET llm_schema = '{
  "type": "object",
  "properties": {
    "number": {"type": "string"},
    "date": {"type": "string", "format": "date"},
    "parent_contract_number": {"type": "string"},
    "parent_contract_date": {"type": "string", "format": "date"},
    "seller": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}}},
    "buyer": {"type": "object", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}, "kpp": {"type": "string"}, "address": {"type": "string"}}},
    "currency": {"type": "string"},
    "total_amount": {"type": "number"},
    "vat": {"type": "number"},
    "vat_rate": {"type": "number"},
    "delivery_terms": {"type": "string"},
    "payment_terms": {"type": "string"},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string"},
          "barcode": {"type": "string"},
          "name": {"type": "string"},
          "hs_code": {"type": "string"},
          "country_of_origin": {"type": "string"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number"},
          "weight_gross": {"type": "number"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"},
          "delivery_term": {"type": "string", "description": "Срок поставки по этой позиции"}
        }
      }
    }
  }
}'::jsonb,
expected_fields = ARRAY['number', 'date', 'parent_contract_number', 'parent_contract_date', 'items', 'total_amount']
WHERE slug = 'contract_specification';

-- ============================================================================
-- bill_of_lading — добавляем items[] (раньше не было; B/L бывают с несколькими лотами)
-- ============================================================================
UPDATE document_types SET llm_schema = '{
  "type": "object",
  "properties": {
    "bl_number": {"type": "string", "description": "Номер коносамента"},
    "date": {"type": "string", "format": "date"},
    "shipper": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
    "consignee": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
    "notify_party": {"type": "object", "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}},
    "vessel_name": {"type": "string"},
    "voyage_number": {"type": "string"},
    "carrier": {"type": "string"},
    "port_of_loading": {"type": "string"},
    "port_of_discharge": {"type": "string"},
    "place_of_receipt": {"type": "string"},
    "place_of_delivery": {"type": "string"},
    "freight_payable": {"type": "string", "description": "Кто платит фрахт: prepaid / collect"},
    "freight_amount": {"type": "number"},
    "currency": {"type": "string"},
    "incoterms": {"type": "string"},
    "items": {
      "type": "array",
      "description": "Грузовые места / лоты по коносаменту",
      "items": {
        "type": "object",
        "properties": {
          "line_no": {"type": "integer"},
          "code": {"type": "string"},
          "barcode": {"type": "string"},
          "name": {"type": "string", "description": "Описание груза"},
          "hs_code": {"type": "string"},
          "country_of_origin": {"type": "string"},
          "unit": {"type": "string"},
          "qty": {"type": "number"},
          "qty_per_package": {"type": "number"},
          "packages": {"type": "number"},
          "weight_net": {"type": "number"},
          "weight_gross": {"type": "number"},
          "price": {"type": "number"},
          "vat_rate": {"type": "number"},
          "vat_amount": {"type": "number"},
          "total_without_vat": {"type": "number"},
          "total_with_vat": {"type": "number"},
          "currency": {"type": "string"},
          "notes": {"type": "string"},
          "marks_and_numbers": {"type": "string", "description": "Маркировка и номера (стандартная графа B/L)"},
          "container_number": {"type": "string"}
        }
      }
    }
  }
}'::jsonb,
expected_fields = ARRAY['bl_number', 'date', 'shipper', 'consignee', 'port_of_loading', 'port_of_discharge', 'items']
WHERE slug = 'bill_of_lading';

-- Down Migration
--
-- Возвращаем schemas в состояние post-0005/0006 (исходные positions-варианты).
-- ВАЖНО: если админ редактировал schemas через UI после миграции 0015, его
-- изменения будут потеряны. Для безопасного отката сначала вытянуть текущий
-- llm_schema через GET /document-types/:slug.

UPDATE document_types SET
  llm_schema = '{"type":"object","properties":{"number":{"type":"string"},"date":{"type":"string","format":"date"},"currency":{"type":"string"},"shipper":{"type":"object","properties":{"name":{"type":"string"},"address":{"type":"string"},"country":{"type":"string"}}},"consignee":{"type":"object","properties":{"name":{"type":"string"},"address":{"type":"string"},"country":{"type":"string"}}},"total_value":{"type":"number"},"positions":{"type":"array","items":{"type":"object","properties":{"description":{"type":"string"},"hs_code":{"type":"string"},"qty":{"type":"number"},"unit":{"type":"string"},"unit_price":{"type":"number"},"total_price":{"type":"number"},"country_of_origin":{"type":"string"},"weight_net":{"type":"number"},"weight_gross":{"type":"number"}}}}}}'::jsonb,
  expected_fields = ARRAY['number', 'date', 'shipper', 'consignee', 'total_value']
WHERE slug = 'commercial_invoice';

UPDATE document_types SET
  llm_schema = '{"type":"object","properties":{"number":{"type":"string"},"date":{"type":"string","format":"date"},"invoice_reference":{"type":"string"},"shipper":{"type":"object","properties":{"name":{"type":"string"}}},"consignee":{"type":"object","properties":{"name":{"type":"string"}}},"total_packages":{"type":"integer"},"total_weight_net":{"type":"number"},"total_weight_gross":{"type":"number"},"total_volume":{"type":"number"},"positions":{"type":"array","items":{"type":"object","properties":{"description":{"type":"string"},"package_type":{"type":"string"},"package_qty":{"type":"number"},"items_per_package":{"type":"number"},"qty":{"type":"number"},"weight_net":{"type":"number"},"weight_gross":{"type":"number"},"dimensions":{"type":"string"},"volume":{"type":"number"}}}}}}'::jsonb,
  expected_fields = ARRAY['number', 'date', 'shipper', 'consignee', 'total_packages']
WHERE slug = 'packing_list';

UPDATE document_types SET
  llm_schema = '{"type":"object","properties":{"declaration_number":{"type":"string"},"declaration_type":{"type":"string"},"date":{"type":"string","format":"date"},"declarant":{"type":"object","properties":{"name":{"type":"string"},"inn":{"type":"string"}}},"trading_country":{"type":"string","description":"Графа 11"},"currency":{"type":"string"},"transport_mode":{"type":"string","description":"Код вида транспорта на границе (Графа 25)"},"procedure_code":{"type":"string"},"total_amount":{"type":"number"},"positions":{"type":"array","items":{"type":"object","properties":{"number":{"type":"integer"},"description":{"type":"string"},"hs_code":{"type":"string"},"country_of_origin":{"type":"string"},"gross_weight":{"type":"number"},"net_weight":{"type":"number"},"qty":{"type":"number"},"unit":{"type":"string"},"invoice_value":{"type":"number"},"customs_value":{"type":"number"},"statistical_value":{"type":"number"}}}}}}'::jsonb,
  expected_fields = ARRAY['declaration_number', 'date', 'declarant.inn', 'declaration_type', 'positions']
WHERE slug = 'customs_declaration';

UPDATE document_types SET
  llm_schema = '{"type":"object","properties":{"fn_number":{"type":"string"},"fd_number":{"type":"string"},"fpd":{"type":"string"},"shift_number":{"type":"string"},"receipt_number":{"type":"string"},"date":{"type":"string","format":"date"},"time":{"type":"string"},"merchant":{"type":"object","properties":{"name":{"type":"string"},"inn":{"type":"string"},"address":{"type":"string"}}},"operation_kind":{"type":"string"},"payment_method":{"type":"string"},"total":{"type":"number"},"vat_amount":{"type":"number"},"positions":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"qty":{"type":"number"},"unit":{"type":"string"},"price":{"type":"number"},"total":{"type":"number"},"vat_rate":{"type":"number"},"vat_amount":{"type":"number"}}}}}}'::jsonb,
  expected_fields = ARRAY['date', 'merchant.inn', 'total', 'positions']
WHERE slug = 'cash_receipt';

UPDATE document_types SET
  llm_schema = '{"type":"object","properties":{"number":{"type":"string"},"date":{"type":"string","format":"date"},"parent_contract_number":{"type":"string"},"parent_contract_date":{"type":"string","format":"date"},"seller":{"type":"object","properties":{"name":{"type":"string"},"inn":{"type":"string"}}},"buyer":{"type":"object","properties":{"name":{"type":"string"},"inn":{"type":"string"}}},"currency":{"type":"string"},"total_amount":{"type":"number"},"vat":{"type":"number"},"vat_rate":{"type":"number"},"delivery_terms":{"type":"string"},"payment_terms":{"type":"string"},"positions":{"type":"array","items":{"type":"object","properties":{"number":{"type":"integer"},"name":{"type":"string"},"code":{"type":"string"},"unit":{"type":"string"},"qty":{"type":"number"},"price":{"type":"number"},"total":{"type":"number"},"vat_rate":{"type":"number"},"vat_amount":{"type":"number"},"delivery_term":{"type":"string"}}}}}}'::jsonb,
  expected_fields = ARRAY['number', 'date', 'parent_contract_number', 'parent_contract_date', 'positions', 'total_amount']
WHERE slug = 'contract_specification';

-- bill_of_lading в 0005 не имел positions/items, возвращаем к этому состоянию
UPDATE document_types SET
  llm_schema = '{"type":"object","properties":{"bl_number":{"type":"string"},"date":{"type":"string","format":"date"},"shipper":{"type":"object","properties":{"name":{"type":"string"}}},"consignee":{"type":"object","properties":{"name":{"type":"string"}}},"notify_party":{"type":"object","properties":{"name":{"type":"string"}}},"vessel_name":{"type":"string"},"voyage_number":{"type":"string"},"carrier":{"type":"string"},"port_of_loading":{"type":"string"},"port_of_discharge":{"type":"string"},"place_of_receipt":{"type":"string"},"place_of_delivery":{"type":"string"},"freight_payable":{"type":"string"},"incoterms":{"type":"string"}}}'::jsonb,
  expected_fields = ARRAY['bl_number', 'date', 'shipper', 'consignee', 'port_of_loading', 'port_of_discharge']
WHERE slug = 'bill_of_lading';
