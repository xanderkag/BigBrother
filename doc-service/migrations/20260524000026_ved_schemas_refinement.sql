-- Up Migration
--
-- Schema refinement для VED-типов из real-кейса EWL/ANJI MINGPAI.
-- Закрывает 3 пробела из FINAL_VED_FIXES_2026-05-18.md:
--
-- #1 Contract llm_schema — упрощение
--    Старая schema (20+ nested полей с party_a/party_b банковскими
--    реквизитами) перегружала Qwen 32B, ответ был {}. Оставляем top-12
--    fields без deep nesting. Reps/banks выносим в отдельные плоские
--    поля чтобы Qwen легче с ними справился.
--
-- #2 llm_schema для weighing_act / EAC / price_list / proforma_invoice /
--    cert_of_origin / wire_transfer_application
--    Сейчас NULL → Qwen работает только через llm_prompt (свободный текст).
--    Для большинства это OK, но без явной schema модель иногда пропускает
--    nested поля. Добавляем JSON Schema для structured extract.
--
-- #5 Country ISO-2 в LLM-промптах
--    На BoL Qwen выдал country: "China"/"Russia" вместо "CN"/"RU".
--    Validation сказала needs_review. Добавляем явную инструкцию во все
--    VED-промпты: «country — ISO 3166 alpha-2 (CN/RU/US/...)».

BEGIN;

-- ── #1 Contract — упрощённая schema (top 12 fields, no deep nesting) ─

UPDATE document_types
SET llm_schema = '{
  "type": "object",
  "properties": {
    "number":            {"type": "string",  "description": "Номер договора/контракта"},
    "date":              {"type": "string",  "description": "Дата заключения в формате YYYY-MM-DD"},
    "title":             {"type": "string",  "description": "Полный заголовок (\"Договор поставки № 5...\")"},
    "subject_kind":      {"type": "string",  "description": "supply / services / works / rent / purchase / agency / license / other"},
    "subject":           {"type": "string",  "description": "Краткое описание предмета 1-2 предложения"},
    "party_a_name":      {"type": "string",  "description": "Наименование стороны A (Поставщик/Заказчик/Арендодатель)"},
    "party_a_inn":       {"type": "string",  "description": "ИНН стороны A"},
    "party_a_role":      {"type": "string",  "description": "Роль стороны A"},
    "party_b_name":      {"type": "string",  "description": "Наименование стороны B (Покупатель/Исполнитель/Арендатор)"},
    "party_b_inn":       {"type": "string",  "description": "ИНН стороны B"},
    "party_b_role":      {"type": "string",  "description": "Роль стороны B"},
    "currency":          {"type": "string",  "description": "ISO 4217 (RUB/USD/EUR/CNY)"},
    "total_amount":      {"type": "number",  "description": "Сумма договора если указана единой суммой"},
    "payment_terms":     {"type": "string",  "description": "Условия оплаты в одну строку"},
    "delivery_terms":    {"type": "string",  "description": "Условия поставки/исполнения"},
    "effective_date":    {"type": "string",  "description": "Дата вступления в силу YYYY-MM-DD"},
    "expiration_date":   {"type": "string",  "description": "Дата окончания срока действия YYYY-MM-DD"}
  }
}'::jsonb,
    llm_prompt = 'Извлеки из российского договора/контракта только реквизиты по схеме:
- number, date (YYYY-MM-DD), title, subject (1-2 предложения, что поставляется/оказывается)
- party_a_* и party_b_* — стороны с ИНН (10 или 12 цифр) и role (Поставщик / Покупатель / Заказчик / Исполнитель / Арендодатель / Арендатор)
- subject_kind — supply / services / works / rent / purchase / agency / license / other
- currency — ISO 4217 (RUB / USD / EUR / CNY)
- total_amount — число если указано единой суммой, иначе null
- payment_terms / delivery_terms — одна строка
- effective_date / expiration_date — YYYY-MM-DD если указаны

НЕ пересказывай ответственность, форс-мажор, разрешение споров. Если поле
не указано в документе — оставь null, не выдумывай. ИНН ровно 10 цифр у
юрлица, 12 у ИП.'
WHERE slug = 'contract';

-- ── #2 weighing_act llm_schema ─────────────────────────────────────

UPDATE document_types
SET llm_schema = '{
  "type": "object",
  "properties": {
    "number":             {"type": "string", "description": "Номер акта или заявки"},
    "date":               {"type": "string", "description": "Дата взвешивания YYYY-MM-DD"},
    "container_number":   {"type": "string", "description": "Номер контейнера 4 буквы + 7 цифр (FITU5561333)"},
    "scales_id":          {"type": "string", "description": "Марка/серийник весов (например ВА-80-18-3-2)"},
    "weight_gross_kg":    {"type": "number", "description": "Фактический брутто, кг"},
    "weight_tare_kg":     {"type": "number", "description": "Тара, кг"},
    "weight_net_kg":      {"type": "number", "description": "Фактический нетто, кг"},
    "declared_gross_kg":  {"type": "number", "description": "Брутто по документам, кг"},
    "declared_net_kg":    {"type": "number", "description": "Нетто по документам, кг"},
    "performer_fio":      {"type": "string", "description": "ФИО кто произвёл взвешивание"},
    "port_name":          {"type": "string", "description": "Порт/терминал (ВМТП/FESCO/ПКТ/Бронка)"}
  }
}'::jsonb
WHERE slug = 'weighing_act';

