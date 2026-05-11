-- Multi-token модель: каждый user имеет N токенов, каждый с подписью
-- (label), опц. сроком действия и треком last_used_at.
--
-- До этой миграции существовала однотокенная модель через колонку
-- `users.api_token_hash`. Она остаётся как legacy-слот для уже выданных
-- токенов (auth-хук проверяет ОБА источника), новые токены идут в эту
-- таблицу. Когда легаси полностью вымоется — колонку можно дропнуть
-- отдельной миграцией.
--
-- Use-case'ы:
--   - Один user, разные токены для CI / dev-машины / IDE-плагина:
--     каждый помечен `label` и при компрометации можно отозвать только
--     один без обнуления остальных.
--   - Токены под автоматизации с истечением: `expires_at` = now() + 90d,
--     ротация без участия владельца.
--   - Авдит активности: `last_used_at` обновляется в auth-хуке (best-effort,
--     не блокируя запрос), позволяет видеть «этот токен не использовался
--     с марта — можно отзывать».

-- Up Migration

CREATE TABLE IF NOT EXISTS personal_access_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Подпись токена для оператора (e.g. "github-ci", "macbook-pro", "1c-bridge").
    -- Уникальная в пределах одного юзера, чтобы случайно не создать два
    -- одинаковых.
    name          TEXT NOT NULL,
    -- sha-256 plaintext'а; plaintext возвращается caller'у ровно один раз
    -- при создании, дальше виден только хэш.
    token_hash    TEXT NOT NULL,
    -- NULL = бессрочный. Иначе после `now() > expires_at` auth-хук
    -- отклоняет запрос с 401.
    expires_at    TIMESTAMPTZ,
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

-- Индекс под точечный lookup в auth-хуке. UNIQUE — два юзера не могут
-- иметь одинаковый hash (вероятность коллизии sha-256 пренебрежимо мала,
-- но защищаемся от ошибки в коде, не от математики).
CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_tokens_hash
    ON personal_access_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_personal_tokens_user
    ON personal_access_tokens (user_id);

-- Down Migration

DROP INDEX IF EXISTS uq_personal_tokens_hash;
DROP INDEX IF EXISTS idx_personal_tokens_user;
DROP TABLE IF EXISTS personal_access_tokens;
