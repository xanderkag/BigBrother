import { describe, it, expect } from 'vitest';

// Минимум env для config.ts (KeywordClassifier теперь транзитивно тянет
// documentTypeResolver → db → config). В этих тестах БД физически не
// дёргается: resolver.listActive() при отсутствии коннекта ловит ошибку
// и возвращает [], после чего отрабатывает hardcoded fallback — что и
// проверяют тесты ниже.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { KeywordClassifier } from '../src/pipeline/classifier/keywords.js';
import { documentTypeResolver } from '../src/pipeline/document-type-resolver.js';

describe('KeywordClassifier — hardcoded fallback (DB unreachable)', () => {
  // Сбрасываем кэш resolver'а на старте, чтобы первый classify в каждом
  // describe попадал в свежий path: пытаемся в DB → catch → [] → hardcoded.
  documentTypeResolver.invalidate();
  const c = new KeywordClassifier();

  it('detects ТТН', async () => {
    const r = await c.classify('ТРАНСПОРТНАЯ НАКЛАДНАЯ № 123 от 15.01.2026');
    expect(r.type).toBe('TTN');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('detects УПД', async () => {
    const r = await c.classify('Универсальный передаточный документ № 5 от 01.02.2026');
    expect(r.type).toBe('UPD');
  });

  it('detects CMR', async () => {
    const r = await c.classify('CMR International Consignment Note № 999');
    expect(r.type).toBe('CMR');
  });

  it('detects АКТ', async () => {
    const r = await c.classify('АКТ выполненных работ № 42 от 10.03.2026');
    expect(r.type).toBe('AKT');
  });

  it('detects счёт-фактура as factInvoice', async () => {
    const r = await c.classify('Счёт-фактура № 7 от 02.02.2026');
    expect(r.type).toBe('factInvoice');
  });

  it('detects plain счёт as invoice', async () => {
    const r = await c.classify('Счёт на оплату № 100 от 01.03.2026');
    expect(r.type).toBe('invoice');
  });

  it('returns null on noise', async () => {
    const r = await c.classify('Hello world, totally unrelated text.');
    expect(r.type).toBeNull();
  });
});
