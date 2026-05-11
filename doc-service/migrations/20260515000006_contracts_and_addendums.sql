-- Договоры и их приложения — расширение каталога на юридический пласт.
--
-- Зачем три типа, а не один:
--   1) Договор и его приложение — РАЗНЫЕ документы. У спецификации нет
--      «предмета договора», но есть таблица позиций со ссылкой на родителя.
--      У допсоглашения нет позиций, но есть «changes_summary» — список
--      измений. Слив их в один тип = размытая схема и плохой extract.
--   2) Классификация: ключевые слова отличаются («Договор» vs «Приложение
--      № X к Договору» vs «Дополнительное соглашение»). Регэксп каждого
--      ловит свой паттерн.
--   3) Связь parent_contract — приложения и допсоглашения хранят номер+дату
--      родительского договора как поля. Это даёт интеграциям с 1С/ERP
--      готовый join по реквизитам, без отдельной таблицы связей.
--
-- Что НЕ делаем (намеренно):
--   - Не дробим договор на подвиды (поставки/услуг/аренды). Их слишком много,
--     а специфические поля можно положить в `metadata` модели через хороший
--     prompt. При необходимости админ через UI создаст узкие подтипы.
--   - Не извлекаем «положения и оговорки» (forfait, форс-мажор, подсудность).
--     Документ нужен для интеграций с учётной системой — реквизиты, суммы,
--     сроки. Юристам — читать сам PDF.
--   - Не сериализуем подписи / печати. Это отдельная задача computer vision.

-- Up Migration

INSERT INTO document_types (
    slug, display_name, description, is_builtin, is_active, parser_kind,
    expected_fields, validators, classification_keywords,
    confidence_threshold, regex_fallback_threshold,
    llm_schema, llm_prompt
) VALUES

-- ============================================================================
-- 1. Договор (универсальный)
-- ============================================================================
(
    'contract',
    'Договор',
    'Договор любого вида: поставки, услуг, подряда, аренды, агентский, лицензионный. Длинный (5-30 страниц). Извлекаем реквизиты, стороны, сумму, сроки, подписантов — не пересказываем положения. Подвиды (поставки/услуг/…) распознаются по `subject_kind` внутри schema.',
    true, true, 'llm_extract',
    ARRAY['number', 'date', 'party_a.inn', 'party_b.inn', 'subject', 'total_amount'],
    ARRAY[
        'inn_checksum:party_a.inn',
        'inn_checksum:party_b.inn',
        'kpp_format:party_a.kpp',
        'kpp_format:party_b.kpp',
        'parties_differ:party_a.inn,party_b.inn',
        'money_sanity:total_amount',
        'date_range'
    ],
    -- Тонкий момент: «Договор» как слово встречается в счетах-фактурах
    -- («оплата по Договору № X от …»). Чтобы не классифицировать счёт как
    -- договор, требуем сочетание заголовка и характерного блока («Стороны»,
    -- «Предмет договора» — встречаются ТОЛЬКО в самом договоре).
    ARRAY[
        '\bДОГОВОР\s+№',
        '\bПредмет\s+(?:настоящего\s+)?[Дд]оговора\b',
        '\bПрава\s+и\s+обязанности\s+[Сс]торон\b',
        '\bСрок\s+действия\s+[Дд]оговора\b',
        '\bПодписи\s+[Сс]торон\b',
        '\bДоговор\s+поставки\b',
        '\bДоговор\s+оказания\s+услуг\b',
        '\bДоговор\s+подряда\b',
        '\bДоговор\s+аренды\b',
        '\bДоговор\s+купли-продажи\b'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер договора"},
        "date": {"type": "string", "format": "date", "description": "Дата заключения"},
        "title": {"type": "string", "description": "Полный заголовок документа (\"Договор поставки № 5 от 15.01.2026\")"},
        "subject_kind": {
          "type": "string",
          "description": "Вид договора: supply (поставки), services (услуг), works (подряда), rent (аренды), purchase (купли-продажи), agency (агентский), license (лицензионный), other",
          "enum": ["supply", "services", "works", "rent", "purchase", "agency", "license", "other"]
        },
        "subject": {"type": "string", "description": "Краткое описание предмета (1-2 предложения, что именно поставляется/оказывается)"},
        "effective_date": {"type": "string", "format": "date", "description": "Дата вступления в силу, если отличается от даты заключения"},
        "expiration_date": {"type": "string", "format": "date", "description": "Дата окончания срока действия, если указана"},
        "term_description": {"type": "string", "description": "Условие о сроке (\"до полного исполнения обязательств\", \"1 год с автопролонгацией\")"},
        "party_a": {
          "type": "object",
          "description": "Первая сторона (обычно Поставщик / Заказчик / Арендодатель)",
          "properties": {
            "role": {"type": "string", "description": "Поставщик / Покупатель / Заказчик / Исполнитель / Арендодатель / Арендатор"},
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "kpp": {"type": "string"},
            "ogrn": {"type": "string", "description": "13 или 15 цифр"},
            "address": {"type": "string"},
            "bank_account": {"type": "string"},
            "bic": {"type": "string"},
            "bank_name": {"type": "string"},
            "correspondent_account": {"type": "string"},
            "representative_name": {"type": "string", "description": "ФИО подписанта"},
            "representative_title": {"type": "string", "description": "Должность (\"Генеральный директор\")"},
            "representative_basis": {"type": "string", "description": "На основании чего действует (\"Устава\", \"Доверенности № 5 от …\")"}
          }
        },
        "party_b": {
          "type": "object",
          "description": "Вторая сторона",
          "properties": {
            "role": {"type": "string"},
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "kpp": {"type": "string"},
            "ogrn": {"type": "string"},
            "address": {"type": "string"},
            "bank_account": {"type": "string"},
            "bic": {"type": "string"},
            "bank_name": {"type": "string"},
            "correspondent_account": {"type": "string"},
            "representative_name": {"type": "string"},
            "representative_title": {"type": "string"},
            "representative_basis": {"type": "string"}
          }
        },
        "total_amount": {"type": "number", "description": "Цена / сумма договора если указана единой суммой"},
        "currency": {"type": "string", "description": "ISO-4217 (RUB, USD, EUR)"},
        "vat_included": {"type": "boolean", "description": "true если сумма с НДС, false если без, null если не указано"},
        "vat_rate": {"type": "number", "description": "Ставка НДС в процентах (20/10/0)"},
        "vat_amount": {"type": "number"},
        "payment_terms": {"type": "string", "description": "Условия оплаты в одну строку (\"Предоплата 30%, остаток в течение 10 дней после поставки\")"},
        "delivery_terms": {"type": "string", "description": "Условия поставки/исполнения (\"Доставка силами Поставщика на склад Покупателя\")"},
        "signed_at_location": {"type": "string", "description": "Место заключения (город)"}
      }
    }'::jsonb,
    'Ты — парсер российского договора. Документ длинный (5-30 страниц) — НЕ пересказывай положения, форс-мажор, ответственность сторон, порядок разрешения споров и т.п. Извлекай ТОЛЬКО реквизиты по схеме: номер, дату, заголовок, стороны (с ИНН/КПП/ОГРН/реквизитами/подписантом), предмет (1-2 предложения), сумму, условия оплаты и поставки, сроки. Подвид договора (subject_kind) определи по заголовку. ОГРН — 13 цифр у юрлица, 15 у ИП. Если у стороны нет какого-то реквизита (бывает у ИП — нет КПП) — оставляй поле пустым, не выдумывай.'
),

