-- Up Migration
--
-- ВЭД-каталог, батч 2026-07-02: 4 новых глобальных типа документов.
--   insurance_policy   — страховой полис / договор страхования груза (GROUNDED:
--                        реальный «Драфт_полиса» — полис страхования груза
--                        «с ответственностью за все риски»).
--   safety_data_sheet  — паспорт безопасности (SDS/MSDS), 16-секционный формат
--                        (GROUNDED: реальный многостраничный «Safety data sheet»
--                        по Regulation EC 1272/2008; docx PFA-описание — НЕ SDS,
--                        SDS взят с боевого PDF-паспорта).
--   export_declaration — экспортная декларация страны отправления (approved prelim).
--   quality_certificate— сертификат/паспорт качества, Certificate of Analysis
--                        (approved prelim).
--
-- Все четыре: parser_kind='llm_extract', tier='beta' (заведены, обкатки на
-- golden-set нет — предварительные схемы), organization_id NULL (глобальные,
-- видны всем тенантам), is_builtin=false. GenericLlmParser обслуживает по
-- llm_schema + expected_fields. Живой LLM-классификатор авто-подхватывает из
-- document_types.
--
-- classification_keywords — ТITLE-ANCHORED: якорь ^\s* или явный заголовок
-- в первых ~500 символах; НЕ упоминание в теле. Кириллические паттерны
-- компилируются через new RegExp(raw,'i') и матчатся подстрокой (без \b —
-- кириллический \b в JS-regex не работает, см. keywords.ts). Латиница
-- использует \b осознанно.
-- Forward-only, аддитивная миграция.

BEGIN;

-- ── insurance_policy — Страховой полис / договор страхования груза ──
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'insurance_policy',
    'Страховой полис (страхование груза)',
    'Страховой полис / договор страхования груза: страховщик, страхователь, выгодоприобретатель, описание груза, страховая сумма и премия, условия страхования, франшиза, маршрут, ссылка на транспортный документ (инвойс/коносамент), сроки действия.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['policy_number','issue_date','insurer','insured','sum_insured','premium','cargo']::text[],
    ARRAY['inn_checksum','date_range','money_sanity']::text[],
    ARRAY['^\s*страховой полис','полис страхования','страховани[ея]\s+груз','insurance policy','cargo insurance']::text[],
    ARRAY[6.0, 6.0, 5.0, 5.0, 5.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "policy_number": {"type": "string", "description": "Номер полиса/договора страхования"},
        "issue_date": {"type": "string", "description": "Дата выдачи полиса YYYY-MM-DD"},
        "valid_from": {"type": "string", "description": "Начало срока страхования / ответственности YYYY-MM-DD"},
        "valid_until": {"type": "string", "description": "Окончание срока страхования / ответственности YYYY-MM-DD"},
        "insurer": {
          "type": "object", "description": "Страховщик (страховая компания)",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}
        },
        "insured": {
          "type": "object", "description": "Страхователь",
          "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}
        },
        "beneficiary": {"type": "string", "description": "Выгодоприобретатель"},
        "cargo": {
          "type": "object", "description": "Застрахованный груз",
          "properties": {"description": {"type": "string"}, "weight_kg": {"type": "number"}, "packages": {"type": "number"}}
        },
        "sum_insured": {"type": "number", "description": "Страховая сумма"},
        "premium": {"type": "number", "description": "Страховая премия"},
        "currency": {"type": "string", "description": "Валюта суммы/премии (ISO 4217)"},
        "franchise": {"type": "string", "description": "Франшиза (условная/безусловная), размер"},
        "coverage": {"type": "string", "description": "Условия страхования (например, «С ответственностью за все риски»)"},
        "incoterms": {"type": "string", "description": "Условие поставки Incoterms, если указано"},
        "route": {
          "type": "object", "description": "Маршрут перевозки",
          "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "mode": {"type": "string", "description": "Вид транспорта (АВИА/АВТО/море и т.п.)"}}
        },
        "transport_ref": {"type": "string", "description": "Ссылка на транспортный документ: инвойс / коносамент (B/L) / ТН"}
      }
    }'::jsonb
);

