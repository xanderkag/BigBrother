-- Up Migration
--
-- Три новых типа по аудиту «подозрительно пустых» доков 2026-07-21
-- (24 дока глубоко прочитаны; 12/24 misclassified, из них 10 — из-за дыр
-- каталога; wf_87e77125-051):
--
--   product_description — «Техническое описание товара» (6 доков, 25% выборки):
--                         описания для таможенного оформления. Липли к
--                         safety_data_sheet/quality_certificate с conf 0.9+,
--                         чужая схема физически не вмещала содержимое.
--   cargo_damage_act    — «Акт о неисправностях груза (CDS)» (3 дока):
--                         двуязычная форма авиатерминала. Липла к awb —
--                         реквизиты авианакладной там лишь ссылка.
--   info_letter         — «Информационное/сопроводительное письмо» (3 дока):
--                         гарантийные письма и письма о назначении. Липли к
--                         invoice/awb; у invoice это ЗАГРЯЗНЯЛО реестр счетов
--                         (number/date чужого инвойса из текста письма).
--
-- Все: parser_kind='llm_extract', tier='experimental' (golden нет),
-- organization_id NULL (глобальные), is_builtin=false. Живой LLM-классификатор
-- подхватывает по description — дискриминаторы прописаны явно (в т.ч.
-- негативные: «НЕ SDS», «НЕ авианакладная», «НЕ счёт»).
-- weights по длине совпадают с keywords. Forward-only, аддитивная.

BEGIN;

-- ── product_description — Техническое описание товара ────────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'product_description',
    'Техническое описание товара',
    'Техническое описание / спецификация ИЗДЕЛИЯ для таможенного оформления или каталога: модель, бренд (или явное «торговая марка отсутствует»), типоразмер/форм-фактор, габариты изделия и упаковки, материал, комплектность, электропитание, назначение, цвет. Часто содержит фразу об отсутствии функций шифрования/криптографии (нотификация). НЕ паспорт безопасности (нет 16 секций SDS, CAS-номеров, GHS-классов), НЕ сертификат качества (нет органа выдачи и номера сертификата), НЕ инвойс (нет цен).',
    false, true, 'llm_extract', 'experimental', NULL,
    ARRAY['product_name','model','purpose','dimensions']::text[],
    ARRAY[]::text[],
    ARRAY['техническое описание','описание товара','описание изделия','технические характеристики','форм-фактор','не содержит функций шифрования','шифровальных (криптографических) средств','product description','technical description','datasheet']::text[],
    ARRAY[8.0, 7.0, 7.0, 5.0, 5.0, 6.0, 6.0, 6.0, 6.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "product_name": {"type": "string", "description": "Наименование товара/изделия"},
        "model": {"type": "string", "description": "Модель / артикул / P/N"},
        "brand": {"type": "string", "description": "Торговая марка/бренд; если явно указано отсутствие — строка «отсутствует»"},
        "manufacturer": {"type": "string", "description": "Изготовитель (наименование)"},
        "purpose": {"type": "string", "description": "Назначение товара (для чего используется)"},
        "form_factor": {"type": "string", "description": "Типоразмер / форм-фактор (например 19\" 1U, DIN-рейка)"},
        "dimensions": {"type": "string", "description": "Габариты изделия (Д×Ш×В, мм)"},
        "package_dimensions": {"type": "string", "description": "Габариты упаковки, если указаны отдельно"},
        "weight_kg": {"type": "number", "description": "Вес изделия, кг"},
        "material": {"type": "string", "description": "Материал корпуса/изделия (сталь, пластик, толщина)"},
        "color": {"type": "string", "description": "Цвет"},
        "power_supply": {"type": "string", "description": "Электропитание / блок питания (напряжение, мощность), если есть"},
        "contents": {"type": "array", "items": {"type": "string"}, "description": "Комплектность поставки (что входит в комплект)"},
        "no_encryption_declared": {"type": "boolean", "description": "true если явно заявлено отсутствие функций шифрования/криптографии"},
        "hs_code": {"type": "string", "description": "Код ТН ВЭД, если указан. Только цифры"},
        "palletized": {"type": "boolean", "description": "Признак паллетирования упаковки, если указан"}
      }
    }'::jsonb
);

