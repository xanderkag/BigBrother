/**
 * §4 SLAI (2026-07-19): ТН ВЭД структурным полем.
 *   - sanitizeHsCodes — канонизация + выброс мусора (артикулы, «22000»).
 *   - recoverHsCodesFromText — добор кода из текста позиции / raw_text.
 * Кейсы с живого потока (proforma 0/82; garbage в commercial_invoice).
 */
import { describe, it, expect } from 'vitest';
import { sanitizeHsCodes, recoverHsCodesFromText } from '../src/pipeline/normalize/hs-codes.js';

const CI = 'commercial_invoice';

describe('sanitizeHsCodes', () => {
  it('мусор в items[].hs_code → null + аудит _hs_dropped', () => {
    const out = sanitizeHsCodes({
      items: [{ name: 'A', hs_code: '22000' }, { name: 'B', hs_code: '6195622 1BBEABBV000051' }],
    })!;
    expect((out.items as any[])[0].hs_code).toBeNull();
    expect((out.items as any[])[1].hs_code).toBeNull();
    expect(out._hs_dropped).toEqual(expect.arrayContaining(['22000', '6195622 1BBEABBV000051']));
  });

  it('код с пробелами → канонизируется в цифры', () => {
    const out = sanitizeHsCodes({ items: [{ hs_code: '9403 20 080 9' }] })!;
    expect((out.items as any[])[0].hs_code).toBe('9403200809');
  });

  it('валидный 10-значный код → без изменений (идентичность)', () => {
    const ex = { items: [{ hs_code: '8547200009' }] };
    expect(sanitizeHsCodes(ex)).toBe(ex);
  });

  it('8-значный (ЕС) код валиден', () => {
    const ex = { items: [{ hs_code: '94032080' }] };
    expect(sanitizeHsCodes(ex)).toBe(ex);
  });

  it('doc-level hs_codes[]: чистит мусор и дедупает', () => {
    const out = sanitizeHsCodes({ hs_codes: ['8547200009', '22000', '8547200009', '9403 20 080 9'] })!;
    expect(out.hs_codes).toEqual(['8547200009', '9403200809']);
  });

  it('doc-level плоский hs_code-мусор → null', () => {
    const out = sanitizeHsCodes({ hs_code: 'ABC-123' })!;
    expect(out.hs_code).toBeNull();
    expect(out._hs_dropped).toContain('ABC-123');
  });

  it('нет hs-полей → no-op (идентичность)', () => {
    const ex = { items: [{ name: 'товар', qty: 1 }], seller: { name: 'X' } };
    expect(sanitizeHsCodes(ex)).toBe(ex);
  });

  it('идемпотентна', () => {
    const once = sanitizeHsCodes({ items: [{ hs_code: '9403 20 080 9' }, { hs_code: 'мусор' }] })!;
    const twice = sanitizeHsCodes(once)!;
    expect(twice).toEqual(once);
  });

  it('пустой/битый вход → как есть', () => {
    expect(sanitizeHsCodes(null)).toBeNull();
    expect(sanitizeHsCodes({})).toEqual({});
  });
});

describe('recoverHsCodesFromText', () => {
  it('per-item: код в названии позиции → в её hs_code', () => {
    const out = recoverHsCodesFromText(
      { items: [{ name: 'Диван офисный, ТН ВЭД 9401 20 080 9' }] },
      'прочий текст без метки',
      'proforma_invoice',
    )!;
    expect((out.items as any[])[0].hs_code).toBe('9401200809');
    expect(out._hs_recovered).toContain('9401200809');
  });

  it('doc-level: код по метке в raw_text → hs_codes[]', () => {
    const out = recoverHsCodesFromText(
      { items: [{ name: 'товар без кода' }] },
      'Ставка по коду ТН ВЭД 8547200009 применяется…',
      CI,
    )!;
    expect(out.hs_codes).toContain('8547200009');
  });

  it('валидный hs_code у позиции → НЕ перетираем', () => {
    const ex = { items: [{ name: 'ТН ВЭД 9999999999', hs_code: '8547200009' }] };
    const out = recoverHsCodesFromText(ex, '', CI);
    expect(out).toBe(ex);
  });

  it('не товарный тип → no-op', () => {
    const ex = { items: [{ name: 'ТН ВЭД 8547200009' }] };
    expect(recoverHsCodesFromText(ex, 'ТН ВЭД 8547200009', 'AKT')).toBe(ex);
  });

  it('нет метки ТН ВЭД в тексте → не выдумывает', () => {
    const ex = { items: [{ name: 'Артикул 8547200009 просто число' }] };
    expect(recoverHsCodesFromText(ex, 'счёт № 8547200009 от…', CI)).toBe(ex);
  });

  it('ГНГ/ЕТСНГ (ж/д) НЕ триггерят hs_code (другой классификатор)', () => {
    const ex = { items: [{ name: 'контейнер ГНГ 94032080' }] };
    expect(recoverHsCodesFromText(ex, 'ЕТСНГ 41302', CI)).toBe(ex);
  });

  it('нет rawText → no-op', () => {
    const ex = { items: [{ name: 'ТН ВЭД 8547200009' }] };
    expect(recoverHsCodesFromText(ex, null, CI)).toBe(ex);
  });

  it('идемпотентна', () => {
    const once = recoverHsCodesFromText(
      { items: [{ name: 'Насос, ТН ВЭД 8413309009' }] },
      'ТН ВЭД 8547200009',
      CI,
    )!;
    const twice = recoverHsCodesFromText(once, 'ТН ВЭД 8547200009', CI)!;
    expect(twice).toEqual(once);
  });
});
