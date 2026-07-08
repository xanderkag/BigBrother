/**
 * Статический sanity-тест миграции коннектора `yandex_vision`.
 *
 * Защищает контракт: unit_kind='pages' обязан присутствовать И в zod-энуме
 * UnitKind (response-схема GET /gateway/connectors), И в GatewayUnitKind
 * (тип записи расхода). Промах в первом роняет ВЕСЬ экран «Интеграции»
 * валидацией ответа; во втором — не скомпилируется учёт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(__dirname, '..', 'migrations', '20260707000001_yandex_vision_connector.sql'), 'utf8',
);
const gatewayAdmin = readFileSync(
  resolve(__dirname, '..', 'src', 'routes', 'gateway-admin.ts'), 'utf8',
);
const llmUsage = readFileSync(
  resolve(__dirname, '..', 'src', 'storage', 'llm-usage.ts'), 'utf8',
);

describe('yandex_vision connector migration', () => {
  it('сеет ровно один коннектор yandex_vision со страницами', () => {
    expect(sql).toContain("'yandex_vision'");
    expect(sql).toContain("'pages'");
    expect(sql).toContain('Яндекс Vision');
  });

  it('включён по умолчанию — не меняем поведение существующих установок', () => {
    expect(sql).toMatch(/'yandex_vision'[^\n]*'pages',\s*true/);
  });

  it('идемпотентна и обратима', () => {
    expect(sql).toContain('ON CONFLICT (slug) DO NOTHING');
    expect(sql).toContain('-- Down Migration');
    expect(sql).toMatch(/DELETE FROM gateway_connectors WHERE slug = 'yandex_vision'/);
  });

  it("unit_kind 'pages' разрешён zod-энумом UnitKind (иначе экран падает целиком)", () => {
    const m = gatewayAdmin.match(/const UnitKind = z\.enum\(\[([^\]]+)\]\)/);
    expect(m, 'UnitKind z.enum найден').not.toBeNull();
    const allowed = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    expect(allowed).toContain('pages');
    // не потеряли существующие
    for (const u of ['tokens', 'calls', 'geocodes', 'routes']) expect(allowed).toContain(u);
  });

  it("unit_kind 'pages' разрешён типом GatewayUnitKind (учёт расхода)", () => {
    const m = llmUsage.match(/export type GatewayUnitKind =([^;]+);/);
    expect(m, 'GatewayUnitKind найден').not.toBeNull();
    expect(m![1]).toContain("'pages'");
  });

  it('фиксирует границу ответственности: PII-гард остаётся за env', () => {
    expect(sql).toContain('YANDEX_DISABLE_FOR_PII');
    expect(sql).toContain('_disable_external_ocr');
  });
});
