-- Up Migration
--
-- CLASSIFIER-PACKET-V2 §5.1/§5.2 (Фаза 1): 6 новых типов ВЭД-пакета +
-- дискриминаторы существующих. Основание — ручной разбор корпуса БКТ
-- (51/51, BCTT_GROUNDTRUTH.md): в каждом таможенном комплекте постоянно
-- встречаются типы, которых нет в каталоге.
--
--   excise_ead           — акцизный e-AD (АКЦИЗЕ ПРЕЦЕС / Reg.684/2009),
--                          ОТДЕЛЬНО от обычного EAD, лежит в каждом
--                          алкогольном комплекте.
--   vehicle_registration — СТС / техталон / Registracijos liudijimas;
--                          сюда же ФОЛДИМ сертификат допущения TIR
--                          (tir_identification отдельно НЕ заводим).
--   driver_passport      — паспорт водителя. ПДн ВЫСОКИЙ: extract сведён
--                          к allowlist {doc_kind,country,present}, ФИО/MRZ/
--                          номер НЕ извлекаются (§8). Тип нужен для
--                          сегментации композитов и детекта ПДн-страниц.
--   transport_permit     — дозвол / разовое разрешение (Engedély), НЕ
--                          негабарит-special_permit.
--   certificate_register — реестр (ТАБЛИЦА) сертификатов соответствия ЕАЭС,
--                          приложение к инвойсу, НЕ одиночный сертификат.
--   delivery_note        — расходная / отгрузочная накладная (LOT + сроки,
--                          без цен), НЕ packing_list, НЕ waybill.
--
-- Все: parser_kind='llm_extract', tier='beta' (обкатки на golden нет),
-- organization_id NULL (глобальные), is_builtin=false. GenericLlmParser
-- обслуживает по llm_schema + expected_fields. Живой LLM-классификатор
-- авто-подхватывает из document_types.
--
-- classification_keywords: кириллица компилируется new RegExp(raw,'i') и
-- матчится ПОДСТРОКОЙ (без \b — кириллический \b в JS-regex не работает,
-- см. keywords.ts). Латиница — с \b осознанно. Аксентная латиница
-- (ī/é/ā) дана литералом + ASCII-дублем (fold — P2-1, отдельная фаза).
-- Forward-only, аддитивная миграция.

BEGIN;

-- ── excise_ead — Акцизный e-AD (АКЦИЗЕ ПРЕЦЕС / Reg.684/2009) ────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'excise_ead',
    'Акцизный e-AD (АКЦИЗЕ ПРЕЦЕС)',
    'Электронный административный документ на подакцизные товары (алкоголь), Regulation 684/2009, с ARC-кодом (Administrative Reference Code) и процентом спирта. НЕ обычная экспортная декларация customs_export_ead — отдельный акцизный документ, лежит в каждом алкогольном комплекте.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['arc','sender_excise_id','consignee','items']::text[],
    ARRAY['date_range','weight_nett_le_gross']::text[],
    ARRAY['акцизе прецес','akcīzes preces','akcizes preces','684/2009','excise movement','\bARC\b']::text[],
    ARRAY[7.0, 7.0, 7.0, 6.0, 5.0, 3.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "arc": {"type": "string", "description": "Administrative Reference Code (ARC), уникальный код акцизного перемещения"},
        "issue_date": {"type": "string", "description": "Дата оформления YYYY-MM-DD"},
        "sender_excise_id": {"type": "string", "description": "Акцизный номер отправителя (SEED/excise number)"},
        "consignor": {"type": "object", "description": "Отправитель", "properties": {"name": {"type": "string"}, "excise_id": {"type": "string"}, "country": {"type": "string"}}},
        "consignee": {"type": "object", "description": "Получатель", "properties": {"name": {"type": "string"}, "excise_id": {"type": "string"}, "country": {"type": "string"}}},
        "place_of_dispatch": {"type": "string", "description": "Место отправления"},
        "place_of_delivery": {"type": "string", "description": "Место доставки"},
        "items": {
          "type": "array", "description": "Подакцизные позиции",
          "items": {"type": "object", "properties": {
            "name": {"type": "string"},
            "kn_code": {"type": "string", "description": "Код КН/CN (combined nomenclature)"},
            "alcohol_pct": {"type": "number", "description": "Содержание спирта, % об."},
            "gross_weight": {"type": "number", "description": "Масса брутто, кг"},
            "net_weight": {"type": "number", "description": "Масса нетто, кг"},
            "quantity": {"type": "number", "description": "Количество (л / шт)"}
          }}
        }
      }
    }'::jsonb
);

