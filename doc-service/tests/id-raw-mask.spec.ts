/**
 * §8.1 (CLASSIFIER-PACKET-V2): маскирование raw_text паспортных/ID-страниц
 * перед персистом.
 */
import { describe, expect, it } from 'vitest';
import { maskIdContentInRawText, ID_PAGE_PLACEHOLDER } from '../src/pipeline/normalize/id-raw-mask.js';

describe('maskIdContentInRawText', () => {
  it('композит: паспортная страница вырезана, остальные целы', () => {
    const pages = [{ text: 'EAD page text' }, { text: 'invoice page text' }, { text: 'P<BLRAUSIYEVICH<<PIOTR<<<<<<' }];
    const out = maskIdContentInRawText('full', pages, 'customs_export_ead', [
      { page_range: '1', document_type: 'customs_export_ead' },
      { page_range: '2', document_type: 'commercial_invoice' },
      { page_range: '3', document_type: 'driver_passport' },
    ]);
    expect(out).toContain('EAD page text');
    expect(out).toContain('invoice page text');
    expect(out).toContain(ID_PAGE_PLACEHOLDER);
    expect(out).not.toContain('AUSIYEVICH');
  });

  it('диапазон 8-11 вырезается целиком', () => {
    const pages = Array.from({ length: 11 }, (_, i) => ({ text: `page-${i + 1}` }));
    const out = maskIdContentInRawText('full', pages, 'commercial_invoice', [
      { page_range: '1-7', document_type: 'commercial_invoice' },
      { page_range: '8-11', document_type: 'driver_passport' },
    ]);
    expect(out).toContain('page-7');
    expect(out).not.toContain('page-8');
    expect(out).not.toContain('page-11');
  });

  it('одиночный паспорт (без сегментов) → весь текст вырезан', () => {
    const out = maskIdContentInRawText('P<KGZMAMETKAZIEV<<AIBEK<<<', undefined, 'driver_passport', null);
    expect(out).toBe(ID_PAGE_PLACEHOLDER);
    expect(out).not.toContain('MAMETKAZIEV');
  });

  it('стрэй MRZ на не-ID странице тоже скрабится (belt-and-suspenders)', () => {
    const pages = [{ text: 'EAD text' }, { text: 'invoice P<BLRSTRAY<<X<<<<< bleed' }, { text: 'P<BLRPASS<<<<<' }];
    const out = maskIdContentInRawText('full', pages, 'customs_export_ead', [
      { page_range: '3', document_type: 'driver_passport' },
    ]);
    expect(out).not.toContain('BLRSTRAY');
    expect(out).not.toContain('BLRPASS');
    expect(out).toContain('EAD text');
  });

  it('не-ID документ → raw_text не тронут (аудит)', () => {
    const out = maskIdContentInRawText('обычный счёт текст', [{ text: 'обычный счёт текст' }], 'commercial_invoice', [
      { page_range: '1', document_type: 'commercial_invoice' },
    ]);
    expect(out).toBe('обычный счёт текст');
  });

  it('нет сегментов, не-ID тип → raw_text не тронут', () => {
    expect(maskIdContentInRawText('raw', undefined, 'ttn', null)).toBe('raw');
  });
});
