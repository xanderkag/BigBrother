/**
 * Статический sanity-тест миграции ocr/asr-коннекторов (без живой БД).
 *
 * Главное, что тут защищается: `unit_kind` каждого коннектора в миграции
 * ОБЯЗАН присутствовать в zod-энуме `UnitKind` (routes/gateway-admin.ts).
 * Иначе GET /gateway/connectors падает валидацией ответа и роняет ВЕСЬ экран
 * «Интеграции» — не только новую строку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = resolve(
  __dirname, '..', 'migrations', '20260707000001_ocr_asr_connectors.sql',
);
const GATEWAY_ADMIN = resolve(__dirname, '..', 'src', 'routes', 'gateway-admin.ts');

const sql = readFileSync(MIGRATION, 'utf8');
const routes = readFileSync(GATEWAY_ADMIN, 'utf8');

/** Достаёт unit_kind'ы из VALUES-строк вида ('ocr', '...', 'ocr', 'pages', true). */
function seededUnitKinds(): string[] {
  const values = sql.slice(sql.indexOf('VALUES'), sql.indexOf('ON CONFLICT'));
  return [...values.matchAll(/\(\s*'[^']+'\s*,\s*'[^']+'\s*,\s*'[^']+'\s*,\s*'([^']+)'/g)]
    .map((m) => m[1]!);
}

/** Достаёт литералы из `const UnitKind = z.enum([...])`. */
function allowedUnitKinds(): string[] {
  const m = routes.match(/const UnitKind = z\.enum\(\[([^\]]+)\]\)/);
  expect(m, 'UnitKind z.enum found in gateway-admin.ts').not.toBeNull();
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('ocr/asr connectors migration', () => {
  it('seeds exactly the ocr and asr connectors', () => {
    expect(sql).toContain("'ocr'");
    expect(sql).toContain("'asr'");
    expect(sql).toContain('Распознавание сканов');
    expect(sql).toContain('Распознавание речи');
  });

  it('is idempotent (ON CONFLICT DO NOTHING)', () => {
    expect(sql).toContain('ON CONFLICT (slug) DO NOTHING');
  });

  it('has a Down migration removing only the two new slugs', () => {
    expect(sql).toContain('-- Down Migration');
    expect(sql).toMatch(/DELETE FROM gateway_connectors WHERE slug IN \('ocr', 'asr'\)/);
  });

  it('ocr is enabled (hot path), asr is asleep (env-configured)', () => {
    expect(sql).toMatch(/'ocr'[^\n]*'pages',\s*true/);
    expect(sql).toMatch(/'asr'[^\n]*'minutes',\s*false/);
  });

  // ── Контракт, который реально ломается ──────────────────────────────
  it('every seeded unit_kind is allowed by the UnitKind zod enum', () => {
    const seeded = seededUnitKinds();
    const allowed = allowedUnitKinds();
    expect(seeded.length).toBeGreaterThanOrEqual(2);
    for (const u of seeded) {
      expect(
        allowed,
        `unit_kind "${u}" must be in UnitKind z.enum, else GET /gateway/connectors 500s`,
      ).toContain(u);
    }
  });

  it('UnitKind still covers the pre-existing connectors', () => {
    const allowed = allowedUnitKinds();
    for (const u of ['tokens', 'calls', 'geocodes', 'routes']) {
      expect(allowed).toContain(u);
    }
  });
});
