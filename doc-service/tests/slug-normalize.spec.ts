/**
 * SLAI EOD-report 2026-05-17 Issue #3 — outbound slug normalize.
 *
 * Контракт фиксируется тестом — если кто-то поменяет таблицу алиасов,
 * тест упадёт и заставит читать комментарий (мб правка нужна и в SLAI).
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeSlugForApi,
  OUTBOUND_SLUG_ALIASES,
} from '../src/types/slug-normalize.js';

describe('normalizeSlugForApi — outbound slug перевод в SLAI-формат', () => {
  it('TTN → ttn', () => {
    expect(normalizeSlugForApi('TTN')).toBe('ttn');
  });

  it('UPD → upd', () => {
    expect(normalizeSlugForApi('UPD')).toBe('upd');
  });

  it('CMR → cmr', () => {
    expect(normalizeSlugForApi('CMR')).toBe('cmr');
  });

  it('AKT → services_act (SLAI naming convention)', () => {
    expect(normalizeSlugForApi('AKT')).toBe('services_act');
  });

  it('factInvoice → tax_invoice (SLAI naming convention)', () => {
    expect(normalizeSlugForApi('factInvoice')).toBe('tax_invoice');
  });

  it('уже-нормализованные слаги проходят без изменений', () => {
    expect(normalizeSlugForApi('invoice')).toBe('invoice');
    expect(normalizeSlugForApi('payment_order')).toBe('payment_order');
    expect(normalizeSlugForApi('transport_request')).toBe('transport_request');
    expect(normalizeSlugForApi('waybill')).toBe('waybill');
    expect(normalizeSlugForApi('transport_invoice')).toBe('transport_invoice');
  });

  it('null/undefined пробрасываются как есть', () => {
    expect(normalizeSlugForApi(null)).toBeNull();
    expect(normalizeSlugForApi(undefined)).toBeUndefined();
  });

  it('неизвестный слаг проходит без изменений (forward-compat)', () => {
    // Если завтра добавят новый тип документа — outbound translator не
    // должен ломаться, просто пропускает неизвестные слаги.
    expect(normalizeSlugForApi('some_new_type')).toBe('some_new_type');
  });

  it('таблица алиасов покрывает все исторические uppercase/camelCase', () => {
    // Sanity: убеждаемся что в таблице ровно 5 алиасов. Если 6+ —
    // вероятно добавили новый legacy slug, что само по себе плохо
    // (новые слаги должны быть lowercase snake_case сразу).
    expect(Object.keys(OUTBOUND_SLUG_ALIASES)).toEqual([
      'TTN',
      'UPD',
      'CMR',
      'AKT',
      'factInvoice',
    ]);
  });
});
