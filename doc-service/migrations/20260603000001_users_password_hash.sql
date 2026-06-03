-- Добавляем password_hash для UX-AUTH: вход в operator UI по email+password
-- (вместо вставки длинного pdpat_-токена руками).
--
-- Формат хеша: `scrypt$<saltHex>$<derivedKeyHex>` — встроенный в Node crypto,
-- без extra deps (bcrypt/argon2). 16 байт salt, 64 байта вывод, N=2^14, r=8, p=1.
--
-- При успешном логине backend создаёт долгоживущий PAT через tokens repo
-- и возвращает plaintext — UI хранит его как раньше (Bearer). Password_hash
-- только для шага login; в Bearer-цепочку не вмешиваемся.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash TEXT;

COMMENT ON COLUMN users.password_hash IS
  'scrypt$<saltHex>$<derivedKeyHex>; для POST /api/v1/auth/login. NULL — login by password выключен.';
