/**
 * Sanity-тест на миграцию 005 — seed расширенного каталога типов.
 *
 * Без живой БД проверяем, что SQL-файл валидный по форме:
 *   1. JSON-схемы (`llm_schema`) — корректные JSON.
 *   2. classification_keywords — компилируются как regex (не «.+(» вместо «.+?»).
 *   3. expected_fields — пустые массивы не сидим (тогда coverage не будет считаться).
 *   4. Каждая validator-спецификация имеет валидное имя из реестра.
 *
 * Эти проверки ловят опечатки до того, как они доедут до prod-БД и
 * сломают runtime classifier'а / extract'а.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

const MIGRATION_PATH = resolve(
  __dirname,
  '..',
  'migrations',
  '20260514000005_extended_document_types.sql',
);

const RAW = readFileSync(MIGRATION_PATH, 'utf8');

/** Извлекаем каждый INSERT'нутый row как объект `{ slug, json_schema, ...}`.
 *  Простой regex-парсер; миграция стабильна — формат «(...VALUES (...) ...)». */
function extractRows(): Array<{ slug: string; jsonSchemaRaw: string; classificationKeywords: string[]; expectedFields: string[]; validators: string[] }> {
  // Каждый row — `( 'slug', 'display_name', 'description', true, true, 'llm_extract', ARRAY[...], ARRAY[...], ARRAY[...], NULL, NULL, '{...}'::jsonb, ... )`
  // Парсим по slug'ам — гарантированные первые токены.
  const slugs = [
    'payment_order',
    'commercial_invoice',
    'packing_list',
    'bill_of_lading',
    'customs_declaration',
    'cash_receipt',
  ];
  const out: ReturnType<typeof extractRows> = [];
  for (const slug of slugs) {
    // Локализуем блок начиная с открывающей скобки перед slug'ом до соответствующего ')\n,'
    const slugIdx = RAW.indexOf(`'${slug}'`);
    expect(slugIdx, `slug ${slug} should appear in migration`).toBeGreaterThan(0);
    // Берём блок до следующего slug'а или до ON CONFLICT.
    const nextSlugIdx = slugs
      .filter((s) => s !== slug)
      .map((s) => RAW.indexOf(`'${s}'`, slugIdx + 1))
      .filter((i) => i > slugIdx)
      .reduce<number>((min, i) => (min === -1 || i < min ? i : min), -1);
    const blockEnd = nextSlugIdx > 0 ? nextSlugIdx : RAW.indexOf('ON CONFLICT', slugIdx);
    const block = RAW.slice(slugIdx, blockEnd);

    // expected_fields: первый ARRAY[...] после slug'а
    const arrays = [...block.matchAll(/ARRAY\[([\s\S]*?)\]/g)].map((m) => m[1] ?? '');
    expect(arrays.length, `${slug}: должно быть минимум 3 ARRAY[] секции (expected_fields, validators, classification_keywords)`).toBeGreaterThanOrEqual(3);
    const expectedFields = parseStringArray(arrays[0]!);
    const validators = parseStringArray(arrays[1]!);
    const classificationKeywords = parseStringArray(arrays[2]!);

    // jsonb-схема: между '{' и '}'::jsonb
    const jsonbMatch = block.match(/'(\{[\s\S]*?\})'::jsonb/);
    expect(jsonbMatch, `${slug}: должна быть JSON-схема в формате '{...}'::jsonb`).toBeTruthy();

    out.push({
      slug,
      jsonSchemaRaw: jsonbMatch![1]!,
      classificationKeywords,
      expectedFields,
      validators,
    });
  }
  return out;
}

function parseStringArray(content: string): string[] {
  // Грубо: каждая строковая литерала в одинарных кавычках.
  return [...content.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

describe('migration 005: extended document types seed', () => {
  const rows = extractRows();

  it('содержит 6 новых типов', () => {
    expect(rows.map((r) => r.slug)).toEqual([
      'payment_order',
      'commercial_invoice',
      'packing_list',
      'bill_of_lading',
      'customs_declaration',
      'cash_receipt',
    ]);
  });

  it.each(rows.map((r) => [r.slug, r] as const))(
    '%s: llm_schema парсится как валидный JSON',
    (_slug, r) => {
      const parsed = JSON.parse(r.jsonSchemaRaw) as unknown;
      expect(parsed).toMatchObject({ type: 'object' });
      const obj = parsed as { properties?: unknown };
      expect(obj.properties).toBeTypeOf('object');
    },
  );

  it.each(rows.map((r) => [r.slug, r] as const))(
    '%s: expected_fields непустой',
    (_slug, r) => {
      expect(r.expectedFields.length).toBeGreaterThan(0);
    },
  );

  it.each(rows.map((r) => [r.slug, r] as const))(
    '%s: classification_keywords компилируются как regex',
    (_slug, r) => {
      expect(r.classificationKeywords.length).toBeGreaterThan(0);
      for (const kw of r.classificationKeywords) {
        expect(() => new RegExp(kw, 'i'), `regex "${kw}" should compile`).not.toThrow();
      }
    },
  );

  it.each(rows.map((r) => [r.slug, r] as const))(
    '%s: каждый validator имеет известное имя',
    (_slug, r) => {
      const known = new Set([
        'inn_checksum',
        'kpp_format',
        'vehicle_plate',
        'country_code',
        'date_range',
        'money_sanity',
        'vat_consistency',
        'parties_differ',
        'weight_nett_le_gross',
        'positions_sum',
      ]);
      for (const spec of r.validators) {
        const name = spec.split(':')[0]!;
        expect(known.has(name), `validator "${name}" в реестре`).toBe(true);
      }
    },
  );
});
