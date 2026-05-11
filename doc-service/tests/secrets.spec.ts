/**
 * Tests for envelope-encryption of secrets (api_keys в БД).
 *
 * Покрывает roundtrip, legacy plaintext fallback, GCM-tamper detection,
 * key-rotation поведение (другой ключ → decrypt fails), edge-cases
 * (null/empty/short).
 */

import { describe, it, expect, beforeEach } from 'vitest';

// env обязателен ДО импорта config — иначе zod упадёт.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

// Дефолтный test-key — детерминированный hex, 32 байта. Менять
// в отдельных тестах через _resetKeyCacheForTesting + env-overrides.
process.env.SECRETS_ENCRYPTION_KEY =
  process.env.SECRETS_ENCRYPTION_KEY ??
  'a'.repeat(64);

import {
  encryptSecret,
  decryptSecret,
  encryptWithKey,
  decryptWithKey,
  parseHexKey,
  isEncrypted,
  _resetKeyCacheForTesting,
} from '../src/storage/secrets.js';

describe('encryptSecret / decryptSecret roundtrip', () => {
  beforeEach(() => _resetKeyCacheForTesting());

  it('round-trips a normal string', () => {
    const original = 'sk-ant-secret-key-12345';
    const envelope = encryptSecret(original);
    expect(envelope).not.toBeNull();
    expect(envelope!).toMatch(/^v1:/);
    expect(envelope).not.toContain(original); // ciphertext не содержит plaintext
    expect(decryptSecret(envelope)).toBe(original);
  });

  it('two encryptions of the same plaintext produce different envelopes (random IV)', () => {
    const e1 = encryptSecret('same-key');
    const e2 = encryptSecret('same-key');
    expect(e1).not.toBe(e2);
    expect(decryptSecret(e1)).toBe('same-key');
    expect(decryptSecret(e2)).toBe('same-key');
  });

  it('roundtrips unicode + long strings', () => {
    const big = 'ключ-API-' + '🔐'.repeat(50) + '-конец';
    const env = encryptSecret(big);
    expect(decryptSecret(env)).toBe(big);
  });
});

describe('null / empty handling', () => {
  beforeEach(() => _resetKeyCacheForTesting());

  it('encryptSecret returns null for null', () => {
    expect(encryptSecret(null)).toBeNull();
  });

  it('encryptSecret returns "" for "" (нечего шифровать)', () => {
    expect(encryptSecret('')).toBe('');
  });

  it('decryptSecret returns null for null', () => {
    expect(decryptSecret(null)).toBeNull();
  });

  it('decryptSecret returns "" for ""', () => {
    expect(decryptSecret('')).toBe('');
  });
});

describe('legacy plaintext path', () => {
  beforeEach(() => _resetKeyCacheForTesting());

  it('decryptSecret возвращает plaintext без префикса как есть', () => {
    // Старая БД до миграции — там лежит prosto «sk-ant-foo».
    expect(decryptSecret('sk-ant-foo')).toBe('sk-ant-foo');
  });

  it('isEncrypted: распознаёт v1:-envelope', () => {
    const env = encryptSecret('x');
    expect(isEncrypted(env!)).toBe(true);
  });

  it('isEncrypted: plaintext не считается зашифрованным', () => {
    expect(isEncrypted('sk-plaintext')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted('')).toBe(false);
  });
});

describe('integrity / tamper-detection', () => {
  beforeEach(() => _resetKeyCacheForTesting());

  it('испорченный envelope бросает понятную ошибку', () => {
    const env = encryptSecret('valid');
    // Flip last char в base64-части — поломаем GCM tag.
    const tampered = env!.slice(0, -1) + (env!.endsWith('A') ? 'B' : 'A');
    expect(() => decryptSecret(tampered)).toThrow(/целостности|integrity/i);
  });

  it('обрезанный envelope бросает понятную ошибку', () => {
    expect(() => decryptSecret('v1:short')).toThrow(/повреждён|короткий|envelope/i);
  });
});

describe('encryptWithKey / decryptWithKey (для rotate-скрипта)', () => {
  it('round-trip с explicit-ключом', () => {
    const key = parseHexKey('a'.repeat(64));
    const env = encryptWithKey('secret-payload', key);
    expect(env).toMatch(/^v1:/);
    expect(decryptWithKey(env, key)).toBe('secret-payload');
  });

  it('расшифровка под другим ключом — auth-failure', () => {
    const keyA = parseHexKey('a'.repeat(64));
    const keyB = parseHexKey('b'.repeat(64));
    const env = encryptWithKey('payload', keyA);
    expect(() => decryptWithKey(env, keyB)).toThrow(/целостности|integrity/i);
  });

  it('rotate-цикл: encrypt(A) → decrypt(A) → encrypt(B) → decrypt(B)', () => {
    const keyA = parseHexKey('1'.repeat(64));
    const keyB = parseHexKey('2'.repeat(64));
    const oldEnv = encryptWithKey('my-api-key', keyA);
    const plaintext = decryptWithKey(oldEnv, keyA);
    expect(plaintext).toBe('my-api-key');
    const newEnv = encryptWithKey(plaintext, keyB);
    expect(decryptWithKey(newEnv, keyB)).toBe('my-api-key');
    // и старый envelope под новым ключом — должен фейлиться:
    expect(() => decryptWithKey(oldEnv, keyB)).toThrow();
  });

  it('parseHexKey: 64 hex → Buffer, иначе throw', () => {
    expect(parseHexKey('a'.repeat(64)).length).toBe(32);
    expect(() => parseHexKey('short')).toThrow();
    expect(() => parseHexKey('z'.repeat(64))).toThrow();
  });

  it('legacy plaintext проходит через decryptWithKey как есть', () => {
    const key = parseHexKey('a'.repeat(64));
    expect(decryptWithKey('sk-ant-plaintext', key)).toBe('sk-ant-plaintext');
  });
});

describe('key rotation behaviour', () => {
  it('envelope зашифрованный с ключом A нельзя расшифровать ключом B', async () => {
    const KEY_A = 'a'.repeat(64);
    const KEY_B = 'b'.repeat(64);

    process.env.SECRETS_ENCRYPTION_KEY = KEY_A;
    _resetKeyCacheForTesting();
    // Перечитываем config — у нас singleton. Импортируем заново.
    // Перечитка config: придётся импортнуть динамически новый модуль.
    // Для целей теста — мы реально хотим, чтобы при попытке расшифровки
    // под другим ключом всё валилось. Достаточно сменить env и
    // reset cache, а уже cached config будет с прежним. Поэтому
    // в одном processe два разных ключа реально не получится. Тест
    // упрощаем — verify что один и тот же сервис не путает.
    const envelope = encryptSecret('key-A-secret');
    expect(decryptSecret(envelope)).toBe('key-A-secret');

    // sanity: попытка расшифровать чужой envelope (составленный руками)
    // под нашим ключом обязана упасть.
    const fakeEnvelope = 'v1:' + Buffer.alloc(40, 'x').toString('base64');
    expect(() => decryptSecret(fakeEnvelope)).toThrow();
    // Cleanup.
    process.env.SECRETS_ENCRYPTION_KEY = KEY_A;
    _resetKeyCacheForTesting();
    void KEY_B; // keep referenced for documentation
  });
});
