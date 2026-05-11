-- Document Type Registry — конфигурация типов документов в БД.
--
-- Сейчас типы документов и их параметры захардкожены в коде
-- (src/types/documents.ts, document-json-schemas.ts, pipeline/parsers,
-- pipeline/validation). Это foundation-step переноса конфига в БД,
-- чтобы дальше:
--   - админ через UI добавлял новые типы без коммита кода
--   - меняли prompt'ы и пороги под конкретный документ
--   - в перспективе multi-tenant — у каждого клиента свой набор
--
-- На этой миграции таблица заводится и сидится текущими 6 типами с
-- их фактическими параметрами. Runtime пока продолжает читать
-- захардкоженные значения — переключение на чтение из БД сделаем
-- следующими шагами, когда отладим repo + API + UI на read-only
-- режиме.

-- Up Migration

CREATE TABLE IF NOT EXISTS document_types (
    slug                    TEXT PRIMARY KEY,                     -- 'invoice', 'TTN', 'commercial_invoice', ...
    display_name            TEXT NOT NULL,                        -- человекочитаемое имя для UI
    description             TEXT,                                 -- что это за документ, для оператора
    is_active               BOOLEAN NOT NULL DEFAULT true,        -- inactive типы не попадают в классификатор/dropdown'ы
    is_builtin              BOOLEAN NOT NULL DEFAULT false,       -- встроенные не удаляются через DELETE API

    -- Какой парсер обслуживает этот тип:
    --   builtin:invoice_regex / builtin:upd_regex — текущие хардкод-парсеры
    --   llm_extract                              — LLM /v1/extract с JSON-схемой
    parser_kind             TEXT NOT NULL
                            CHECK (parser_kind IN ('builtin:invoice_regex', 'builtin:upd_regex', 'llm_extract')),

    -- Прямые конфиги парсинга:
    --   NULL = использовать встроенный default (из prompts/ в inference-service
    --   и из document-json-schemas.ts в doc-service)
    --   non-NULL = override для этого типа
    llm_prompt              TEXT,
    llm_schema              JSONB,

    -- Поля, которые парсер обязан попытаться извлечь. Используется в
    -- ParseResult.missing[] и для отображения в UI «вот что мы ищем».
    expected_fields         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Имена builtin-валидаторов с параметрами через `:`. Примеры:
    --   inn_checksum:seller.inn      — ИНН в поле seller.inn по чек-сумме ФНС
    --   vat_consistency              — vat ≈ total × rate / (100+rate)
    --   vehicle_plate:vehicle.plate  — формат госномера
    --   country_code:sender.country  — ISO 3166 alpha-2
    --   parties_differ:seller.inn,buyer.inn
    -- Runtime-реестр валидаторов будет введён в следующей фазе.
    validators              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Если parser-side confidence < needs_review_threshold → status='needs_review'.
    -- Per-type override; если NULL — берётся глобальный из env.
    confidence_threshold        NUMERIC(4, 3),
    -- Только для Phase 1 (regex+LLM-fallback): порог regex confidence
    -- ниже которого парсер дёргает LLM /extract.
    regex_fallback_threshold    NUMERIC(4, 3),

    -- Регэкспы / литералы, по которым keyword-classifier распознаёт тип.
    -- Сейчас классификатор тоже захардкожен, перенос сюда — следующий шаг.
    classification_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Расширяемое поле для будущих фич (примеры документов, кастомные настройки).
    metadata                JSONB,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Триггер updated_at — переиспользуем функцию из миграции 001 (jobs_set_updated_at).
-- Имя у неё «jobs_»-префиксное по историческим причинам, но логика generic:
-- NEW.updated_at = now(). При желании потом переименуем на set_updated_at.
DROP TRIGGER IF EXISTS trg_document_types_updated_at ON document_types;
CREATE TRIGGER trg_document_types_updated_at
    BEFORE UPDATE ON document_types
    FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();

-- --- Seed: 6 builtin типов с их текущими параметрами ---

INSERT INTO document_types (
    slug, display_name, description, is_builtin, parser_kind,
    expected_fields, validators, classification_keywords, regex_fallback_threshold
) VALUES
(
    'invoice', 'Счёт на оплату',
    'Российский счёт на оплату. Парсится регулярками; при низкой уверенности — fallback в LLM.',
    true, 'builtin:invoice_regex',
    ARRAY['number','date','seller','buyer','total'],
    ARRAY['inn_checksum:seller.inn','inn_checksum:buyer.inn','vat_consistency','date_range','parties_differ:seller.inn,buyer.inn','money_sanity:total','money_sanity:vat'],
    ARRAY['\bсч[её]т\s+на\s+оплату\b', '\bсч[её]т\s+№'],
    0.7
),
(
    'factInvoice', 'Счёт-фактура',
    'Счёт-фактура. Структура совпадает с УПД, парсится тем же regex'' и при низком уверенности — LLM-fallback.',
    true, 'builtin:upd_regex',
    ARRAY['number','date','seller','buyer','total','vat'],
    ARRAY['inn_checksum:seller.inn','inn_checksum:buyer.inn','vat_consistency','date_range','parties_differ:seller.inn,buyer.inn'],
    ARRAY['счет-фактура', 'счёт-фактура'],
    0.7
),
(
    'UPD', 'УПД',
    'Универсальный передаточный документ. Парсится regex'' с LLM-fallback при низкой уверенности.',
    true, 'builtin:upd_regex',
    ARRAY['number','date','seller','buyer','total'],
    ARRAY['inn_checksum:seller.inn','inn_checksum:buyer.inn','vat_consistency','date_range','parties_differ:seller.inn,buyer.inn'],
    ARRAY['универсальный\s+передаточный\s+документ', '\bУПД\b'],
    0.7
),
(
    'TTN', 'Транспортная накладная',
    'ТТН — табличный документ; парсится через LLM /extract по JSON-схеме.',
    true, 'llm_extract',
    ARRAY['number','date','shipper','consignee','cargo','vehicle'],
    ARRAY['inn_checksum:shipper.inn','inn_checksum:consignee.inn','vehicle_plate:vehicle.plate','date_range','parties_differ:shipper.inn,consignee.inn'],
    ARRAY['транспортная\s+накладная', 'товарно-транспортная\s+накладная', '\bТТН\b'],
    NULL
),
(
    'CMR', 'CMR (международная накладная)',
    'CMR — международная транспортная накладная. Мультиязычная (RU/EN/DE/PL...). Парсится через LLM /extract.',
    true, 'llm_extract',
    ARRAY['number','date','sender','recipient','carrier'],
    ARRAY['country_code:sender.country','country_code:recipient.country','date_range'],
    ARRAY['\bCMR\b', 'международная\s+товарно-транспортная'],
    NULL
),
(
    'AKT', 'Акт оказанных услуг / выполненных работ',
    'Акт — два контрагента, перечень услуг, итого. Парсится через LLM /extract.',
    true, 'llm_extract',
    ARRAY['number','date','party_a','party_b','total'],
    ARRAY['inn_checksum:party_a.inn','inn_checksum:party_b.inn','date_range','parties_differ:party_a.inn,party_b.inn','money_sanity:total','money_sanity:vat'],
    ARRAY['\bакт\b\s+(оказанных|выполненных|сдачи)', 'акт\s+об\s+оказании'],
    NULL
)
ON CONFLICT (slug) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_document_types_active ON document_types (is_active) WHERE is_active = true;

-- Down Migration

DROP TRIGGER IF EXISTS trg_document_types_updated_at ON document_types;
DROP INDEX IF EXISTS idx_document_types_active;
DROP TABLE IF EXISTS document_types;