-- ── vehicle_registration — СТС / техталон / TIR (фолд) ──────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'vehicle_registration',
    'Свидетельство о регистрации ТС (СТС)',
    'Свидетельство о регистрации транспортного средства (СТС / технический талон / Registracijos liudijimas / Transpordiamet / Certificat d''immatriculation): регистрационный номер ТС, VIN, марка, категория, владелец. Сюда же — сертификат допущения TIR (Carnet TIR / Certificate of approval). НЕ груз и НЕ товарный документ.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['reg_number','vin','make','category','holder']::text[],
    ARRAY[]::text[],
    ARRAY['свидетельство о регистрации','технический талон','registracijos liudijimas','transpordiamet','certificat d''immatriculation','\bTIR\b','carnet tir','сертификат одобрения','certificate of approval']::text[],
    ARRAY[6.0, 6.0, 6.0, 6.0, 6.0, 4.0, 5.0, 5.0, 5.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "reg_number": {"type": "string", "description": "Регистрационный (гос) номер ТС"},
        "vin": {"type": "string", "description": "VIN / идентификационный номер"},
        "make": {"type": "string", "description": "Марка/модель ТС"},
        "category": {"type": "string", "description": "Категория ТС"},
        "holder": {"type": "object", "description": "Владелец/держатель (может быть ПДн — редактируется)", "properties": {"name": {"type": "string"}}},
        "first_registration_date": {"type": "string", "description": "Дата первой регистрации YYYY-MM-DD"},
        "valid_until": {"type": "string", "description": "Действует до YYYY-MM-DD"},
        "country": {"type": "string", "description": "Страна регистрации (ISO 3166 alpha-2)"},
        "tir_certificate_number": {"type": "string", "description": "Номер сертификата допущения TIR, если это TIR-документ"}
      }
    }'::jsonb
);

-- ── driver_passport — Паспорт водителя (ПДн ВЫСОКИЙ, allowlist §8) ──
-- llm_schema СВЕДЕНА к allowlist {doc_kind,country,present}. Персональные
-- поля (ФИО, номер, MRZ, дата рождения) СХЕМОЙ НЕ ЗАПРАШИВАЮТСЯ; сверх
-- этого — жёсткий allowlist-пост-фильтр в doc-service (§8.3) и не-отправка
-- паспортных страниц в облачный LLM (§8.5б, Фаза 2).
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'driver_passport',
    'Паспорт водителя (ID)',
    'Документ, удостоверяющий личность водителя (паспорт), с фото и MRZ-строкой (P<XXX...). ПДн ВЫСОКИЙ: персональные поля НЕ извлекаются, extract сведён к факту наличия {doc_kind,country,present}. Классифицируется для сегментации композитов и детекта ПДн-страниц; ФИО/номер/MRZ не сохраняются (§8 allowlist).',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['doc_kind','country','present']::text[],
    ARRAY[]::text[],
    ARRAY['p<[a-z]{3}','\bpassport\b','пашпарт','рэспублiка бела','identity card']::text[],
    ARRAY[7.0, 5.0, 6.0, 6.0, 4.0]::numeric(4,2)[],
    '{
      "type": "object",
      "description": "ПДн-безопасная схема удостоверения: ТОЛЬКО факт наличия и страна. НЕ извлекать ФИО, номер, MRZ, дату рождения.",
      "properties": {
        "doc_kind": {"type": "string", "description": "Вид документа-удостоверения, всегда \"id\""},
        "country": {"type": "string", "description": "Страна выдачи (ISO 3166 alpha-2), напр. BY/RU/KG. НЕ ПДн."},
        "present": {"type": "boolean", "description": "Факт наличия документа-удостоверения в комплекте"}
      }
    }'::jsonb
);

