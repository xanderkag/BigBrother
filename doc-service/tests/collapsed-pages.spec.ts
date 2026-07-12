/**
 * §P0-0 (CLASSIFIER-PACKET-V2): восстановление постраничности склеенного OCR.
 */
import { describe, expect, it } from 'vitest';
import { splitCollapsedText } from '../src/pipeline/multidoc/collapsed-pages.js';

describe('splitCollapsedText', () => {
  it('разбивает по form-feed', () => {
    const parts = splitCollapsedText('page one text\fpage two text\fpage three');
    expect(parts).toEqual(['page one text', 'page two text', 'page three']);
  });

  it('игнорирует пустые сегменты между form-feed', () => {
    const parts = splitCollapsedText('a\f\f  \fb');
    expect(parts).toEqual(['a', 'b']);
  });

  it('разбивает по маркерам «Страница N / Page N»', () => {
    const text = 'Преамбула\nСтраница 1\nтело первой\nPage 2\nтело второй';
    const parts = splitCollapsedText(text);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.some((p) => p.includes('Страница 1'))).toBe(true);
    expect(parts.some((p) => p.includes('Page 2'))).toBe(true);
  });

  it('один blob без разделителей → [] (single-doc не трогаем)', () => {
    expect(splitCollapsedText('обычный документ без разделителей страниц')).toEqual([]);
  });

  it('пустой/пробельный текст → []', () => {
    expect(splitCollapsedText('')).toEqual([]);
    expect(splitCollapsedText('   \n  ')).toEqual([]);
  });

  it('один маркер → [] (нужно ≥2 страницы)', () => {
    expect(splitCollapsedText('Страница 1\nтолько одна')).toEqual([]);
  });
});
