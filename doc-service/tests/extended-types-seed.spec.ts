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

const MIGRATIONS: Array<{ path: string; slugs: string[] }> = [
  {
    path: '20260514000005_extended_document_types.sql',
    slugs: [
      'payment_order',
      'commercial_invoice',
      'packing_list',
      'bill_of_lading',
      'customs_declaration',
      'cash_receipt',
    ],
  },
  {
    path: '20260515000006_contracts_and_addendums.sql',
    slugs: ['contract', 'contract_specification', 'contract_addendum'],
  },
];

/** Извлекаем каждый INSERT'нутый row как объект `{ slug, json_schema, ...}`.
 *  Простой regex-парсер; миграции стабильны — формат «(...VALUES (...) ...)». */
function extractRows(): Array<{ slug: string; jsonSchemaRaw: string; classificationKeywords: string[]; expectedFields: string[]; validators: string[] }> {
  const out: ReturnType<typeof extractRows> = [];

  for (const { path, slugs } of MIGRATIONS) {
    const raw = readFileSync(resolve(__dirname, '..', 'migrations', path), 'utf8');

    for (const slug of slugs) {
      const slugIdx = raw.indexOf(`'${slug}'`);
      expect(slugIdx, `slug ${slug} should appear in ${path}`).toBeGreaterThan(0);
      const nextSlugIdx = slugs
        .filter((s) => s !== slug)
        .map((s) => raw.indexOf(`'${s}'`, slugIdx + 1))
        .filter((i) => i > slugIdx)
        .reduce<number>((min, i) => (min === -1 || i < min ? i : min), -1);
      const blockEnd = nextSlugIdx > 0 ? nextSlugIdx : raw.indexOf('ON CONFLICT', slugIdx);
      const block = raw.slice(slugIdx, blockEnd);

      const arrays = [...block.matchAll(/ARRAY\[([\s\S]*?)\]/g)].map((m) => m[1] ?? '');
      expect(arrays.length, `${slug}: должно быть минимум 3 ARRAY[] секции`).toBeGreaterThanOrEqual(3);
      const expectedFields = parseStringArray(arrays[0]!);
      const validators = parseStringArray(arrays[1]!);
      const classificationKeywords = parseStringArray(arrays[2]!);

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
  }
  return out;
}

function parseStringArray(content: string): string[] {
  // Грубо: каждая строковая литерала в одинарных кавычках.
  return [...content.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

describe('migration 005: extended document types seed', () => {
  const rows = extractRows();

  it('содержит все 9 типов из двух миграций (CP5 + contracts)', () => {
    expect(rows.map((r) => r.slug)).toEqual([
      'payment_order',
      'commercial_invoice',
      'packing_list',
      'bill_of_lading',
      'customs_declaration',
      'cash_receipt',
      'contract',
      'contract_specification',
      'contract_addendum',
    ]);
  });

  // Защита от регресса: «Договор» как слово встречается в счетах и счёт-фактурах,
  // классификатор должен сработать только на полном паттерне, не на упоминании.
  it('contract: classification keywords требуют контекста (не просто слово «Договор»)', () => {
    const contractRow = rows.find((r) => r.slug === 'contract')!;
    for (const kw of contractRow.classificationKeywords) {
      // Каждый паттерн ДОЛЖЕН содержать ещё что-то помимо одиночного слова «Договор».
      // Например, «ДОГОВОР № » или «Предмет договора» — но не голое «Договор».
      const re = new RegExp(kw, 'i');
      expect(re.test('Договор'), `keyword "${kw}" не должен срабатывать на голое слово «Договор»`).toBe(false);
      expect(re.test('Оплата по Договору № 5'), `keyword "${kw}" не должен срабатывать на упоминание в платёжке`).toBe(false);
    }
  });

  // Приложение и допсоглашение должны явно различаться от основного договора.
  it('contract_specification и contract_addendum имеют непересекающиеся ключевые слова', () => {
    const spec = rows.find((r) => r.slug === 'contract_specification')!;
    const add = rows.find((r) => r.slug === 'contract_addendum')!;
    for (const kw of spec.classificationKeywords) {
      const re = new RegExp(kw, 'i');
      expect(re.test('Дополнительное соглашение № 2 к Договору'), `spec keyword "${kw}" не должен ловить допсоглашение`).toBe(false);
    }
    for (const kw of add.classificationKeywords) {
      const re = new RegExp(kw, 'i');
      expect(re.test('Спецификация № 1 к Договору'), `addendum keyword "${kw}" не должен ловить спецификацию`).toBe(false);
    }
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
