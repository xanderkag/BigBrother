/**
 * §8.3 (CLASSIFIER-PACKET-V2, ПДн-блокер): allowlist-пост-фильтр для
 * документов-удостоверений. Гарантия, что персональные поля не выживают,
 * даже если LLM вернула их сверх схемы.
 */
import { describe, expect, it } from 'vitest';
import {
  applyIdAllowlist,
  isIdDocument,
  buildIdSegmentExtract,
} from '../src/pipeline/normalize/id-allowlist.js';

describe('applyIdAllowlist — срез ПДн у ID-документа', () => {
  it('оставляет только {doc_kind,country,present} при driver_passport', () => {
    const out = applyIdAllowlist(
      {
        doc_kind: 'id',
        country: 'BY',
        present: true,
        // всё ниже — ПДн, модель вернула сверх схемы:
        full_name: 'Ausiyevich Piotr',
        passport_number: 'AB1234567',
        date_of_birth: '1975-01-01',
        mrz: 'P<BLRAUSIYEVICH<<PIOTR<<<',
      },
      'driver_passport',
    );
    expect(Object.keys(out as object).sort()).toEqual(['country', 'doc_kind', 'present']);
    expect((out as any).country).toBe('BY');
    expect((out as any).full_name).toBeUndefined();
    expect((out as any).passport_number).toBeUndefined();
    expect((out as any).mrz).toBeUndefined();
  });

  it('триггерится по doc_kind=id даже без documentType', () => {
    const out = applyIdAllowlist({ doc_kind: 'id', surname: 'Osipau', country: 'BY' }, null);
    expect((out as any).surname).toBeUndefined();
    expect((out as any).country).toBe('BY');
  });

  it('добивает doc_kind/present, если модель их не вернула', () => {
    const out = applyIdAllowlist({ country: 'KG', given_names: 'Aibek' }, 'driver_passport');
    expect((out as any).doc_kind).toBe('id');
    expect((out as any).present).toBe(true);
    expect((out as any).given_names).toBeUndefined();
  });

  it('НЕ трогает не-ID документ (тождественно)', () => {
    const invoice = { seller: { name: 'ООО Тест', inn: '7707083893' }, total: 100 };
    const out = applyIdAllowlist(invoice, 'commercial_invoice');
    expect(out).toBe(invoice); // референсно тот же объект
  });

  it('null на вход — null на выход', () => {
    expect(applyIdAllowlist(null, 'driver_passport')).toBe(null);
  });
});

describe('buildIdSegmentExtract — §8.5b (без LLM)', () => {
  it('извлекает страну из MRZ (P<BLR → BLR), персональные поля НЕ трогает', () => {
    const out = buildIdSegmentExtract('P<BLRAUSIYEVICH<<PIOTR<<<<<\nAB12345678BLR...');
    expect(out).toEqual({ doc_kind: 'id', present: true, country: 'BLR' });
  });

  it('без MRZ → {doc_kind,present} без country', () => {
    expect(buildIdSegmentExtract('фото паспорта без OCR-MRZ')).toEqual({
      doc_kind: 'id',
      present: true,
    });
  });
});

describe('isIdDocument', () => {
  it('true по слагу driver_passport', () => {
    expect(isIdDocument('driver_passport', {})).toBe(true);
  });
  it('true по doc_kind=id', () => {
    expect(isIdDocument('commercial_invoice', { doc_kind: 'id' })).toBe(true);
  });
  it('false для обычного документа', () => {
    expect(isIdDocument('commercial_invoice', { total: 1 })).toBe(false);
    expect(isIdDocument(null, null)).toBe(false);
  });
});
