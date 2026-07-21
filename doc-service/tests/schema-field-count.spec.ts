import { describe, it, expect } from 'vitest';
import { countSchemaLeafFields } from '../src/types/schema-field-count.js';
import { EXTENDED_SCHEMAS, DOCUMENT_JSON_SCHEMAS } from '../src/types/document-json-schemas.js';

describe('countSchemaLeafFields', () => {
  it('пустая/невалидная схема → 0', () => {
    expect(countSchemaLeafFields(null)).toBe(0);
    expect(countSchemaLeafFields(undefined)).toBe(0);
    expect(countSchemaLeafFields({})).toBe(0);
    expect(countSchemaLeafFields({ type: 'object' })).toBe(0);
    expect(countSchemaLeafFields({ properties: 'мусор' } as never)).toBe(0);
  });

  it('плоские поля считаются по одному', () => {
    expect(
      countSchemaLeafFields({
        properties: { a: { type: 'string' }, b: { type: 'number' }, c: {} },
      }),
    ).toBe(3);
  });

  it('объект-сторона → её листья; массив объектов → колонки строки', () => {
    expect(
      countSchemaLeafFields({
        properties: {
          seller: { type: 'object', properties: { name: {}, inn: {} } },
          items: { type: 'array', items: { type: 'object', properties: { name: {}, qty: {}, price: {} } } },
        },
      }),
    ).toBe(5);
  });

  it('массив скаляров = одно поле', () => {
    expect(
      countSchemaLeafFields({ properties: { hs_codes: { type: 'array', items: { type: 'string' } } } }),
    ).toBe(1);
  });

  it('вложенный объект в объекте разворачивается рекурсивно', () => {
    expect(
      countSchemaLeafFields({
        properties: {
          seller: {
            type: 'object',
            properties: { name: {}, bank: { type: 'object', properties: { bik: {}, account: {} } } },
          },
        },
      }),
    ).toBe(3); // name + bank.bik + bank.account
  });

  it('защита от бездонной вложенности не зацикливается', () => {
    // Самоссылку JSON не сериализует, но admin-override может быть глубоким.
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20; i++) deep = { type: 'object', properties: { x: deep } };
    expect(countSchemaLeafFields({ properties: { root: deep } })).toBeGreaterThan(0);
  });

  it('боевые схемы: BL из кода богатая, builtin invoice непустой', () => {
    const bl = (EXTENDED_SCHEMAS as Record<string, Record<string, unknown>>)['bill_of_lading'];
    expect(countSchemaLeafFields(bl)).toBeGreaterThan(20);
    const inv = (DOCUMENT_JSON_SCHEMAS as Record<string, Record<string, unknown>>)['invoice'];
    expect(countSchemaLeafFields(inv)).toBeGreaterThan(5);
  });
});
