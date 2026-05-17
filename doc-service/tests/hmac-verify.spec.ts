/**
 * F13: HMAC SHA-256 timing-safe verify для SLAI inbound webhook'ов.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyHmacSignature, verifySlaiSignature } from '../src/security/hmac-verify.js';

const SECRET = 'test-secret-32-bytes-of-entropy-XXX';

function signBody(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyHmacSignature — low-level', () => {
  it('валидная подпись → true', () => {
    const body = '{"event":"category.added","id":42}';
    const sig = signBody(body);
    expect(verifyHmacSignature(body, sig, SECRET)).toBe(true);
  });

  it('подпись с другим секретом → false', () => {
    const body = '{"event":"category.added"}';
    const wrongSig = signBody(body, 'other-secret');
    expect(verifyHmacSignature(body, wrongSig, SECRET)).toBe(false);
  });

  it('изменённое body → false', () => {
    const original = '{"event":"category.added","id":42}';
    const sig = signBody(original);
    const tampered = '{"event":"category.added","id":99}';
    expect(verifyHmacSignature(tampered, sig, SECRET)).toBe(false);
  });

  it('header без префикса sha256= тоже принимается', () => {
    const body = 'payload';
    const fullSig = signBody(body);
    const hexOnly = fullSig.replace('sha256=', '');
    expect(verifyHmacSignature(body, hexOnly, SECRET)).toBe(true);
  });

  it('пустой header → false', () => {
    expect(verifyHmacSignature('body', '', SECRET)).toBe(false);
    expect(verifyHmacSignature('body', null, SECRET)).toBe(false);
    expect(verifyHmacSignature('body', undefined, SECRET)).toBe(false);
  });

  it('пустой секрет → false (fail-closed)', () => {
    expect(verifyHmacSignature('body', signBody('body'), '')).toBe(false);
  });

  it('header с невалидным hex → false (не RangeError)', () => {
    expect(verifyHmacSignature('body', 'sha256=not-hex-chars', SECRET)).toBe(false);
    expect(verifyHmacSignature('body', 'sha256=', SECRET)).toBe(false);
  });

  it('header с укороченным hex → false', () => {
    expect(verifyHmacSignature('body', 'sha256=abc123', SECRET)).toBe(false);
  });

  it('Buffer body работает так же как string', () => {
    const body = 'тест с кириллицей';
    const sig = signBody(body);
    expect(verifyHmacSignature(body, sig, SECRET)).toBe(true);
    expect(verifyHmacSignature(Buffer.from(body, 'utf-8'), sig, SECRET)).toBe(true);
  });

  it('UTF-8 body — те же байты дают ту же подпись', () => {
    const body = '{"name":"Молоко"}';
    const sig = createHmac('sha256', SECRET).update(body, 'utf-8').digest('hex');
    expect(verifyHmacSignature(body, sig, SECRET)).toBe(true);
  });
});

describe('verifySlaiSignature — высокий уровень с version check', () => {
  it('всё валидно → null', () => {
    const body = '{"event":"category.added"}';
    const headers = {
      'x-slai-signature': signBody(body),
      'x-slai-version': 'v1',
    };
    expect(verifySlaiSignature(body, headers, SECRET)).toBeNull();
  });

  it('секрет не настроен → ошибка', () => {
    const body = '{"event":"category.added"}';
    const err = verifySlaiSignature(body, {}, undefined);
    expect(err).toMatch(/not configured/);
  });

  it('header version отсутствует → ошибка', () => {
    const body = '{"x":1}';
    const headers = { 'x-slai-signature': signBody(body) };
    expect(verifySlaiSignature(body, headers, SECRET)).toMatch(/Version/);
  });

  it('unsupported version v2 → ошибка', () => {
    const body = '{}';
    const headers = {
      'x-slai-signature': signBody(body),
      'x-slai-version': 'v2',
    };
    expect(verifySlaiSignature(body, headers, SECRET)).toMatch(/unsupported SLAI version/);
  });

  it('signature header отсутствует → ошибка', () => {
    const headers = { 'x-slai-version': 'v1' };
    expect(verifySlaiSignature('body', headers, SECRET)).toMatch(/Signature header missing/);
  });

  it('body undefined → ошибка', () => {
    expect(verifySlaiSignature(undefined, { 'x-slai-version': 'v1' }, SECRET)).toMatch(
      /body missing/,
    );
  });

  it('case-insensitive headers', () => {
    const body = '{}';
    const headers = {
      'X-SLAI-Signature': signBody(body),
      'X-SLAI-Version': 'v1',
    };
    expect(verifySlaiSignature(body, headers, SECRET)).toBeNull();
  });
});