-- ── safety_data_sheet — Паспорт безопасности (SDS / MSDS) ──────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'safety_data_sheet',
    'Паспорт безопасности (SDS / MSDS)',
    'Паспорт безопасности химической продукции (Safety Data Sheet / MSDS), 16-секционный формат (GHS / Regulation EC 1272/2008): идентификация продукта и поставщика, состав (CAS), классификация опасности, меры первой помощи, обращение и хранение, физико-химические свойства.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['product_name','manufacturer','cas_number','hazard_class','sections']::text[],
    ARRAY['date_range']::text[],
    ARRAY['паспорт безопасности','safety data sheet','\bSDS\b','\bMSDS\b','material safety data sheet']::text[],
    ARRAY[6.0, 6.0, 5.0, 5.0, 5.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "product_name": {"type": "string", "description": "Торговое наименование продукта (Trade name / Product identifier)"},
        "article_number": {"type": "string", "description": "Артикул продукта, если указан"},
        "manufacturer": {
          "type": "object", "description": "Производитель / поставщик SDS",
          "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}, "contact": {"type": "string"}}
        },
        "cas_number": {"type": "string", "description": "CAS-номер основного вещества"},
        "composition": {
          "type": "array", "description": "Состав (Section 3): вещества и доли",
          "items": {"type": "object", "properties": {"name": {"type": "string"}, "cas": {"type": "string"}, "percent": {"type": "string"}}}
        },
        "hazard_class": {"type": "string", "description": "Класс/классификация опасности (GHS / CLP), Section 2"},
        "un_number": {"type": "string", "description": "Номер ООН (UN number), если применимо"},
        "revision_date": {"type": "string", "description": "Дата ревизии/составления YYYY-MM-DD"},
        "version": {"type": "string", "description": "Номер версии SDS"},
        "sections": {
          "type": "array", "description": "Секции SDS (1..16): номер и заголовок",
          "items": {"type": "object", "properties": {"number": {"type": "number"}, "title": {"type": "string"}}}
        }
      }
    }'::jsonb
);

-- ── export_declaration — Экспортная декларация страны отправления ───
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'export_declaration',
    'Экспортная декларация страны отправления',
    'Экспортная таможенная декларация страны отправления (customs export declaration). Заголовок: экспортёр, получатель, страны, условия поставки, стоимость, вес; строки товаров с кодами ТН ВЭД/HS.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['declaration_number','declaration_date','exporter','consignee','items']::text[],
    ARRAY['date_range','money_sanity','weight_nett_le_gross']::text[],
    ARRAY['export declaration','экспортн[а-я]+\s+деклараци','customs export declaration','declaration for export','出口货物报关单']::text[],
    ARRAY[6.0, 6.0, 5.0, 5.0, 5.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "declaration_number": {"type": "string", "description": "Номер декларации"},
        "declaration_date": {"type": "string", "description": "Дата декларации YYYY-MM-DD"},
        "customs_office": {"type": "string", "description": "Таможенный орган оформления"},
        "exporter": {
          "type": "object", "description": "Экспортёр / отправитель",
          "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "code": {"type": "string"}, "country": {"type": "string"}}
        },
        "consignee": {
          "type": "object", "description": "Получатель",
          "properties": {"name": {"type": "string"}, "address": {"type": "string"}, "country": {"type": "string"}}
        },
        "country_of_origin": {"type": "string", "description": "Страна происхождения товара (ISO 3166 alpha-2)"},
        "country_of_destination": {"type": "string", "description": "Страна назначения (ISO 3166 alpha-2)"},
        "transport_mode": {"type": "string", "description": "Вид транспорта"},
        "delivery_terms": {"type": "string", "description": "Условие поставки Incoterms (FCA/CIF/EXW + пункт)"},
        "currency": {"type": "string", "description": "Валюта (ISO 4217)"},
        "total_value": {"type": "number", "description": "Общая стоимость"},
        "total_net_weight": {"type": "number", "description": "Общий вес нетто, кг"},
        "total_gross_weight": {"type": "number", "description": "Общий вес брутто, кг"},
        "contract_number": {"type": "string", "description": "Номер контракта"},
        "invoice_number": {"type": "string", "description": "Номер инвойса"},
        "items": {
          "type": "array", "description": "Товарные позиции декларации",
          "items": {
            "type": "object",
            "properties": {
              "description": {"type": "string"},
              "hs_code": {"type": "string", "description": "Код ТН ВЭД / HS"},
              "quantity": {"type": "number"},
              "unit": {"type": "string"},
              "unit_price": {"type": "number"},
              "amount": {"type": "number"},
              "net_weight": {"type": "number"},
              "gross_weight": {"type": "number"},
              "country_of_origin": {"type": "string"}
            }
          }
        }
      }
    }'::jsonb
);

