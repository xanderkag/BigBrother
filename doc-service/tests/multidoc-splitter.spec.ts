/**
 * F5: page-by-page splitter — группировка страниц одного типа в сегменты.
 */
import { describe, expect, it } from 'vitest';
import {
  splitPagesIntoSegments,
  isMultiDocument,
} from '../src/pipeline/multidoc/splitter.js';
import type { PageClassification } from '../src/pipeline/multidoc/types.js';

const longText = 'A'.repeat(500); // > minTextLength

function pg(page: number, type: string | null, confidence = 0.9): PageClassification {
  return { page, document_type: type, confidence, text_preview: longText.slice(0, 200) };
}

describe('splitPagesIntoSegments — single-doc cases', () => {
  it('одна страница → один сегмент', () => {
    const segs = splitPagesIntoSegments([pg(1, 'invoice')], [longText]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      document_type: 'invoice',
      page_from: 1,
      page_to: 1,
    });
  });

  it('5 страниц одного типа → один сегмент 1-5', () => {
    const pages = [pg(1, 'UPD'), pg(2, 'UPD'), pg(3, 'UPD'), pg(4, 'UPD'), pg(5, 'UPD')];
    const texts = pages.map(() => longText);
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      document_type: 'UPD',
      page_from: 1,
      page_to: 5,
    });
  });
});

describe('splitPagesIntoSegments — multi-doc cases', () => {
  it('счёт стр.1 + ТТН стр.2-3 → 2 сегмента', () => {
    const pages = [pg(1, 'invoice'), pg(2, 'TTN'), pg(3, 'TTN')];
    const texts = [longText, longText, longText];
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({
      document_type: 'invoice',
      page_from: 1,
      page_to: 1,
    });
    expect(segs[1]).toMatchObject({
      document_type: 'TTN',
      page_from: 2,
      page_to: 3,
    });
  });

  it('счёт-1, УПД-2, ТТН-3 → 3 сегмента по одной странице', () => {
    const pages = [pg(1, 'invoice'), pg(2, 'UPD'), pg(3, 'TTN')];
    const texts = [longText, longText, longText];
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.document_type)).toEqual(['invoice', 'UPD', 'TTN']);
  });

  it('combined_text объединяет страницы сегмента через \\n\\n', () => {
    const pages = [pg(1, 'UPD'), pg(2, 'UPD')];
    const segs = splitPagesIntoSegments(pages, ['Page 1 content', 'Page 2 content']);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.combined_text).toContain('Page 1 content');
    expect(segs[0]!.combined_text).toContain('Page 2 content');
    expect(segs[0]!.combined_text).toContain('\n\n');
  });
});

describe('splitPagesIntoSegments — low-confidence handling', () => {
  it('страница с низкой confidence присоединяется к предыдущему сегменту', () => {
    const pages = [pg(1, 'UPD', 0.9), pg(2, 'TTN', 0.3), pg(3, 'UPD', 0.9)];
    const texts = [longText, longText, longText];
    const segs = splitPagesIntoSegments(pages, texts);
    // Страница 2 low-conf → к сегменту UPD. Затем стр.3 опять UPD → продолжается.
    // Результат: один сегмент UPD страницы 1-3.
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ document_type: 'UPD', page_from: 1, page_to: 3 });
  });

  it('низкая confidence на первой странице — открывает сегмент всё равно', () => {
    const pages = [pg(1, 'UPD', 0.2)];
    const segs = splitPagesIntoSegments(pages, [longText]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.document_type).toBe('UPD');
  });
});

