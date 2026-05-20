-- Up Migration
--
-- Per-organization consumer profile (multi-tenancy CP7, фаза 2).
--
-- 1:1 с organizations. Хранит "как потребитель хочет, чтобы пайплайн
-- себя вёл" и "куда выгружать результат". Phase 1 дал per-org типы
-- документов; здесь — поведенческий профиль организации.
--
-- Семантика (enforce'ится в Phase 3, не здесь):
--   mode='classify_only'   ⇒ пайплайн пропускает extract-стадию (дешевле;
--                            для потребителей, которым нужен только тип).
--   mode='extract'         ⇒ полный прогон (default).
--   output='webhook'       ⇒ финализированные job'ы POST'ятся на webhook_url
--                            с HMAC-подписью из webhook_hmac_secret.
--   output='pull'          ⇒ без push; UI потребителя сам зовёт GET /jobs/:id.
--   auto_approve_threshold ⇒ переопределяет глобальный config.thresholds.needsReview
--                            для job'ов этой орг. NULL = глобальный default.
--
-- webhook_hmac_secret хранится ЗАШИФРОВАННЫМ (envelope v1: через encryptSecret),
-- никогда plaintext'ом. Storage-слой шифрует на write, дешифрует на read.
--
-- Отсутствие строки = "все defaults" (storage.get() возвращает дефолт-профиль).
-- Seed-строки не нужны.

CREATE TABLE organization_settings (
    organization_id        UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    mode                   TEXT NOT NULL DEFAULT 'extract'
                             CHECK (mode IN ('extract', 'classify_only')),
    output                 TEXT NOT NULL DEFAULT 'pull'
                             CHECK (output IN ('webhook', 'pull')),
    webhook_url            TEXT,
    webhook_hmac_secret    TEXT,
    auto_approve_threshold NUMERIC,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS organization_settings;
