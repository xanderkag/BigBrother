-- Personal access tokens — UNIQUE индекс для быстрого lookup по хэшу.
--
-- Колонка `users.api_token_hash` уже была заведена в миграции 008 как
-- TEXT без ограничений. Сейчас включаем фичу — поэтому добавляем:
--   - UNIQUE constraint (partial, NULL'ы не конфликтуют) — два юзера не
--     могут иметь одинаковый хэш токена;
--   - индекс под точечный поиск в auth-хуке (по хэшу токена → user).
--
-- Сам формат токена и логика хэширования — в коде (`storage/users.ts`).
-- Plaintext-токен возвращается клиенту ровно один раз при генерации,
-- в БД хранится только sha256. Утечка дампа БД не утечёт ни одного
-- ключа в работающем виде.

-- Up Migration

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_api_token_hash
    ON users (api_token_hash)
    WHERE api_token_hash IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS uq_users_api_token_hash;