describe('splitPagesIntoSegments — пустые страницы', () => {
  it('пустая страница присоединяется к предыдущему сегменту', () => {
    const pages = [pg(1, 'UPD'), pg(2, 'TTN'), pg(3, 'TTN')];
    // Стр.2 — короткий текст (< 100 симв)
    const segs = splitPagesIntoSegments(pages, [longText, 'short', longText]);
    // Стр.2 «пустая» → к UPD; стр.3 TTN → открывает новый сегмент
    expect(segs).toHaveLength(2);
    expect(segs[0]!.page_to).toBe(2); // UPD расширен до стр.2
    expect(segs[1]).toMatchObject({ document_type: 'TTN', page_from: 3, page_to: 3 });
  });
});

describe('splitPagesIntoSegments — page без document_type', () => {
  it('null type на странице → присоединяется к предыдущему', () => {
    const pages = [pg(1, 'UPD'), pg(2, null, 0.9), pg(3, 'UPD')];
    const texts = [longText, longText, longText];
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.page_to).toBe(3);
  });

  it('первая страница без type → создаёт null-сегмент', () => {
    const pages = [pg(1, null, 0.5), pg(2, 'UPD')];
    const texts = [longText, longText];
    const segs = splitPagesIntoSegments(pages, texts);
    // Первая открывает сегмент с null. Вторая (UPD, high-conf, отличается от null)
    // → новый сегмент.
    expect(segs).toHaveLength(2);
    expect(segs[0]!.document_type).toBeNull();
    expect(segs[1]!.document_type).toBe('UPD');
  });
});

describe('splitPagesIntoSegments — edge cases', () => {
  it('пустой массив страниц → []', () => {
    expect(splitPagesIntoSegments([], [])).toEqual([]);
  });

  it('mismatch pages vs texts → throws', () => {
    expect(() =>
      splitPagesIntoSegments([pg(1, 'UPD')], ['text1', 'text2']),
    ).toThrow(/mismatch|length/i);
  });
});

describe('splitPagesIntoSegments — boundary-aware (§P0-2)', () => {
  const pad = (s: string) => s + '\n' + 'x'.repeat(150);

  it('композит EAD+packing+CMR с null-классификатором → 3 boundary-сегмента', () => {
    const pages = [pg(1, null, 0.2), pg(2, null, 0.2), pg(3, null, 0.2)];
    const texts = [
      pad('AUSFUHRBEGLEITDOKUMENT\nMRN 23HR030228018557B5'),
      pad('PACKING LIST\nGesamtgewicht 1200 kg'),
      pad('CMR\nМеждународная товарно-транспортная накладная'),
    ];
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs.map((s) => s.document_type)).toEqual([
      'customs_export_ead',
      'packing_list',
      'cmr',
    ]);
    expect(segs.every((s) => s.boundary != null)).toBe(true);
    expect(segs[0]!.confidence).toBeGreaterThanOrEqual(0.6); // boundary-floor
    expect(isMultiDocument(segs)).toBe(true);
  });

  it('SICHEL continuation: инвойс стр.1 + безъякорные стр.2-3 (keyword packing) → ОДИН сегмент', () => {
    const pages = [pg(1, 'commercial_invoice', 0.9), pg(2, 'packing_list', 0.9), pg(3, 'packing_list', 0.9)];
    const texts = [
      pad('INVOICE No INV-500\nUnit price 10 Amount 1200'),
      pad('Continuation line items net 500 kg gross 600 kg quantity 12'),
      pad('More line items net 300 kg gross 350 kg quantity 8'),
    ];
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      document_type: 'commercial_invoice',
      page_from: 1,
      page_to: 3,
      boundary: 'commercial_invoice',
    });
  });

  it('EAD back-reference: тот же MRN на стр.2 → приклеивается (1 сегмент, не 2)', () => {
    const pages = [pg(1, null, 0.3), pg(2, null, 0.3)];
    const texts = [
      pad('AUSFUHRBEGLEITDOKUMENT\nMRN 23HR030228018557B5'),
      pad('continued goods list MRN 23HR030228018557B5 packages'),
    ];
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ document_type: 'customs_export_ead', page_to: 2 });
  });

  it('inline retro-split: другой MRN без заголовка на стр.2 → 2 сегмента', () => {
    const pages = [pg(1, null, 0.3), pg(2, null, 0.3)];
    const texts = [
      pad('AUSFUHRBEGLEITDOKUMENT\nMRN 23HR030228018557B5'),
      pad('some continuation text MRN 24LV030228099999C7 without header'),
    ];
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.identity?.mrn).toBe('23HR030228018557B5');
    expect(segs[1]!.identity?.mrn).toBe('24LV030228099999C7');
  });

  it('driver_passport: страница-паспорт получает тип по MRZ даже при keyword null', () => {
    const pages = [pg(1, 'commercial_invoice', 0.9), pg(2, null, 0.2)];
    const texts = [
      pad('INVOICE No INV-700\nUnit price 5'),
      pad('P<BLRAUSIYEVICH<<PIOTR<<<<<<<<<<<<<<<<<<<<<'),
    ];
    const segs = splitPagesIntoSegments(pages, texts);
    expect(segs).toHaveLength(2);
    expect(segs[1]!.document_type).toBe('driver_passport');
    expect(segs[1]!.boundary).toBe('driver_passport');
  });
});

