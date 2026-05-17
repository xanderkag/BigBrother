/**
 * F13 polish: enrichItemsWithSlaiCategoryIds — добавляет
 * _slai_category_id к items[] из lookup-table.
 */
import { describe, expect, it } from 'vitest';
import { enrichItemsWithSlaiCategoryIds } from '../src/pipeline/normalize/slai-enrichment.js';

describe('enrichItemsWithSlaiCategoryIds', () => {
  it('добавляет _slai_category_id если category_hint матчит lookup', () => {
    const map = new Map<string, number>([
      ['food', 100],
      ['metal', 200],
    ]);
    const r = enrichItemsWithSlaiCategoryIds(
      {
        items: [
          { name: 'Молоко', category_hint: 'food' },
          { name: 'Болт', category_hint: 'metal' },
        ],
      },
      map,
    );
    const items = (r as any).items;
    expect(items[0]._slai_category_id).toBe(100);
    expect(items[1]._slai_category_id).toBe(200);
  });

  it('пропускает items без category_hint', () => {
    const map = new Map<string, number>([['food', 100]]);
    const r = enrichItemsWithSlaiCategoryIds(
      { items: [{ name: 'Неизвестно' }] },
      map,
    );
    expect((r as any).items[0]._slai_category_id).toBeUndefined();
  });

  it('пропускает items с unknown hint (отсутствует в lookup)', () => {
    const map = new Map<string, number>([['food', 100]]);
    const r = enrichItemsWithSlaiCategoryIds(
      { items: [{ name: 'X', category_hint: 'other' }] },
      map,
    );
    expect((r as any).items[0]._slai_category_id).toBeUndefined();
  });

  it('уважает существующий _slai_category_id (не перетирает)', () => {
    const map = new Map<string, number>([['food', 100]]);
    const r = enrichItemsWithSlaiCategoryIds(
      { items: [{ name: 'X', category_hint: 'food', _slai_category_id: 999 }] },
      map,
    );
    expect((r as any).items[0]._slai_category_id).toBe(999); // не 100
  });

  it('пустой lookup map → no-op', () => {
    const original = { items: [{ name: 'X', category_hint: 'food' }] };
    const r = enrichItemsWithSlaiCategoryIds(original, new Map());
    expect(r).toBe(original); // same reference
  });

  it('пустой items → no-op', () => {
    const map = new Map([['food', 100]]);
    const original = { items: [] };
    const r = enrichItemsWithSlaiCategoryIds(original, map);
    expect(r).toBe(original);
  });

  it('extracted без items → no-op', () => {
    const map = new Map([['food', 100]]);
    const original = { number: 'INV-1' };
    const r = enrichItemsWithSlaiCategoryIds(original, map);
    expect(r).toBe(original);
  });

  it('null extracted → null', () => {
    expect(enrichItemsWithSlaiCategoryIds(null, new Map([['food', 1]]))).toBeNull();
  });

  it('идемпотентность: повторный вызов на enriched не меняет', () => {
    const map = new Map([['food', 100]]);
    const r1 = enrichItemsWithSlaiCategoryIds(
      { items: [{ name: 'X', category_hint: 'food' }] },
      map,
    );
    const r2 = enrichItemsWithSlaiCategoryIds(r1, map);
    // повторный вызов — то же самое, без двойной enrichment
    expect((r2 as any).items[0]._slai_category_id).toBe(100);
  });

  it('частично обогащает — некоторые items hit, некоторые miss', () => {
    const map = new Map([['food', 100]]);
    const r = enrichItemsWithSlaiCategoryIds(
      {
        items: [
          { name: 'Молоко', category_hint: 'food' },
          { name: 'Болт', category_hint: 'metal' }, // metal нет в lookup
          { name: 'X', category_hint: 'food' },
        ],
      },
      map,
    );
    const items = (r as any).items;
    expect(items[0]._slai_category_id).toBe(100);
    expect(items[1]._slai_category_id).toBeUndefined();
    expect(items[2]._slai_category_id).toBe(100);
  });
});
