-- Provider Settings + Audit Log — admin layer для конфигурации платформы.
--
-- Зачем:
--   1) `provider_settings` — реестр внешних провайдеров (Anthropic, OpenAI,
--      Yandex Vision, локальный Qwen/Ollama). Сейчас ключи и URL'ы живут в
--      env, что ок для деплоя, но не даёт админу через UI:
--        - сменить ключ без перезапуска контейнера;
--        - переключить «активного» LLM-провайдера;
--        - хранить несколько профилей (prod-Claude, dev-stub) рядом.
--      Таблица — единый source of truth. На первой итерации hot-path всё
--      ещё умеет читать env как fallback; DB-значения выигрывают, если есть.
--
--   2) `audit_log` — запись всех админ-изменений document_types и
--      provider_settings: кто, когда, что было, что стало. Без аудита
--      менять конфигурацию через UI страшно — нет отката, нет следа.
--      `actor` пока 'admin' (один Bearer-токен), под будущий multi-user
--      колонка готова.
--
-- Безопасность хранения ключей:
--   На MVP `api_key` хранится plaintext в БД. Доступ к БД и к /provider-settings
--   уже защищён Bearer auth. Для prod в следующем cycle планируется envelope
--   encryption (KMS / pgcrypto), записываем в TECH_DEBT.

-- Up Migration

CREATE TABLE IF NOT EXISTS provider_settings (
    id              TEXT PRIMARY KEY,                            -- 'anthropic' / 'openai' / 'yandex-vision' / 'qwen-local'
    kind            TEXT NOT NULL
                    CHECK (kind IN ('llm', 'ocr')),              -- категория: LLM-провайдер или OCR-движок
    display_name    TEXT NOT NULL,
    description     TEXT,
    base_url        TEXT,                                        -- NULL допустим (SDK-defaults для hosted)
    api_key         TEXT,                                        -- секрет; в API возвращаем маскированным
    model           TEXT,                                        -- 'claude-sonnet-4-5', 'qwen2.5-vl', ...
    is_active       BOOLEAN NOT NULL DEFAULT true,               -- inactive = не виден в выборе провайдера
    is_default      BOOLEAN NOT NULL DEFAULT false,              -- ровно один default per kind (см. partial UNIQUE ниже)
    extra           JSONB,                                       -- доп. конфиг: { folder_id, region, max_tokens }
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ровно один is_default=true на каждый kind. Меняется через "set default" атомарной транзакцией в repo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_settings_default_per_kind
    ON provider_settings (kind) WHERE is_default = true;

DROP TRIGGER IF EXISTS trg_provider_settings_updated_at ON provider_settings;
CREATE TRIGGER trg_provider_settings_updated_at
    BEFORE UPDATE ON provider_settings
    FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();

CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor       TEXT NOT NULL,                                   -- 'admin' пока; user_id когда появится auth
    entity      TEXT NOT NULL
                CHECK (entity IN ('document_type', 'provider_setting')),
    entity_id   TEXT NOT NULL,                                   -- slug или provider_settings.id
    action      TEXT NOT NULL
                CHECK (action IN ('create', 'update', 'delete')),
    before      JSONB,                                           -- NULL для create
    after       JSONB,                                           -- NULL для delete
    diff        JSONB                                            -- опционально: пары { field: { from, to } } для UI
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);

-- Seed: маркеры провайдеров с пустыми ключами — чтобы UI сразу что-то показал.
-- Реальные ключи админ ставит через UI; пока api_key=NULL, в hot-path используется
-- env-fallback (если задан), иначе провайдер недоступен.
INSERT INTO provider_settings (id, kind, display_name, description, model, is_active, is_default) VALUES
    ('anthropic',     'llm', 'Anthropic Claude',
     'Hosted Anthropic API. Лучшее качество для русскоязычной классификации и extract на сложных документах.',
     'claude-sonnet-4-5', false, false),
    ('openai',        'llm', 'OpenAI GPT',
     'Hosted OpenAI API. Резервный вариант, если Anthropic недоступен.',
     'gpt-4o-mini', false, false),
    ('qwen-local',    'llm', 'Qwen 2.5 VL (локально)',
     'Локальная LLM на собственном GPU. Полностью offline, без отправки данных наружу. Требует развёртывания.',
     'qwen2.5-vl-7b-instruct', false, false),
    ('stub',          'llm', 'Stub (без LLM)',
     'Заглушка для unit-тестов и dev-окружения. Возвращает фиксированные пустые ответы. Используется по умолчанию, если ни один реальный провайдер не настроен.',
     NULL, true, true),
    ('tesseract',     'ocr', 'Tesseract (локально)',
     'Локальный OCR (системный бинарь). Бесплатный, offline, средне по качеству для рукописных и сложных форм.',
     NULL, true, true),
    ('yandex-vision', 'ocr', 'Yandex Vision',
     'Yandex Cloud Vision API. Высокое качество на русском, но изображения уходят в облако — НЕ использовать на ПДн.',
     NULL, false, false)
ON CONFLICT (id) DO NOTHING;

-- Down Migration

DROP TRIGGER IF EXISTS trg_provider_settings_updated_at ON provider_settings;
DROP INDEX IF EXISTS uq_provider_settings_default_per_kind;
DROP TABLE IF EXISTS provider_settings;

DROP INDEX IF EXISTS idx_audit_log_entity;
DROP INDEX IF EXISTS idx_audit_log_at;
DROP TABLE IF EXISTS audit_log;