-- ============================================================================
-- 2. Спецификация / Приложение к договору
-- ============================================================================
(
    'contract_specification',
    'Спецификация / Приложение к договору',
    'Приложение № N к договору, содержащее таблицу позиций с ценами. Самое частое приложение. Ссылается на родительский договор через `parent_contract_number` и `parent_contract_date`.',
    true, true, 'llm_extract',
    ARRAY['number', 'date', 'parent_contract_number', 'parent_contract_date', 'positions', 'total_amount'],
    ARRAY[
        'inn_checksum:party_a.inn',
        'inn_checksum:party_b.inn',
        'parties_differ:party_a.inn,party_b.inn',
        'money_sanity:total_amount',
        'positions_sum',
        'date_range'
    ],
    ARRAY[
        '\bСпецификация\s+№?\s*\d+\s+к\s+Договор',
        '\bПриложение\s+№?\s*\d+\s+к\s+Договор',
        '\bПриложение\s+к\s+Договор',
        '\bСпецификация\s+товара\b',
        '\bСпецификация\s+к\s+Договор'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер приложения/спецификации"},
        "date": {"type": "string", "format": "date"},
        "title": {"type": "string", "description": "Полный заголовок (\"Спецификация № 1 к Договору поставки № 5 от 15.01.2026\")"},
        "parent_contract_number": {"type": "string", "description": "Номер родительского договора (из заголовка)"},
        "parent_contract_date": {"type": "string", "format": "date", "description": "Дата родительского договора"},
        "party_a": {
          "type": "object",
          "properties": {
            "role": {"type": "string"},
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "kpp": {"type": "string"}
          }
        },
        "party_b": {
          "type": "object",
          "properties": {
            "role": {"type": "string"},
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "kpp": {"type": "string"}
          }
        },
        "positions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "number": {"type": "integer", "description": "Порядковый номер позиции"},
              "name": {"type": "string", "description": "Наименование товара/услуги"},
              "code": {"type": "string", "description": "Артикул/код товара если есть"},
              "unit": {"type": "string", "description": "Шт, кг, м, услуга и т.п."},
              "qty": {"type": "number"},
              "price": {"type": "number", "description": "Цена за единицу без НДС"},
              "total": {"type": "number", "description": "Стоимость позиции с учётом количества"},
              "vat_rate": {"type": "string", "description": "20%, 10%, 0%, без НДС"},
              "vat_amount": {"type": "number"},
              "delivery_term": {"type": "string", "description": "Срок поставки этой позиции если указан"}
            }
          }
        },
        "total_amount": {"type": "number", "description": "Итого по спецификации"},
        "total_vat": {"type": "number"},
        "currency": {"type": "string"},
        "vat_included": {"type": "boolean"}
      }
    }'::jsonb,
    'Ты — парсер спецификации (приложения к договору). Главное — таблица позиций (positions) и ссылка на родительский договор (parent_contract_number + parent_contract_date — оба извлекаются из заголовка типа «Спецификация № 1 к Договору № 5 от 15.01.2026»). Цены без НДС в `price`, НДС отдельно в `vat_amount` и `vat_rate`. Если итог в таблице с НДС — `vat_included=true`, иначе false.'
),

