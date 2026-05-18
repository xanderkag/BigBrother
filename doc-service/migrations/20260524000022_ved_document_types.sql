-- Up Migration
--
-- 2026-05-18: Расширение справочника document_types под реальный
-- VED-кейс (импорт офисных кресел из Китая клиентом EAST-WEST-LOGISTIC).
-- Поставщик прислал комплект: контракт, инвойсы, B/L, акт взвешивания,
-- сертификаты, заявление на перевод. Анализ показал что 6 типов
-- отсутствуют в БД.
--
-- Все 6 новых типов получают parser_kind='llm_extract' — у нас нет
-- regex-парсеров для них, и шаблоны слишком вариативны. Inference
-- идёт через locally-deployed Qwen2.5-VL 32B (10.10.28.10) — никаких
-- данных в Anthropic/OpenAI.
--
-- Список типов:
--   1. weighing_act          — Акт взвешивания (ВМТП/FESCO/любой порт)
--   2. wire_transfer_application — Заявление на перевод в иностр. валюте
--                                  (ВТБ/Сбербанк/Альфа, SWIFT/IBAN)
--   3. eac_conformity_certificate — Сертификат соответствия ЕАЭС (EAC)
--   4. cert_of_origin        — Сертификат происхождения (СТ-1, ТН ВЭД)
--   5. price_list            — Прайс-лист поставщика
--   6. proforma_invoice      — Инвойс-проформа (preliminary invoice до отгрузки)

BEGIN;

-- ── 1. Акт взвешивания ─────────────────────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind,
    expected_fields, classification_keywords,
    llm_prompt
) VALUES (
    'weighing_act',
    'Акт взвешивания',
    'Акт взвешивания груженого/порожнего контейнера, фиксирующий результат на сертифицированных весах порта (ВМТП, ВСК, FESCO и др.). Используется как доказательство веса груза для таможни и страховщика.',
    false, true, 'llm_extract',
    ARRAY['number', 'date', 'container.number', 'weight.gross_kg', 'weight.tare_kg', 'weight.net_kg', 'weight.declared_gross_kg', 'weight.declared_net_kg', 'scales.id', 'performer.fio', 'port.name']::text[],
    ARRAY[
        'акт\s+взвешивания',
        'вес\s+груженого\s+контейнера',
        'вес\s+порожнего\s+контейнера',
        'свидетельство\s+о\s+поверке',
        '(?:брутто|нетто|тара)[\s,]+кг'
    ]::text[],
    'Извлеки из акта взвешивания: number (номер акта или заявки), date (дата взвешивания), container.number (номер контейнера 4 буквы + 7 цифр, например FITU5561333), weight: {gross_kg, tare_kg, net_kg, declared_gross_kg, declared_net_kg}, scales (id весов, серийник), performer.fio (кто произвёл), port.name (порт/терминал). Все веса — в килограммах, числа. Если что-то не указано — null.'
);

-- ── 2. Заявление на перевод (ВЭД) ──────────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind,
    expected_fields, classification_keywords,
    llm_prompt
) VALUES (
    'wire_transfer_application',
    'Заявление на перевод (ВЭД)',
    'Заявление на банковский перевод в иностранной валюте по контракту ВЭД. Формы ВТБ № 284, Сбербанка, Альфы. Содержит SWIFT BIC, IBAN получателя, валюту, назначение платежа на английском. Отличается от типовой российской «Платёжного поручения» (payment_order) — это документ для трансграничных переводов.',
    false, true, 'llm_extract',
    ARRAY['number', 'date', 'currency', 'amount', 'amount_words', 'sender.name', 'sender.inn', 'sender.account', 'beneficiary.name', 'beneficiary.address', 'beneficiary.country', 'beneficiary.iban', 'beneficiary_bank.swift', 'beneficiary_bank.name', 'beneficiary_bank.address', 'purpose', 'contract_ref', 'invoice_ref']::text[],
    ARRAY[
        'заявление\s+на\s+перевод',
        'application\s+for\s+(?:remittance|transfer)',
        '\bSWIFT\b.{0,40}\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2,5}\b',
        '\bbeneficiary\s+customer\b',
        'sender\s+to\s+receiver\s+information',
        'Currency\s+Code',
        'банк-?посредник'
    ]::text[],
    'Извлеки из заявления на перевод в иностранной валюте: number, date, currency (ISO код, USD/EUR/CNY), amount (число), amount_words, sender: {name, inn, account}, beneficiary: {name, address, country, iban}, beneficiary_bank: {swift, name, address}, purpose (Details of payment, на английском), contract_ref (номер контракта в назначении), invoice_ref (номер инвойса). Все денежные значения — числами. Не путать с российским платёжным поручением (там нет SWIFT/IBAN).'
);

