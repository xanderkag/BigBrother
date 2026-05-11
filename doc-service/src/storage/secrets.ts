import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';

/**
 * Envelope-шифрование для секретов, хранящихся в БД (api-ключи провайдеров,
 * в будущем — webhook-секреты per-tenant, и т.п.).
 *
 * Зачем: до этой фичи `provider_settings.api_key` лежал plaintext'ом.
 * Любой, у кого есть доступ к pg_dump / реплике / бэкапу / SQL injection
 * — получал ключи Anthropic, OpenAI, Yandex Vision в открытом виде.
 * Теперь в БД лежит непрозрачный envelope; для дешифровки нужен
 * `SECRETS_ENCRYPTION_KEY` из env-переменной приложения.
 *
 * Алгоритм: AES-256-GCM (auth-encryption). 12-байт случайный IV
 * генерируется на каждый шифр-вызов — два одинаковых plaintext'а
 * никогда не дадут одинаковый ciphertext. GCM-tag (16 байт) подмешан
 * в envelope и проверяется при дешифровке — отлавливает порчу/подмену.
 *
 * Формат envelope: `v1:<base64(iv || ciphertext || tag)>`.
 * Префикс «v1:» — версионный, легко проверяется визуально и в SQL,
 * и оставляет место под смену алгоритма (v2: AES-GCM-SIV, KMS wrap,
 * etc.) без break'а старых строк.
 *
 * Lazy-миграция: `decryptSecret` принимает И envelope с префиксом, И
 * сырой plaintext. Plaintext возвращается как есть. Так старые ключи
 * до миграции продолжают работать в hot-path, а на следующем write
 * репо положит уже зашифрованный envelope. После окончания периода
 * миграции можно выкинуть legacy-ветку (см. TECH_DEBT).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM
const TAG_LENGTH = 16;
const VERSION = 'v1';
const ENVELOPE_PREFIX = `${VERSION}:`;

/**
 * Получить master-ключ. Если в env задан `SECRETS_ENCRYPTION_KEY` —
 * парсим его как 64-символьную hex-строку (= 32 байта).
 *
 * Если ключ пустой:
 *   - В production режиме (NODE_ENV=production) → hard error на старте.
 *   - В dev/test → используется detrministic dev-default, выведенный
 *     из строки 'parsdocs-dev-key'. Это позволяет poднимать dev-стенд
 *     без явной настройки, но НЕ годится для prod (один и тот же ключ
 *     у всех разработчиков платформы).
 */
let cachedKey: Buffer | null = null;
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = config.secretsEncryptionKey;
  if (raw && raw.length > 0) {
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(
        'SECRETS_ENCRYPTION_KEY должен быть 64-hex-символьной строкой ' +
          '(сгенерируйте: `openssl rand -hex 32`). Текущее значение не подходит.',
      );
    }
    cachedKey = Buffer.from(raw, 'hex');
    return cachedKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY обязателен в production. ' +
        'Сгенерируйте: `openssl rand -hex 32` и пропишите в env.',
    );
  }
  // Dev-fallback: deterministic SHA-256 от константы. Loud warning один раз.
  if (!cachedKey) {
    // eslint-disable-next-line no-console
    console.warn(
      '[secrets] SECRETS_ENCRYPTION_KEY не задан — использую dev-default. ' +
        'Не годится для prod: данные, зашифрованные этим ключом, легко расшифровать.',
    );
  }
  cachedKey = createHash('sha256').update('parsdocs-dev-key').digest();
  return cachedKey;
}

/** Только для тестов — позволяет подменять master-key между прогонами. */
export function _resetKeyCacheForTesting(): void {
  cachedKey = null;
}

/**
 * Низкоуровневое шифрование: принимает explicit-ключ. Используется
 * rotate-скриптом, который работает с двумя ключами одновременно
 * (старый для дешифровки, новый для перешифровки). Обычный hot-path
 * использует `encryptSecret` ниже, который тянет ключ из env.
 */
export function encryptWithKey(plaintext: string | null, key: Buffer): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return plaintext as null;
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([iv, ciphertext, tag]).toString('base64');
  return `${ENVELOPE_PREFIX}${envelope}`;
}

/**
 * Зашифровать строку. Возвращает envelope с префиксом `v1:`.
 * Пустые/null входы возвращаются как есть (нечего шифровать) — это
 * корректно описывает «ключ не задан».
 */
export function encryptSecret(plaintext: string | null): string | null {
  return encryptWithKey(plaintext, getMasterKey());
}

/**
 * Низкоуровневая расшифровка с explicit-ключом. См. `encryptWithKey`
 * для use-case (rotate с двумя ключами).
 */
export function decryptWithKey(envelope: string | null, key: Buffer): string | null {
  if (envelope === null || envelope === undefined || envelope === '') {
    return envelope as null;
  }
  if (!envelope.startsWith(ENVELOPE_PREFIX)) {
    return envelope; // legacy plaintext
  }
  const raw = envelope.slice(ENVELOPE_PREFIX.length);
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('decryptSecret: невалидный base64 в envelope');
  }
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('decryptSecret: envelope слишком короткий (повреждён?)');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error(
      `decryptSecret: проверка целостности не прошла (key mismatch / corruption). ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Расшифровать envelope. Поведение:
 *   - `null` / пустая строка → возвращается как есть (нет ключа).
 *   - Строка с префиксом `v1:` → пытаемся расшифровать. При невалидной
 *     подписи (key-mismatch, повреждение) бросаем понятную ошибку.
 *   - Без префикса → legacy plaintext. Возвращаем как есть. После
 *     любого следующего write строка превратится в envelope.
 */
export function decryptSecret(envelope: string | null): string | null {
  return decryptWithKey(envelope, getMasterKey());
}

/** Парсер hex-ключа. Используется rotate-скриптом для argv. */
export function parseHexKey(raw: string, label = 'key'): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${label} должен быть 64-hex-символьной строкой (32 байта)`);
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Проверка: лежит ли строка в новом encrypted-формате? Полезно
 * для миграционного скрипта, чтобы отличать «уже зашифровано» от
 * «надо зашифровать».
 */
export function isEncrypted(value: string | null): boolean {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}
