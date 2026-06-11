-- Service accounts: API-ключи принадлежат СИСТЕМЕ (SLAI / 1С / Bitrix),
-- а не человеку. Реализуем как `kind` на существующей модели users:
--   human   — обычный пользователь operator UI (логин по email+password).
--   service — интеграционная система; email необязателен (логина нет),
--             role применяется как и раньше, токены выдаются per-account.
--
-- Существующие строки становятся 'human' через DEFAULT (login by password,
-- project-доступы и т.п. у них уже есть).

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'human'
        CHECK (kind IN ('human', 'service'));

COMMENT ON COLUMN users.kind IS
  'human — пользователь UI; service — интеграционная система (SLAI/1С/Bitrix), email необязателен.';
