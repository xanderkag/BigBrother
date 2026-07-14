/**
 * audit #4: SSRF-гвард webhook_url.
 */
import { describe, expect, it } from 'vitest';
import { assertWebhookUrlSafe, isNeverWebhookTarget } from '../src/webhooks/ssrf-guard.js';

const okLookup = (address: string) => async () => [{ address }];

describe('isNeverWebhookTarget', () => {
  it('блокирует loopback / metadata / unspecified', () => {
    expect(isNeverWebhookTarget('127.0.0.1')).toBe(true);
    expect(isNeverWebhookTarget('169.254.169.254')).toBe(true); // cloud metadata
    expect(isNeverWebhookTarget('0.0.0.0')).toBe(true);
    expect(isNeverWebhookTarget('::1')).toBe(true);
    expect(isNeverWebhookTarget('fe80::1')).toBe(true);
    expect(isNeverWebhookTarget('::ffff:127.0.0.1')).toBe(true);
  });
  it('НЕ блокирует RFC1918 (корп. SLAI) и публичные', () => {
    expect(isNeverWebhookTarget('10.10.13.10')).toBe(false);
    expect(isNeverWebhookTarget('192.168.1.5')).toBe(false);
    expect(isNeverWebhookTarget('8.8.8.8')).toBe(false);
  });
});

describe('assertWebhookUrlSafe', () => {
  const opts = { blockAllPrivate: false };

  it('литеральная metadata-IP → бросает', async () => {
    await expect(assertWebhookUrlSafe('http://169.254.169.254/latest/meta-data', opts)).rejects.toThrow(/private|internal/i);
  });
  it('литеральный loopback → бросает', async () => {
    await expect(assertWebhookUrlSafe('http://127.0.0.1:8085/admin', opts)).rejects.toThrow();
  });
  it('RFC1918 (10.x) → ok по умолчанию (корп. приёмник)', async () => {
    await expect(assertWebhookUrlSafe('https://10.10.13.10/hook', opts)).resolves.toBeUndefined();
  });
  it('RFC1918 → бросает при blockAllPrivate=true', async () => {
    await expect(assertWebhookUrlSafe('https://10.10.13.10/hook', { blockAllPrivate: true })).rejects.toThrow();
  });
  it('публичный IP → ok', async () => {
    await expect(assertWebhookUrlSafe('https://8.8.8.8/hook', opts)).resolves.toBeUndefined();
  });
  it('хост резолвится в metadata → бросает', async () => {
    await expect(
      assertWebhookUrlSafe('https://evil.example.com/hook', { ...opts, lookupFn: okLookup('169.254.169.254') }),
    ).rejects.toThrow();
  });
  it('хост резолвится в публичный → ok', async () => {
    await expect(
      assertWebhookUrlSafe('https://slai.example.com/hook', { ...opts, lookupFn: okLookup('93.184.216.34') }),
    ).resolves.toBeUndefined();
  });
  it('хост не резолвится → ok (best-effort, транзиентный DNS)', async () => {
    const failLookup = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertWebhookUrlSafe('https://later.example.com/hook', { ...opts, lookupFn: failLookup })).resolves.toBeUndefined();
  });
  it('не-http схема → бросает', async () => {
    await expect(assertWebhookUrlSafe('ftp://host/x', opts)).rejects.toThrow(/scheme/i);
    await expect(assertWebhookUrlSafe('file:///etc/passwd', opts)).rejects.toThrow();
  });
  it('битый url → бросает', async () => {
    await expect(assertWebhookUrlSafe('not a url', opts)).rejects.toThrow(/malformed/i);
  });
});
