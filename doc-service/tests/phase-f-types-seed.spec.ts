/**
 * Sanity-тест на миграцию Phase F — 4 новых складских/договорных типа.
 *
 * Без живой БД проверяем форму SQL-файла:
 *   1. все 4 slug'а присутствуют;
 *   2. llm_schema — валидный JSON c type:object + properties;
 *   3. classification_keywords компилируются как regex и матчатся
 *      подстрокой по релевантному тексту (plain-литералы, не \b);
 *   4. validators — из известного реестра;
 *   5. expected_fields непустые;
 *   6. tier='experimental' и organization_id NULL (global) проставлены.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = '20260526000002_phase_f_document_types.sql';
const SLUGS = ['power_of_attorney', 'warehouse_receipt', 'warehouse_return', 'material_requisition'];

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
    const blockEnd = nextSlugIdx > 0 ? nextSlugIdx : raw.indexOf('ON CONFLICT', slugIdx);
    const block = raw.slice(slugIdx, blockEnd);

    const arrays = [...block.matchAll(/ARRAY\[([\s\S]*?)\]/g)].map((m) => m[1] ?? '');
    expect(arrays.length, `${slug}: минимум 3 ARRAY[] секции`).toBeGreaterThanOrEqual(3);
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

describe('Phase F migration: 4 warehouse/contract types', () => {
  const rows = extractRows();

  it('содержит все 4 slug в порядке миграции', () => {
    expect(rows.map((r) => r.slug)).toEqual(SLUGS);
  });

  it('каждый блок помечен tier=experimental и organization_id NULL', () => {
    for (const r of rows) {
      expect(r.block, `${r.slug} → 'experimental'`).toContain("'experimental'");
      expect(r.block, `${r.slug} → NULL org`).toMatch(/'experimental',\s*NULL/);
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

  // Кириллические keyword'ы — plain-литералы, матчатся подстрокой
  // (case-insensitive), без \b. Проверяем что реальный заголовок ловится.
  it('keywords match relevant header (substring, case-insensitive)', () => {
    const samples: Record<string, string> = {
      power_of_attorney: 'ДОВЕРЕННОСТЬ № 14 от 5 мая 2026 г. (типовая межотраслевая форма М-2)',
      warehouse_receipt: 'АКТ О ПРИЁМЕ-ПЕРЕДАЧЕ товарно-материальных ценностей на хранение (форма МХ-1)',
      warehouse_return: 'АКТ О ВОЗВРАТЕ товарно-материальных ценностей с хранения (форма МХ-3)',
      material_requisition: 'ТРЕБОВАНИЕ-НАКЛАДНАЯ № 1127 (форма М-11) — отпуск материалов',
    };
    for (const r of rows) {
      const text = samples[r.slug]!;
      const anyMatch = r.classificationKeywords.some((kw) => new RegExp(kw, 'i').test(text));
      expect(anyMatch, `${r.slug}: ни один keyword не сработал на "${text}"`).toBe(true);
    }
  });
});
