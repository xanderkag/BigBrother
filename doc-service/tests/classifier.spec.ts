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

describe('KeywordClassifier — filename signal (weighted booster / tie-breaker)', () => {
  // Прогон по hardcoded-fallback (БД недоступна). Проверяем механику
  // filename-сигнала: title-boost-gate флипа, agree-boost, generic-имена.
  documentTypeResolver.invalidate();
  const c = new KeywordClassifier();

  it('flips when content has NO match — filename decides type (Act_* → AKT)', async () => {
    // Контент ничего не матчит (fallback → null), имя переворачивает на AKT.
    const r = await c.classify(
      'Приложение к отгрузке. Container MSKU1234567. Место 1.',
      null,
      'Act_260127-051.pdf',
    );
    expect(r.type).toBe('AKT');
    expect(r.matched).toContain('filename');
  });

  it('flips to TTN from filename when content is weak (ТТН_* → TTN)', async () => {
    const r = await c.classify('Груз получен. Транспортное средство А123БВ.', null, 'ТТН_28.01.2026.pdf');
    expect(r.type).toBe('TTN');
  });

  it('flips to bill_of_lading from *MBL filename', async () => {
    const r = await c.classify('Shipment details, container list.', null, '988726MBL.xls');
    expect(r.type).toBe('bill_of_lading');
  });

  it('VAT invoice filename → factInvoice (specific marker beats generic invoice)', async () => {
    const r = await c.classify('Some shipping text without keywords.', null, 'VAT_invoice_260127-051.pdf');
    expect(r.type).toBe('factInvoice');
  });

  it('generic filename does NOT force a type', async () => {
    const r = await c.classify('Hello world, totally unrelated text.', null, 'Скан_документа_финал.pdf');
    expect(r.type).toBeNull();
  });

  it('does NOT override a title-boosted strong content match (АКТ heading stays АКТ despite invoice-ish name)', async () => {
    // «АКТ выполненных» стоит в самом начале (chars 0..) → title-boosted =
    // сильный сигнал. Имя «Счет» (marker=invoice) НЕ переворачивает.
    const r = await c.classify('АКТ выполненных работ № 42 от 10.03.2026', null, 'Счет_на_оплату_042.pdf');
    expect(r.type).toBe('AKT');
  });

  it('does NOT flip a title-boosted content winner even if filename marker differs (Заявка-guard)', async () => {
    // Заголовок «Счёт-фактура» title-boosted → factInvoice. Имя «Заявка»
    // (marker=transport_request) не должно перевернуть strong заголовок.
    const r = await c.classify('Счёт-фактура № 7 от 02.02.2026', null, 'Заявка_ИСТ-ВЕСТ.pdf');
    expect(r.type).toBe('factInvoice');
  });

  it('filename agreeing with content boosts confidence (never lowers it)', async () => {
    const noName = await c.classify('ТРАНСПОРТНАЯ НАКЛАДНАЯ № 123 от 15.01.2026');
    const withName = await c.classify('ТРАНСПОРТНАЯ НАКЛАДНАЯ № 123 от 15.01.2026', null, 'ТТН_123.pdf');
    expect(withName.type).toBe('TTN');
    expect(noName.type).toBe('TTN');
    expect(withName.confidence).toBeGreaterThanOrEqual(noName.confidence);
  });

  it('already-correct doc with unrelated filename is unchanged', async () => {
    const r = await c.classify('Счёт-фактура № 7 от 02.02.2026', null, 'random_scan_001.pdf');
    expect(r.type).toBe('factInvoice');
  });
});