-- ── quality_certificate — Сертификат/паспорт качества (COA) ─────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'quality_certificate',
    'Сертификат / паспорт качества (Certificate of Analysis)',
    'Сертификат/паспорт качества, Certificate of Analysis (COA), Mill Test Certificate: продукт, производитель, партия/лот, стандарт, заключение о соответствии; строки параметров с нормой, фактическим значением и методом.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['certificate_number','product_name','manufacturer','batch_number','parameters']::text[],
    ARRAY['date_range']::text[],
    ARRAY['^\s*сертификат качества','^\s*паспорт качества','certificate of quality','certificate of analysis','quality certificate','mill test certificate','\bCOA\b']::text[],
    ARRAY[6.0, 6.0, 5.0, 5.0, 5.0, 4.0, 5.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "certificate_number": {"type": "string", "description": "Номер сертификата/паспорта качества"},
        "product_name": {"type": "string", "description": "Наименование продукта"},
        "manufacturer": {
          "type": "object", "description": "Производитель",
          "properties": {"name": {"type": "string"}, "country": {"type": "string"}}
        },
        "batch_number": {"type": "string", "description": "Номер партии"},
        "lot_number": {"type": "string", "description": "Номер лота"},
        "production_date": {"type": "string", "description": "Дата производства YYYY-MM-DD"},
        "expiry_date": {"type": "string", "description": "Срок годности / годен до YYYY-MM-DD"},
        "standard": {"type": "string", "description": "Стандарт (ГОСТ/ТУ/ISO/ASTM)"},
        "quantity": {"type": "number", "description": "Количество"},
        "weight": {"type": "number", "description": "Вес"},
        "issue_date": {"type": "string", "description": "Дата выдачи сертификата YYYY-MM-DD"},
        "signed_by": {"type": "string", "description": "Кем подписан / уполномоченное лицо"},
        "conclusion": {"type": "string", "description": "Заключение о соответствии"},
        "contract_number": {"type": "string", "description": "Номер контракта"},
        "invoice_number": {"type": "string", "description": "Номер инвойса"},
        "parameters": {
          "type": "array", "description": "Показатели/параметры качества",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string"},
              "norm": {"type": "string", "description": "Норма по стандарту"},
              "actual_value": {"type": "string", "description": "Фактическое значение"},
              "unit": {"type": "string"},
              "method": {"type": "string", "description": "Метод испытания"}
            }
          }
        }
      }
    }'::jsonb
);

-- Sanity check
DO $$
DECLARE added int;
BEGIN
    SELECT count(*) INTO added FROM document_types
     WHERE slug IN ('insurance_policy','safety_data_sheet','export_declaration','quality_certificate');
    IF added <> 4 THEN
        RAISE EXCEPTION 'Expected 4 ВЭД-class-4 types, got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types
 WHERE slug IN ('insurance_policy','safety_data_sheet','export_declaration','quality_certificate');
COMMIT;
