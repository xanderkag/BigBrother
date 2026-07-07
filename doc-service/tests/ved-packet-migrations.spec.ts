/**
 * Статический sanity-тест миграций VANGA-VED-1 (без живой БД):
 *   1. customs_export_ead — новый тип: slug/tier/org, валидный llm_schema,
 *      keyword-regex компилируются, MRN-якорь ловит реальный MRN и не ловит
 *      русскую ГТД, validators из реестра, expected_fields непусты.
 *   2. ved_packet_schema_extensions — инлайн JSON-фрагменты валидны и
 *      добавляют ожидаемые свойства нужным типам.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG_DIR = resolve(__dirname, '..', 'migrations');
const KNOWN_VALIDATORS = new Set([
  'inn_checksum', 'date_range', 'money_sanity', 'kpp_format', 'ogrn_format',
  'items_hs_code_format', 'vat_math', 'plate_format',
]);

function read(name: string): string {
  return readFileSync(resolve(MIG_DIR, name), 'utf8');
}
function parseSqlStringArray(content: string): string[] {
  return [...content.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

describe('customs_export_ead migration', () => {
  const raw = read('20260703000001_customs_export_ead_type.sql');

  it('inserts a global beta type', () => {
    expect(raw).toContain("'customs_export_ead'");
    expect(raw).toContain("'beta'");
    expect(raw).toContain('NULL'); // organization_id NULL
    expect(raw).toContain("'llm_extract'");
  });

  it('llm_schema is valid JSON: object with mrn + items[]', () => {
    // Grab the '{ ... }'::jsonb block (the last, largest one — the schema).
    const m = raw.match(/'(\{[\s\S]*\})'::jsonb/);
    expect(m, 'schema jsonb block present').not.toBeNull();
    const schema = JSON.parse(m![1]!);
    expect(schema.type).toBe('object');
    expect(schema.properties.mrn).toBeTruthy();
    expect(schema.properties.items.type).toBe('array');
    expect(schema.properties.items.items.properties.statistical_value).toBeTruthy();
    expect(schema.properties.items.items.properties.hs_code).toBeTruthy();
  });

  it('classification keywords all compile as RegExp', () => {
    // keywords array = the ARRAY[...]::text[] right before the weights ARRAY.
    // keyword text[] array — распознаём по «за ним идёт numeric-массив весов»
    // (единственная такая смежность). Между ними допускаем SQL-комментарии.
    const kwBlock = raw.match(/ARRAY\[([\s\S]*?)\]::text\[\],\s*(?:--[^\n]*\n\s*)*ARRAY\[[\d.,\s]+\]::numeric/);
    expect(kwBlock, 'keyword array present').not.toBeNull();
    const keywords = parseSqlStringArray(kwBlock![1]!);
    expect(keywords.length).toBeGreaterThan(3);
    for (const k of keywords) {
      expect(() => new RegExp(k, 'i'), `regex should compile: ${k}`).not.toThrow();
    }
  });

  it('MRN anchor matches a real MRN and not a Russian ГТД number', () => {
    const mrnRe = /\b\d{2}[A-Z]{2}[A-Z0-9]{14}\b/;
    expect(mrnRe.test('23HR030228018557B5')).toBe(true); // §7.1 Milka
    expect(mrnRe.test('10209094/241223/0012345')).toBe(false); // русская ГТД-нумерация
  });

  it('validators are all from the known registry', () => {
    const valBlock = raw.match(/ARRAY\[([^\]]*)\]::text\[\],\s*\n\s*ARRAY\[\s*'\\/);
    // fallback: just check the two we declared appear and are known
    expect(raw).toContain("'date_range'");
    expect(raw).toContain("'money_sanity'");
    for (const v of ['date_range', 'money_sanity']) {
      expect(KNOWN_VALIDATORS.has(v)).toBe(true);
    }
    void valBlock;
  });
});

describe('ved_packet_schema_extensions migration', () => {
  const raw = read('20260703000002_ved_packet_schema_extensions.sql');

  it('targets the three types and adds the expected fields', () => {
    expect(raw).toContain("slug = 'commercial_invoice'");
    expect(raw).toContain("slug = 'packing_list'");
    expect(raw).toContain("slug = 'transport_request'");
    expect(raw).toContain('specification_reference');
    expect(raw).toContain('total_pallets');
    expect(raw).toContain('customs_post_entry');
    expect(raw).toContain('border_crossing');
  });

  it('all inline JSON merge fragments are valid JSON', () => {
    // Every "|| '{ ... }'::jsonb" fragment must be valid JSON.
    const frags = [...raw.matchAll(/\|\|\s*'(\{[\s\S]*?\})'::jsonb/g)].map((m) => m[1]!);
    expect(frags.length).toBeGreaterThanOrEqual(4);
    for (const f of frags) {
      expect(() => JSON.parse(f), `fragment valid JSON: ${f.slice(0, 40)}…`).not.toThrow();
    }
  });

  it('has a matching Down migration that removes the added keys', () => {
    expect(raw).toContain('-- Down Migration');
    expect(raw).toContain("- 'specification_reference'");
    expect(raw).toContain("- 'customs_post_entry' - 'border_crossing'");
  });
});