-- ── 3. Сертификат соответствия ЕАЭС (EAC) ──────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind,
    expected_fields, classification_keywords,
    llm_prompt
) VALUES (
    'eac_conformity_certificate',
    'Сертификат соответствия ЕАЭС',
    'Сертификат соответствия техническим регламентам Евразийского экономического союза (ТР ТС / ТР ЕАЭС). Подтверждает что товар соответствует требованиям безопасности и может ввозиться/обращаться на территории ЕАЭС. Формат номера: «N RU Д-CN.РА01.В.54075/24». Отличается от cert_of_origin (тот про страну происхождения, а этот — про соответствие техническим нормам).',
    false, true, 'llm_extract',
    ARRAY['number', 'issue_date', 'expiry_date', 'manufacturer.name', 'manufacturer.address', 'manufacturer.country', 'applicant.name', 'applicant.inn', 'applicant.address', 'product.name', 'product.tn_ved_code', 'tech_regulation', 'certification_body.name', 'certification_body.id']::text[],
    ARRAY[
        'сертификат\s+соответствия',
        '\bN\s+RU\s+(?:Д-[A-Z]{2}|С-[A-Z]{2})\.[А-Я0-9]+',
        'технически[йе]\s+регламент',
        '\bТР\s+ТС\b',
        '\bТР\s+ЕАЭС\b',
        'EAC\s+conformity'
    ]::text[],
    'Извлеки из сертификата соответствия ЕАЭС: number (формат «N RU Д-CN.РА01.В.54075/24»), issue_date, expiry_date, manufacturer: {name, address, country}, applicant: {name, inn, address}, product: {name, tn_ved_code (10-значный код ТН ВЭД)}, tech_regulation (ссылки на ТР ТС/ТР ЕАЭС, например «ТР ТС 010/2011»), certification_body: {name, id}. Все даты — ISO YYYY-MM-DD.'
);

-- ── 4. Сертификат происхождения (СТ-1) ─────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind,
    expected_fields, classification_keywords,
    llm_prompt
) VALUES (
    'cert_of_origin',
    'Сертификат происхождения',
    'Сертификат происхождения товара формы СТ-1 (СНГ), CO (Form A для GSP), Form E (Китай). Подтверждает страну происхождения товара для тарифных льгот. Не путать с eac_conformity_certificate (тот про техн. соответствие).',
    false, true, 'llm_extract',
    ARRAY['number', 'issue_date', 'form_type', 'exporter.name', 'exporter.address', 'exporter.country', 'consignee.name', 'consignee.address', 'consignee.country', 'product.description', 'product.hs_code', 'product.origin_country', 'invoice_ref']::text[],
    ARRAY[
        'сертификат\s+происхождения',
        'certificate\s+of\s+origin',
        'form\s+(?:CT-1|СТ-1|A|E)',
        'country\s+of\s+origin'
    ]::text[],
    'Извлеки из сертификата происхождения: number, issue_date, form_type (CT-1/Form A/Form E), exporter: {name, address, country}, consignee: {name, address, country}, product: {description, hs_code (ТН ВЭД), origin_country (ISO alpha-2 если возможно)}, invoice_ref. Даты ISO.'
);

-- ── 5. Прайс-лист ──────────────────────────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind,
    expected_fields, classification_keywords,
    llm_prompt
) VALUES (
    'price_list',
    'Прайс-лист',
    'Прайс-лист поставщика с ассортиментом и ценами. Не платёжный документ — используется как reference data для расчёта стоимости заказа. Содержит позиции (артикул, наименование, цена, валюта, иногда минимальная партия).',
    false, true, 'llm_extract',
    ARRAY['number', 'date', 'supplier.name', 'supplier.country', 'currency', 'valid_from', 'valid_to', 'items']::text[],
    ARRAY[
        'прайс-?лист',
        '\bprice\s+list\b',
        'прейскурант',
        '(?:артикул|article|sku).{0,200}(?:цена|price)'
    ]::text[],
    'Извлеки из прайс-листа: number (если есть), date, supplier: {name, country}, currency (валюта цен, ISO код), valid_from, valid_to, items[]: { sku/article, name, price, unit (шт/кг/м), min_qty (минимальная партия)}. Если items больше 50 — извлеки первые 50 и в metadata укажи total_items.'
);

-- ── 6. Proforma invoice ────────────────────────────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind,
    expected_fields, classification_keywords,
    llm_prompt
) VALUES (
    'proforma_invoice',
    'Инвойс-проформа',
    'Предварительный инвойс до отгрузки. Используется для оформления договорённости по составу/цене партии, для получения предоплаты, для согласования с банком. Не является фискальным документом. После отгрузки заменяется на commercial_invoice.',
    false, true, 'llm_extract',
    ARRAY['number', 'date', 'seller.name', 'seller.address', 'seller.country', 'buyer.name', 'buyer.address', 'buyer.country', 'currency', 'total_amount', 'incoterms', 'payment_terms', 'items']::text[],
    ARRAY[
        '\bproforma\s+invoice\b',
        'инвойс-?проформа',
        'предварительный\s+инвойс'
    ]::text[],
    'Извлеки из proforma invoice: number, date, seller: {name, address, country}, buyer: {name, address, country}, currency, total_amount, incoterms (FOB/CIF/EXW + город), payment_terms (TT advance / 30% deposit / LC etc.), items[]: { description, qty, unit_price, line_total }. Числа — числами.'
);

-- Sanity check — 6 строк добавлено
DO $$
DECLARE
    added int;
BEGIN
    SELECT count(*) INTO added FROM document_types
    WHERE slug IN ('weighing_act', 'wire_transfer_application', 'eac_conformity_certificate',
                   'cert_of_origin', 'price_list', 'proforma_invoice');
    IF added <> 6 THEN
        RAISE EXCEPTION 'Expected 6 new VED document types, got %', added;
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types WHERE slug IN (
    'weighing_act',
    'wire_transfer_application',
    'eac_conformity_certificate',
    'cert_of_origin',
    'price_list',
    'proforma_invoice'
);
COMMIT;