-- ============================================================================
-- 3. Дополнительное соглашение
-- ============================================================================
(
    'contract_addendum',
    'Дополнительное соглашение',
    'Допсоглашение к договору: изменения цены, срока, замена редакции пункта, расторжение. Стороны те же что в родительском договоре. `changes` — список конкретных модификаций.',
    true, true, 'llm_extract',
    ARRAY['number', 'date', 'parent_contract_number', 'parent_contract_date', 'party_a.inn', 'party_b.inn'],
    ARRAY[
        'inn_checksum:party_a.inn',
        'inn_checksum:party_b.inn',
        'parties_differ:party_a.inn,party_b.inn',
        'date_range'
    ],
    ARRAY[
        '\bДополнительное\s+соглашение\b',
        '\bДоп\.?\s+соглашение\b',
        '\bСоглашение\s+об\s+изменении\b',
        '\bСоглашение\s+о\s+расторжении\b',
        '\bО\s+внесении\s+изменений\s+в\s+Договор\b'
    ],
    NULL, NULL,
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер допсоглашения"},
        "date": {"type": "string", "format": "date"},
        "title": {"type": "string"},
        "parent_contract_number": {"type": "string"},
        "parent_contract_date": {"type": "string", "format": "date"},
        "addendum_kind": {
          "type": "string",
          "description": "Тип изменения",
          "enum": ["amendment", "termination", "extension", "price_change", "renaming", "other"]
        },
        "party_a": {
          "type": "object",
          "properties": {
            "role": {"type": "string"},
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "kpp": {"type": "string"},
            "representative_name": {"type": "string"}
          }
        },
        "party_b": {
          "type": "object",
          "properties": {
            "role": {"type": "string"},
            "name": {"type": "string"},
            "inn": {"type": "string"},
            "kpp": {"type": "string"},
            "representative_name": {"type": "string"}
          }
        },
        "changes": {
          "type": "array",
          "description": "Список конкретных изменений к договору",
          "items": {
            "type": "object",
            "properties": {
              "clause": {"type": "string", "description": "Пункт договора который меняется (\"п. 3.1\", \"раздел 4\")"},
              "action": {"type": "string", "description": "modify / replace / add / remove"},
              "old_text": {"type": "string", "description": "Старая редакция, если приведена"},
              "new_text": {"type": "string", "description": "Новая редакция"}
            }
          }
        },
        "new_total_amount": {"type": "number", "description": "Если соглашение меняет сумму договора — новая сумма"},
        "new_expiration_date": {"type": "string", "format": "date", "description": "Если меняется срок действия — новая дата окончания"},
        "effective_date": {"type": "string", "format": "date", "description": "С какой даты изменения вступают в силу"}
      }
    }'::jsonb,
    'Ты — парсер дополнительного соглашения к договору. Главное: ссылка на родителя (parent_contract_number/date из заголовка), стороны (обычно те же что в основном договоре), и список конкретных изменений в `changes`. Каждое изменение — это «пункт X излагается в новой редакции», или «дополнить пункт Y…», или «исключить раздел Z». Если соглашение о расторжении — addendum_kind=termination, changes можно оставить пустым. Если только меняется сумма — заполни new_total_amount.'
)
ON CONFLICT (slug) DO NOTHING;

-- Down Migration

DELETE FROM document_types WHERE slug IN (
    'contract',
    'contract_specification',
    'contract_addendum'
);