-- ── transport_permit — Дозвол / разовое разрешение ─────────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'transport_permit',
    'Дозвол / разовое разрешение на перевозку',
    'Разрешение на международную автоперевозку (дозвол / разовое разрешение / Engedély / special single-trip permit): номер, кем выдано, срок действия, госномера тягача и прицепа. НЕ спецразрешение на негабарит (special_permit).',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['number','issued_by','valid_from','valid_to','truck_plate']::text[],
    ARRAY['date_range']::text[],
    ARRAY['дозвол','разово[ег][^\n]{0,12}разрешени','\bengedély\b','\bengedely\b','special single-trip','single trip permit','разрешение на международн']::text[],
    ARRAY[6.0, 6.0, 6.0, 5.0, 5.0, 5.0, 5.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер разрешения/дозвола"},
        "issued_by": {"type": "string", "description": "Кем выдано (орган/страна)"},
        "valid_from": {"type": "string", "description": "Действует с YYYY-MM-DD"},
        "valid_to": {"type": "string", "description": "Действует по YYYY-MM-DD"},
        "truck_plate": {"type": "string", "description": "Госномер тягача"},
        "trailer_plate": {"type": "string", "description": "Госномер прицепа"},
        "country": {"type": "string", "description": "Страна действия разрешения (ISO 3166 alpha-2)"},
        "permit_type": {"type": "string", "description": "Тип (разовое / многократное / транзит)"}
      }
    }'::jsonb
);

-- ── certificate_register — Реестр сертификатов (приложение) ─────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'certificate_register',
    'Реестр сертификатов (приложение к инвойсу)',
    'Приложение к инвойсу — ТАБЛИЦА (реестр) сертификатов соответствия ЕАЭС: много строк с номерами сертификатов, датами, органом выдачи. НЕ одиночный сертификат/паспорт качества (quality_certificate).',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['invoice_ref','items']::text[],
    ARRAY[]::text[],
    ARRAY['реестр[^\n]{0,20}сертификат','annex to invoice','сертификат соответствия еаэс','список сертификатов','перечень сертификатов']::text[],
    ARRAY[7.0, 5.0, 5.0, 6.0, 6.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "invoice_ref": {"type": "string", "description": "Ссылка на инвойс, к которому приложен реестр"},
        "issue_date": {"type": "string", "description": "Дата реестра YYYY-MM-DD"},
        "items": {
          "type": "array", "description": "Строки реестра сертификатов",
          "items": {"type": "object", "properties": {
            "cert_number": {"type": "string", "description": "Номер сертификата"},
            "issue_date": {"type": "string", "description": "Дата выдачи YYYY-MM-DD"},
            "expiry_date": {"type": "string", "description": "Действует до YYYY-MM-DD"},
            "issuing_body": {"type": "string", "description": "Орган по сертификации"},
            "holder": {"type": "string", "description": "Держатель сертификата (юрлицо)"},
            "product": {"type": "string", "description": "Продукт/товар"}
          }}
        }
      }
    }'::jsonb
);