-- ── #2 eac_conformity_certificate llm_schema ───────────────────────

UPDATE document_types
SET llm_schema = '{
  "type": "object",
  "properties": {
    "number":                 {"type": "string", "description": "Номер документа (N RU Д-CN.РА01.В.54075/24 для сертификата, ЕАЭС N RU Д-... для декларации)"},
    "doc_kind":               {"type": "string", "description": "certificate / declaration — отличие между сертификатом соответствия и декларацией о соответствии"},
    "issue_date":             {"type": "string", "description": "Дата регистрации YYYY-MM-DD"},
    "expiry_date":            {"type": "string", "description": "Дата окончания YYYY-MM-DD"},
    "applicant_name":         {"type": "string", "description": "Заявитель (полное наименование)"},
    "applicant_inn":          {"type": "string", "description": "ИНН заявителя 10 цифр"},
    "applicant_address":      {"type": "string"},
    "manufacturer_name":      {"type": "string", "description": "Изготовитель"},
    "manufacturer_country":   {"type": "string", "description": "ISO 3166 alpha-2 (CN/RU/...)"},
    "product_description":    {"type": "string", "description": "Описание продукта"},
    "tn_ved_code":            {"type": "string", "description": "10-значный код ТН ВЭД ЕАЭС"},
    "tech_regulation":        {"type": "string", "description": "Ссылки на ТР ТС/ТР ЕАЭС, например ТР ТС 010/2011"},
    "certification_body":     {"type": "string", "description": "Орган по сертификации"}
  }
}'::jsonb,
    llm_prompt = 'Извлеки из сертификата соответствия ЕАЭС или декларации о соответствии:
- number — номер документа. Формат сертификата: «N RU Д-CN.РА01.В.54075/24». Декларации: «ЕАЭС N RU Д-...».
- doc_kind — "certificate" (сертификат соответствия) или "declaration" (декларация о соответствии). Заголовок «ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ» → declaration; «СЕРТИФИКАТ СООТВЕТСТВИЯ» → certificate.
- issue_date, expiry_date — YYYY-MM-DD
- applicant_* — заявитель (для импорта это российский импортёр), inn 10 цифр для юрлица
- manufacturer_* — изготовитель (часто иностранный)
- manufacturer_country — ISO 3166 alpha-2 (CN/RU/TR/DE и т.п.)
- tn_ved_code — 10 цифр без пробелов
- tech_regulation — ссылки на регламенты вида «ТР ТС 010/2011», «ТР ЕАЭС 037/2016»

Если поле отсутствует — null. Не выдумывай.'
WHERE slug = 'eac_conformity_certificate';

-- ── #2 price_list llm_schema ───────────────────────────────────────

UPDATE document_types
SET llm_schema = '{
  "type": "object",
  "properties": {
    "number":        {"type": "string", "description": "Номер прайс-листа"},
    "date":          {"type": "string", "description": "Дата YYYY-MM-DD"},
    "supplier_name": {"type": "string"},
    "supplier_country": {"type": "string", "description": "ISO 3166 alpha-2"},
    "currency":      {"type": "string", "description": "ISO 4217 валюта цен"},
    "valid_from":    {"type": "string"},
    "valid_to":      {"type": "string"},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sku":         {"type": "string", "description": "Артикул/код товара"},
          "name":        {"type": "string", "description": "Наименование"},
          "price":       {"type": "number"},
          "unit":        {"type": "string", "description": "шт/кг/м/комплект"},
          "min_qty":     {"type": "number", "description": "Минимальная партия"}
        }
      }
    }
  }
}'::jsonb
WHERE slug = 'price_list';

-- ── #2 proforma_invoice llm_schema ─────────────────────────────────

UPDATE document_types
SET llm_schema = '{
  "type": "object",
  "properties": {
    "number":          {"type": "string"},
    "date":            {"type": "string", "description": "YYYY-MM-DD"},
    "seller_name":     {"type": "string"},
    "seller_address":  {"type": "string"},
    "seller_country":  {"type": "string", "description": "ISO 3166 alpha-2"},
    "buyer_name":      {"type": "string"},
    "buyer_address":   {"type": "string"},
    "buyer_country":   {"type": "string", "description": "ISO 3166 alpha-2"},
    "currency":        {"type": "string", "description": "ISO 4217"},
    "total_amount":    {"type": "number"},
    "incoterms":       {"type": "string", "description": "FOB/CIF/EXW/... + город"},
    "payment_terms":   {"type": "string"},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "description": {"type": "string"},
          "qty":         {"type": "number"},
          "unit_price":  {"type": "number"},
          "line_total":  {"type": "number"}
        }
      }
    }
  }
}'::jsonb
WHERE slug = 'proforma_invoice';

