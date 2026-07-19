/**
 * F0e sanitizePartyInns (находка SLAI 2026-07-17): канонизация валидных ИНН
 * в extracted + отсев битых по длине/контрольной сумме (OCR-дрейф tesseract).
 * Эталон: 7811595513 (Ист-Вест) — checksum сходится; 7811595573 — дрейф, не сходится.
 */
import { describe, it, expect } from 'vitest';
import { sanitizePartyInns } from '../src/pipeline/normalize/sanitize-inns.js';

describe('sanitizePartyInns', () => {
  it('валидный ИНН с форматированием → канонизируется в extracted', () => {
    const out = sanitizePartyInns({ seller: { name: 'Ист-Вест', inn: '7811-595-513' } })!;
    expect((out.seller as { inn: string }).inn).toBe('7811595513');
    expect(out._inn_dropped).toBeUndefined();
  });

  it('битый по ДЛИНЕ (6 цифр) → зануляется + аудит _inn_dropped', () => {
    const out = sanitizePartyInns({ buyer: { name: 'X', inn: '193318' } })!;
    expect((out.buyer as { inn: unknown }).inn).toBeNull();
    expect((out._inn_dropped as Record<string, string>)['buyer.inn']).toBe('193318');
  });

  it('битый по КОНТРОЛЬНОЙ СУММЕ (7811595573, дрейф) → зануляется', () => {
    const out = sanitizePartyInns({ buyer: { name: 'Ист-Вест', inn: '7811595573' } })!;
    expect((out.buyer as { inn: unknown }).inn).toBeNull();
    expect((out._inn_dropped as Record<string, string>)['buyer.inn']).toBe('7811595573');
  });

  it('имя стороны сохраняется при отсеве ИНН (карточка не теряется)', () => {
    const out = sanitizePartyInns({ buyer: { name: 'ООО «Ист-Вест Лоджистик»', inn: '781595513' } })!;
    expect((out.buyer as { name: string }).name).toBe('ООО «Ист-Вест Лоджистик»');
    expect((out.buyer as { inn: unknown }).inn).toBeNull();
  });

  it('уже канонический валидный ИНН → идемпотентно (тот же объект)', () => {
    const ex = { seller: { inn: '7811595513' } };
    expect(sanitizePartyInns(ex)).toBe(ex);
  });

  it('покрывает client/expeditor (forwarding_order)', () => {
    const out = sanitizePartyInns({
      client: { name: 'A', inn: '7811595573' }, // битый
      expeditor: { name: 'B', inn: '7811-595-513' }, // валидный-формат
    })!;
    expect((out.client as { inn: unknown }).inn).toBeNull();
    expect((out.expeditor as { inn: string }).inn).toBe('7811595513');
  });

  it('смесь: seller валиден, buyer битый', () => {
    const out = sanitizePartyInns({
      seller: { inn: '7811595513' },
      buyer: { inn: '78178955019' }, // 11 цифр — битый
    })!;
    expect((out.seller as { inn: string }).inn).toBe('7811595513');
    expect((out.buyer as { inn: unknown }).inn).toBeNull();
  });

  it('нет inn / не-объект / пусто → no-op', () => {
    const ex1 = { seller: { name: 'X' } };
    expect(sanitizePartyInns(ex1)).toBe(ex1);
    expect(sanitizePartyInns(null)).toBeNull();
    const ex2 = { seller: 'строка' };
    expect(sanitizePartyInns(ex2)).toBe(ex2);
  });
});