describe('isMultiDocument', () => {
  it('< 2 сегментов → false', () => {
    expect(isMultiDocument([])).toBe(false);
    expect(
      isMultiDocument([
        { document_type: 'UPD', page_from: 1, page_to: 5, confidence: 0.9, combined_text: '' },
      ]),
    ).toBe(false);
  });

  it('2 сегмента с разными типами + высокой confidence → true', () => {
    expect(
      isMultiDocument([
        { document_type: 'invoice', page_from: 1, page_to: 1, confidence: 0.9, combined_text: '' },
        { document_type: 'TTN', page_from: 2, page_to: 3, confidence: 0.85, combined_text: '' },
      ]),
    ).toBe(true);
  });

  // Heuristic relaxed 2026-05-18 (commit 255d9e8): достаточно ≥2 сегмента +
  // ≥1 typed segment (document_type ≠ null, confidence ≥ 0.5). Раньше
  // требовали ≥2 distinct types + high conf, что бракoвало CI+PL case'ы
  // где classifier неуверен на одном из листов.

  it('2 сегмента одного типа (классификатор уверен в обоих) → true', () => {
    // С relaxed-логикой это валидный multi-doc: два UPD-документа подряд.
    // Runner попробует extract'ить оба и вернёт 2 entries в documents[].
    expect(
      isMultiDocument([
        { document_type: 'UPD', page_from: 1, page_to: 2, confidence: 0.9, combined_text: '' },
        { document_type: 'UPD', page_from: 4, page_to: 5, confidence: 0.9, combined_text: '' },
      ]),
    ).toBe(true);
  });

  it('low confidence на втором сегменте + один confident → true', () => {
    // Достаточно одного confident segment; неуверенный sheet попадает в
    // runner, где extract либо упадёт (segment skipped), либо отработает
    // через LLM как unknown — но в любом случае multi-doc активирован.
    expect(
      isMultiDocument([
        { document_type: 'invoice', page_from: 1, page_to: 1, confidence: 0.9, combined_text: '' },
        { document_type: 'TTN', page_from: 2, page_to: 3, confidence: 0.4, combined_text: '' },
      ]),
    ).toBe(true);
  });

  it('все сегменты неуверены (typedCount = 0) → false', () => {
    // Без хотя бы одного confident segment trigger'ить multi-doc нельзя —
    // иначе одна страница со случайным noise-text дёрнет per-segment LLM
    // вызов на каждом sheet.
    expect(
      isMultiDocument([
        { document_type: 'invoice', page_from: 1, page_to: 1, confidence: 0.3, combined_text: '' },
        { document_type: null, page_from: 2, page_to: 2, confidence: 0.2, combined_text: '' },
      ]),
    ).toBe(false);
  });
});