-- ── #2 cert_of_origin llm_schema ───────────────────────────────────

UPDATE document_types
SET llm_schema = '{
  "type": "object",
  "properties": {
    "number":             {"type": "string"},
    "issue_date":         {"type": "string"},
    "form_type":          {"type": "string", "description": "CT-1 / Form A / Form E"},
    "exporter_name":      {"type": "string"},
    "exporter_country":   {"type": "string", "description": "ISO 3166 alpha-2"},
    "consignee_name":     {"type": "string"},
    "consignee_country":  {"type": "string", "description": "ISO 3166 alpha-2"},
    "product_description":{"type": "string"},
    "hs_code":            {"type": "string", "description": "10-значный ТН ВЭД"},
    "origin_country":     {"type": "string", "description": "ISO 3166 alpha-2"},
    "invoice_ref":        {"type": "string"}
  }
}'::jsonb
WHERE slug = 'cert_of_origin';

-- ── #2 wire_transfer_application llm_schema ───────────────────────

UPDATE document_types
SET llm_schema = '{
  "type": "object",
  "properties": {
    "number":                 {"type": "string"},
    "date":                   {"type": "string", "description": "YYYY-MM-DD"},
    "currency":               {"type": "string", "description": "ISO 4217 (CNY/USD/EUR)"},
    "amount":                 {"type": "number"},
    "amount_words":           {"type": "string"},
    "sender_name":            {"type": "string"},
    "sender_inn":             {"type": "string"},
    "sender_account":         {"type": "string"},
    "beneficiary_name":       {"type": "string"},
    "beneficiary_address":    {"type": "string"},
    "beneficiary_country":    {"type": "string", "description": "ISO 3166 alpha-2"},
    "beneficiary_iban":       {"type": "string"},
    "beneficiary_bank_name":  {"type": "string"},
    "beneficiary_bank_swift": {"type": "string", "description": "SWIFT BIC, формат 8 или 11 символов"},
    "purpose":                {"type": "string", "description": "Details of payment, на английском"},
    "contract_ref":           {"type": "string", "description": "Номер контракта из purpose"},
    "invoice_ref":            {"type": "string", "description": "Номер инвойса из purpose"}
  }
}'::jsonb
WHERE slug = 'wire_transfer_application';

-- ── #5 Country ISO-2 — добавляем напоминание в промпт где его не было ─

-- bill_of_lading: real-case — Qwen выдал "China"/"Russia" вместо "CN"/"RU"
-- → нужен явный hint в prompt
UPDATE document_types
SET llm_prompt = 'Извлеки из коносамента (Bill of Lading): bl_number, bl_type (Master/House), date (YYYY-MM-DD), carrier, vessel_name, voyage_number, port_of_loading, port_of_discharge, place_of_delivery, freight_terms (Prepaid/Collect), shipper (name/address/country), consignee (name/address/country/inn/kpp), notify_party (name/address), containers (массив с container_number/type/seal_number/packages/weight_gross/measurement), total_packages, total_weight_gross.

ВАЖНО: country везде в формате ISO 3166 alpha-2 (CN, RU, US, DE, TR — без слова "China"/"Russia"). Если в документе написано "China" — преобразуй в "CN".

Числовые поля (packages/weight/measurement) — числа, не строки. Десятичные с точкой, не запятой.'
WHERE slug = 'bill_of_lading';

-- commercial_invoice: тот же fix
UPDATE document_types
SET llm_prompt = 'Извлеки из commercial invoice: invoice_number, date (YYYY-MM-DD), exporter (name/address/country), consignee (name/address/country), currency (ISO 4217), total_amount, incoterms (FOB/CIF/EXW + город), payment_terms, items (массив: description/qty/unit_price/line_total/hs_code).

ВАЖНО: country везде в формате ISO 3166 alpha-2 (CN/RU/US/...). "China" → "CN", "Russia" → "RU".

Числовые поля — числа. Десятичные с точкой.'
WHERE slug = 'commercial_invoice';

-- Sanity check — обновили ровно 9 строк
DO $$
DECLARE updated_count int;
BEGIN
    SELECT count(*) INTO updated_count
    FROM document_types
    WHERE slug IN ('contract','weighing_act','eac_conformity_certificate',
                   'price_list','proforma_invoice','cert_of_origin',
                   'wire_transfer_application','bill_of_lading','commercial_invoice')
      AND llm_schema IS NOT NULL;
    IF updated_count < 9 THEN
        RAISE EXCEPTION 'Expected 9 rows with llm_schema, got %', updated_count;
    END IF;
END $$;

COMMIT;

-- Down Migration
-- Возвращаем все эти к NULL llm_schema. llm_prompt оставляем как есть
-- (не критично для rollback).
BEGIN;

UPDATE document_types
SET llm_schema = NULL
WHERE slug IN ('contract','weighing_act','eac_conformity_certificate',
               'price_list','proforma_invoice','cert_of_origin',
               'wire_transfer_application');

COMMIT;
