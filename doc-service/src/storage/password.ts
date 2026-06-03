/**
 * Password hashing для UX-AUTH (POST /api/v1/auth/login).
 *
 * Используем встроенный node:crypto.scrypt — без дополнительных deps
 * (bcrypt/argon2 потребовали бы prebuilt nat. binaries). Параметры:
 *
 *   N = 2^14 (16384) — стандарт OWASP минимум на 2024
 *   r = 8
 *   p = 1
 *   keylen = 64 байта
 *   salt   = 16 байт random
 *
 * Формат строки: `scrypt$<saltHex>$<keyHex>`.
 *
 * Время на server-class CPU ≈ 60-100ms — приемлемо для login endpoint
 * (rate-limit отсекает brute-force). Для оффлайн-словаря — на 16B соли
 * добавляет фактор 2^128, что делает rainbow-tables бесполезными.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;
const SALT_BYTES = 16;
const SCHEME = 'scrypt';

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 6) {
    throw new Error('password too short (min 6 chars)');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plaintext, salt, KEYLEN);
  return `${SCHEME}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(plaintext: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== SCHEME) return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (expected.length !== KEYLEN) return false;
  const derived = await scryptAsync(plaintext, salt, KEYLEN);
  return timingSafeEqual(derived, expected);
}