-- ── delivery_note — Расходная / отгрузочная накладная ──────────────
INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'delivery_note',
    'Расходная накладная / Delivery Note',
    'Отгрузочная (расходная) накладная — позиции с LOT и сроками годности, БЕЗ цен. Отличие: от packing_list — есть LOT/сроки годности; от waybill — не транспортная накладная.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['number','date','supplier','consignee','items']::text[],
    ARRAY['date_range']::text[],
    ARRAY['delivery note','расходная накладная','\blieferschein\b','\bpavadzīme\b','\bpavadzime\b','отгрузочная накладная']::text[],
    ARRAY[6.0, 6.0, 5.0, 5.0, 5.0, 6.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер накладной"},
        "date": {"type": "string", "description": "Дата YYYY-MM-DD"},
        "supplier": {"type": "object", "description": "Поставщик/грузоотправитель", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}},
        "consignee": {"type": "object", "description": "Грузополучатель", "properties": {"name": {"type": "string"}, "inn": {"type": "string"}}},
        "items": {
          "type": "array", "description": "Позиции отгрузки",
          "items": {"type": "object", "properties": {
            "name": {"type": "string"},
            "lot": {"type": "string", "description": "Номер партии/LOT"},
            "best_before": {"type": "string", "description": "Годен до YYYY-MM-DD"},
            "qty": {"type": "number", "description": "Количество"},
            "unit": {"type": "string"},
            "net_weight": {"type": "number", "description": "Масса нетто, кг"}
          }}
        }
      }
    }'::jsonb
);

-- Sanity check — все 6 заведены
DO $$
DECLARE added int;
BEGIN
    SELECT count(*) INTO added FROM document_types
     WHERE slug IN ('excise_ead','vehicle_registration','driver_passport',
                    'transport_permit','certificate_register','delivery_note');
    IF added <> 6 THEN
        RAISE EXCEPTION 'Expected 6 ВЭД-packet types, got %', added;
    END IF;
END $$;

-- ── §5.2 Дискриминаторы существующих типов (append, идемпотентно) ───
-- Каталог отдаёт LLM `slug — description`; уточняющая фраза-дискриминатор
-- помогает разводить близкие типы. Аппендим только если ещё не аппендили
-- (маркер « Дискриминатор:»), чтобы не задваивать при повторном прогоне.
UPDATE document_types SET description = description ||
  ' Дискриминатор: есть колонки цена/сумма (Unit price/Amount/Precio/Preis). Если цен НЕТ — это packing_list или contract_specification.'
  WHERE slug = 'commercial_invoice' AND position('Дискриминатор:' in description) = 0;

UPDATE document_types SET description = description ||
  ' Дискриминатор: вес нетто/брутто, число мест/паллет, БЕЗ цен и БЕЗ LOT/сроков годности (LOT/сроки → delivery_note).'
  WHERE slug = 'packing_list' AND position('Дискриминатор:' in description) = 0;

UPDATE document_types SET description = description ||
  ' Дискриминатор: перечень к контракту (Спецификация №… к Контракту №…); может быть с ценами и без.'
  WHERE slug = 'contract_specification' AND position('Дискриминатор:' in description) = 0;

UPDATE document_types SET description = description ||
  ' Дискриминатор: MRN-баркод экспортной декларации ЕС. НЕ ТТН, НЕ CMR, НЕ акцизный excise_ead.'
  WHERE slug = 'customs_export_ead' AND position('Дискриминатор:' in description) = 0;

UPDATE document_types SET description = description ||
  ' Дискриминатор: ОДИНОЧНЫЙ сертификат/паспорт качества. ТАБЛИЦА (реестр) многих сертификатов → certificate_register.'
  WHERE slug = 'quality_certificate' AND position('Дискриминатор:' in description) = 0;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM document_types
 WHERE slug IN ('excise_ead','vehicle_registration','driver_passport',
                'transport_permit','certificate_register','delivery_note');
-- Откат аппендов-дискриминаторов (best-effort: срезаем от маркера).
UPDATE document_types
   SET description = left(description, position(' Дискриминатор:' in description) - 1)
 WHERE slug IN ('commercial_invoice','packing_list','contract_specification',
                'customs_export_ead','quality_certificate')
   AND position(' Дискриминатор:' in description) > 0;
COMMIT;
