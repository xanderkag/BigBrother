/**
 * document_types.tier — unit-тесты на пробрасывание поля через repo.
 *
 * db.query замокан — проверяем что:
 *  1. create() без явного tier шлёт NULL в COALESCE($5, 'experimental'),
 *     то есть default'ит в 'experimental'.
 *  2. create() с явным tier шлёт значение как параметр.
 *  3. patch() с tier генерирует SET tier = $N.
 *  4. toApi() возвращает tier в response shape.
 *
 * Live-БД smoke (миграция up/down) — за рамками unit-тестов; будет
 * проверен при первом server-прогоне.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

const queryMock = vi.fn();
vi.mock('../src/db.js', () => ({
  db: { query: (...args: unknown[]) => queryMock(...args) },
}));

let documentTypesRepo: typeof import('../src/storage/document-types.js').documentTypesRepo;
type DocumentTypeRow = import('../src/storage/document-types.js').DocumentTypeRow;

beforeAll(async () => {
  const mod = await import('../src/storage/document-types.js');
  documentTypesRepo = mod.documentTypesRepo;
});

function row(overrides: Partial<DocumentTypeRow> = {}): DocumentTypeRow {
  return {
    slug: 'custom_test',
    display_name: 'Custom Test',
    description: null,
    is_active: true,
    is_builtin: false,
    tier: 'experimental',
    parser_kind: 'llm_extract',
    llm_prompt: null,
    llm_schema: null,
    expected_fields: [],
    validators: [],
    confidence_threshold: null,
    regex_fallback_threshold: null,
    classification_keywords: [],
    classification_keyword_weights: null,
    metadata: null,
    resolution_config: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as DocumentTypeRow;
}

describe('documentTypesRepo + tier', () => {
  it('create() без tier: параметр = null, default через COALESCE → experimental', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [row({ tier: 'experimental' })] });

    const created = await documentTypesRepo.create({
      slug: 'custom_test',
      display_name: 'Custom Test',
    });

    expect(created.tier).toBe('experimental');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0]!;
    // SQL должен ссылаться на колонку tier и COALESCE с 'experimental'.
    expect(sql).toContain('tier');
    expect(sql).toContain("COALESCE($5, 'experimental')");
    // tier — 5-й параметр в нашем INSERT'е (slug, display_name, description,
    // is_active, tier, parser_kind, ...). Без явного значения шлём null,
    // COALESCE подставит default'ы.
    const p = params as unknown[];
    expect(p[0]).toBe('custom_test');           // slug
    expect(p[1]).toBe('Custom Test');           // display_name
    expect(p[4]).toBeNull();                    // tier
  });

  it('create() с tier=beta: параметр уходит как есть, RETURNING отдаёт beta', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [row({ tier: 'beta' })] });

    const created = await documentTypesRepo.create({
      slug: 'custom_beta',
      display_name: 'Custom Beta',
      tier: 'beta',
    });

    expect(created.tier).toBe('beta');
    const [, params] = queryMock.mock.calls[0]!;
    expect((params as unknown[])[4]).toBe('beta');
  });

  it('patch() с tier=stable: генерирует SET tier = $N + значение в params', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [row({ slug: 'invoice', tier: 'stable' })] });

    const updated = await documentTypesRepo.patch('invoice', { tier: 'stable' });

    expect(updated?.tier).toBe('stable');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toMatch(/SET\s+tier\s*=\s*\$1/);
    const p = params as unknown[];
    expect(p[0]).toBe('stable');
    expect(p[1]).toBe('invoice'); // slug в WHERE
  });

  it('toApi() возвращает tier в response shape', () => {
    const apiShape = documentTypesRepo.toApi(row({ slug: 'TTN', tier: 'stable' }));
    expect(apiShape).toMatchObject({ slug: 'TTN', tier: 'stable' });
    // sanity: остальные поля на месте.
    expect(apiShape.is_builtin).toBe(false);
    expect(apiShape.parser_kind).toBe('llm_extract');
  });

  it('resolveConfigFromRow пробрасывает tier из row', async () => {
    const { resolveConfigFromRow } = await import('../src/pipeline/document-type-resolver.js');
    const cfg = resolveConfigFromRow('UPD', row({ slug: 'UPD', tier: 'stable' }));
    expect(cfg.tier).toBe('stable');
    expect(cfg.source).toBe('db');
  });

  it('resolveConfigFromRow на null row дефолтит tier в experimental', async () => {
    const { resolveConfigFromRow } = await import('../src/pipeline/document-type-resolver.js');
    const cfg = resolveConfigFromRow('TTN', null);
    expect(cfg.tier).toBe('experimental');
    expect(cfg.source).toBe('fallback');
  });
});