-- ── cargo_damage_act — Акт о неисправностях груза (CDS) ──────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'cargo_damage_act',
    'Акт о неисправностях груза (CDS)',
    'Акт о неисправностях/повреждениях при приёмке груза на терминале (Cargo Damage Survey, коммерческий акт терминала): номер и дата акта, терминал/станция, фактическое количество мест и вес ПРОТИВ данных по перевозочным документам, характер повреждений (мятая упаковка, бой, подмочка), паллеты, remarks, подписи (вкл. таможню). Реквизиты авианакладной/накладной в нём — ССЫЛКА на перевозку: сам документ НЕ авианакладная (AWB) и НЕ накладная.',
    false, true, 'llm_extract', 'experimental', NULL,
    ARRAY['act_number','act_date','awb_ref','damages']::text[],
    ARRAY['date_range']::text[],
    ARRAY['акт о неисправностях','коммерческий акт','при приемке груза','повреждение груза','damage report','cargo damage','irregularity report','discrepanc']::text[],
    ARRAY[9.0, 7.0, 6.0, 6.0, 6.0, 7.0, 7.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "act_number": {"type": "string", "description": "Номер акта"},
        "act_date": {"type": "string", "description": "Дата акта, YYYY-MM-DD"},
        "terminal": {"type": "string", "description": "Терминал / станция / склад, где составлен акт"},
        "awb_ref": {"type": "string", "description": "Референс перевозочного документа (номер AWB / накладной), к которому составлен акт"},
        "flight_ref": {"type": "string", "description": "Рейс / дата рейса, если указаны"},
        "shipper": {"type": "string", "description": "Отправитель по перевозочному документу"},
        "consignee": {"type": "string", "description": "Получатель по перевозочному документу"},
        "pieces_per_docs": {"type": "integer", "description": "Количество мест ПО ДОКУМЕНТАМ"},
        "pieces_actual": {"type": "integer", "description": "Количество мест ФАКТИЧЕСКИ"},
        "weight_per_docs_kg": {"type": "number", "description": "Вес по документам, кг"},
        "weight_actual_kg": {"type": "number", "description": "Вес фактический, кг"},
        "pallets": {"type": "integer", "description": "Количество паллет, если указано"},
        "damages": {"type": "array", "items": {"type": "string"}, "description": "Характер неисправностей/повреждений (каждый пункт отдельно)"},
        "remarks": {"type": "string", "description": "Примечания / особые отметки"},
        "signatories": {"type": "array", "items": {"type": "string"}, "description": "Роли подписантов (перевозчик, терминал, таможня) — без ФИО"}
      }
    }'::jsonb
);

-- ── info_letter — Информационное/сопроводительное письмо ─────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'info_letter',
    'Информационное письмо',
    'Информационное / сопроводительное / гарантийное письмо или письмо о назначении: тема, отправитель и адресат, упоминаемые документы-референсы (номера и даты ЧУЖИХ документов — инвойсов, контрактов, накладных), обязательство или сообщение, срок, подписант. ВАЖНО: упомянутые в тексте номер и дата инвойса/контракта принадлежат РЕФЕРЕНСУ, а не самому письму. НЕ счёт (нет позиций, сумм к оплате, реквизитов продавца), НЕ накладная.',
    false, true, 'llm_extract', 'experimental', NULL,
    ARRAY['subject','sender','letter_date']::text[],
    ARRAY[]::text[],
    ARRAY['информационное письмо','гарантийное письмо','письмо о назначении','настоящим сообщаем','настоящим гарантируем','настоящим подтверждаем','довожу до вашего сведения','исх. №','cover letter','letter of guarantee']::text[],
    ARRAY[8.0, 8.0, 8.0, 7.0, 7.0, 7.0, 6.0, 4.0, 5.0, 6.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "subject": {"type": "string", "description": "Тема / суть письма одной фразой"},
        "letter_number": {"type": "string", "description": "Исходящий номер САМОГО письма (исх. №), не референсов"},
        "letter_date": {"type": "string", "description": "Дата САМОГО письма, YYYY-MM-DD"},
        "sender": {"type": "string", "description": "Отправитель (организация)"},
        "recipient": {"type": "string", "description": "Адресат (организация / орган)"},
        "letter_kind": {"type": "string", "enum": ["informational", "guarantee", "appointment", "cover", "other"], "description": "Вид письма: информационное / гарантийное / о назначении / сопроводительное"},
        "referenced_documents": {"type": "array", "items": {"type": "object", "properties": {"doc_kind": {"type": "string", "description": "Вид документа-референса (инвойс, контракт, накладная)"}, "number": {"type": "string"}, "date": {"type": "string"}}}, "description": "Упомянутые документы-референсы. Их номера/даты НЕ являются реквизитами письма"},
        "commitment": {"type": "string", "description": "Суть обязательства/сообщения (для гарантийных — что гарантируется)"},
        "deadline": {"type": "string", "description": "Срок исполнения, если указан"},
        "signatory_role": {"type": "string", "description": "Должность подписанта (без ФИО)"}
      }
    }'::jsonb
);

COMMIT;
