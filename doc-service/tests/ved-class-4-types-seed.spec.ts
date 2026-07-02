/**
 * Sanity-тест на миграцию ВЭД-class-4 (2026-07-02) — 4 новых ВЭД-типа.
 *
 * Без живой БД проверяем форму SQL-файла:
 *   1. все 4 slug'а присутствуют в порядке миграции;
 *   2. каждый блок помечен tier='beta' и organization_id NULL (global);
 *   3. llm_schema — валидный JSON c type:object + properties;
 *   4. classification_keywords компилируются как regex;
 *   5. validators — из известного реестра;
 *   6. expected_fields непустые;
 *   7. keyword'ы ловят релевантный заголовок (title-anchored, substring);
 *   8. keyword'ы НЕ ловят чужой заголовок (export vs customs, quality vs sds).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = '20260702000001_ved_class_4_types.sql';
const SLUGS = ['insurance_policy', 'safety_data_sheet', 'export_declaration', 'quality_certificate'];

type Row = {
  slug: string;
  jsonSchemaRaw: string;
  classificationKeywords: string[];
  expectedFields: string[];
  validators: string[];
  block: string;
};

function parseStringArray(content: string): string[] {
  return [...content.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

function extractRows(): Row[] {
  const raw = readFileSync(resolve(__dirname, '..', 'migrations', MIGRATION), 'utf8');
  const out: Row[] = [];
  for (const slug of SLUGS) {
    const slugIdx = raw.indexOf(`'${slug}'`);
    expect(slugIdx, `slug ${slug} should appear`).toBeGreaterThan(0);
    const nextSlugIdx = SLUGS.filter((s) => s !== slug)
      .map((s) => raw.indexOf(`'${s}'`, slugIdx + 1))
      .filter((i) => i > slugIdx)
      .reduce<number>((min, i) => (min === -1 || i < min ? i : min), -1);
    // Блок кончается на следующем slug'е либо на DO $$-санити-блоке.
    const doIdx = raw.indexOf('DO $$', slugIdx);
    const blockEnd = nextSlugIdx > 0 ? nextSlugIdx : doIdx;
    const block = raw.slice(slugIdx, blockEnd);

    const arrays = [...block.matchAll(/ARRAY\[([\s\S]*?)\]/g)].map((m) => m[1] ?? '');
    expect(arrays.length, `${slug}: минимум 4 ARRAY[] секции`).toBeGreaterThanOrEqual(4);
    const expectedFields = parseStringArray(arrays[0]!);
    const validators = parseStringArray(arrays[1]!);
    const classificationKeywords = parseStringArray(arrays[2]!);

    const jsonbMatch = block.match(/'(\{[\s\S]*?\})'::jsonb/);
    expect(jsonbMatch, `${slug}: JSON-схема '{...}'::jsonb`).toBeTruthy();

    out.push({
      slug,
      jsonSchemaRaw: jsonbMatch![1]!,
      classificationKeywords,
      expectedFields,
      validators,
      block,
    });
  }
  return out;
}

describe('ВЭД-class-4 migration: insurance/SDS/export/quality types', () => {
  const rows = extractRows();

  it('содержит все 4 slug в порядке миграции', () => {
    expect(rows.map((r) => r.slug)).toEqual(SLUGS);
  });

  it('каждый блок помечен tier=beta и organization_id NULL', () => {
    for (const r of rows) {
      expect(r.block, `${r.slug} → 'beta'`).toContain("'beta'");
      expect(r.block, `${r.slug} → NULL org`).toMatch(/'beta',\s*NULL/);
    }
  });

  it.each(rows.map((r) => [r.slug, r] as const))(
    '%s: llm_schema — валидный JSON',
    (_slug, r) => {
      const parsed = JSON.parse(r.jsonSchemaRaw) as { properties?: unknown };
      expect(parsed).toMatchObject({ type: 'object' });
      expect(parsed.properties).toBeTypeOf('object');
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
        expect(() => new RegExp(kw, 'i'), `regex "${kw}"`).not.toThrow();
      }
    },
  );

  it.each(rows.map((r) => [r.slug, r] as const))(
    '%s: validator из реестра',
    (_slug, r) => {
      const known = new Set([
        'inn_checksum', 'kpp_format', 'vehicle_plate', 'country_code',
        'date_range', 'money_sanity', 'vat_consistency', 'parties_differ',
        'weight_nett_le_gross', 'positions_sum',
      ]);
      for (const spec of r.validators) {
        expect(known.has(spec.split(':')[0]!), `validator "${spec}"`).toBe(true);
      }
    },
  );

  // Title-anchored: реальный заголовок каждого типа ловится хотя бы одним keyword'ом.
  it('keywords ловят релевантный заголовок (title-anchored, substring)', () => {
    const samples: Record<string, string> = {
      insurance_policy: 'СТРАХОВОЙ ПОЛИС № 07-3-622-5737/2026 (страхование груза «с ответственностью за все риски»)',
      safety_data_sheet: 'Safety data sheet — SECTION 1: Identification of the substance/mixture',
      export_declaration: 'Customs export declaration № 12345 — экспортная декларация страны отправления',
      quality_certificate: 'СЕРТИФИКАТ КАЧЕСТВА № 100/2026 (Certificate of Analysis)',
    };
    for (const r of rows) {
      const text = samples[r.slug]!;
      const anyMatch = r.classificationKeywords.some((kw) => new RegExp(kw, 'i').test(text));
      expect(anyMatch, `${r.slug}: ни один keyword не сработал на "${text}"`).toBe(true);
    }
  });

  // export_declaration НЕ должен ловить обычную таможенную декларацию (ДТ/ГТД).
  it('export_declaration keywords НЕ ловят «Декларация на товары» / ГТД', () => {
    const exp = rows.find((r) => r.slug === 'export_declaration')!;
    for (const kw of exp.classificationKeywords) {
      const re = new RegExp(kw, 'i');
      expect(re.test('Декларация на товары № 10702070/...'), `export kw "${kw}" ловит ДТ`).toBe(false);
      expect(re.test('Грузовая таможенная декларация'), `export kw "${kw}" ловит ГТД`).toBe(false);
    }
  });

  // quality_certificate НЕ должен ловить паспорт безопасности (SDS-заголовок).
  it('quality_certificate keywords НЕ ловят «Паспорт безопасности» / Safety data sheet', () => {
    const q = rows.find((r) => r.slug === 'quality_certificate')!;
    for (const kw of q.classificationKeywords) {
      const re = new RegExp(kw, 'i');
      expect(re.test('Паспорт безопасности химической продукции'), `quality kw "${kw}" ловит SDS(ru)`).toBe(false);
      expect(re.test('Safety data sheet — SECTION 1'), `quality kw "${kw}" ловит SDS(en)`).toBe(false);
    }
  });

  // insurance_policy title-keyword НЕ ловит обычный договор/контракт.
  it('insurance_policy keywords НЕ ловят обычный «Договор поставки»', () => {
    const ins = rows.find((r) => r.slug === 'insurance_policy')!;
    for (const kw of ins.classificationKeywords) {
      const re = new RegExp(kw, 'i');
      expect(re.test('ДОГОВОР ПОСТАВКИ № 5 от 01.01.2026'), `insurance kw "${kw}" ловит договор`).toBe(false);
    }
  });
});
