/**
 * CP7 фаза 1 — document-type multi-tenancy.
 *
 * Покрываем:
 *  1. storage.listActiveForOrg(orgId) — SQL/params: globals ∪ типы орг;
 *  2. storage.listActiveForOrg(null) — globals-only (без $1, IS NULL);
 *  3. storage.create() — organization_id персистится как 16-й параметр;
 *  4. toApi() — пробрасывает organization_id;
 *  5. resolver — кэш keyed по org-bucket'у (типы орг A не текут в орг B);
 *  6. classifier — orgA видит свой тип, orgB не видит чужой (scope);
 *  7. authz/zod — builtin+org невозможен через create (is_builtin=false),
 *     DB CHECK chk_builtin_is_global — backstop (см. note внизу).
 *
 * db.query замокан — без живой БД. Note по route-harness — в конце файла.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

const ORG_A = '00000000-0000-0000-0000-0000000000a1';
const ORG_B = '00000000-0000-0000-0000-0000000000b2';

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
    organization_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as DocumentTypeRow;
}

describe('storage: listActiveForOrg', () => {
  beforeEach(() => queryMock.mockReset());

  it('orgId set → WHERE is_active AND (organization_id IS NULL OR organization_id = $1)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [row({ slug: 'invoice', organization_id: null }), row({ slug: 'org_a_type', organization_id: ORG_A })],
    });
    const rows = await documentTypesRepo.listActiveForOrg(ORG_A);
    expect(rows.map((r) => r.slug)).toEqual(['invoice', 'org_a_type']);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('is_active = true');
    expect(sql).toContain('organization_id IS NULL OR organization_id = $1');
    expect((params as unknown[])[0]).toBe(ORG_A);
  });

  it('orgId null → globals-only (IS NULL, без параметров)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ slug: 'invoice', organization_id: null })] });
    const rows = await documentTypesRepo.listActiveForOrg(null);
    expect(rows.map((r) => r.slug)).toEqual(['invoice']);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('organization_id IS NULL');
    expect(sql).not.toContain('$1');
    expect(params).toBeUndefined();
  });

  it('listForOrg (admin path) включает inactive, фильтрует по орг', async () => {
    queryMock.mockResolvedValueOnce({ rows: [row()] });
    await documentTypesRepo.listForOrg(ORG_A);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).not.toContain('is_active'); // admin видит и неактивные
    expect(sql).toContain('organization_id IS NULL OR organization_id = $1');
    expect((params as unknown[])[0]).toBe(ORG_A);
  });
});

describe('storage: create + toApi carry organization_id', () => {
  beforeEach(() => queryMock.mockReset());

  it('create() с organization_id → 16-й параметр = org', async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ slug: 'org_a_type', organization_id: ORG_A })] });
    const created = await documentTypesRepo.create({
      slug: 'org_a_type',
      display_name: 'Org A Type',
      organization_id: ORG_A,
    });
    expect(created.organization_id).toBe(ORG_A);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('organization_id');
    expect(sql).toContain('$16');
    expect((params as unknown[])[15]).toBe(ORG_A);
  });

  it('create() без organization_id → параметр null (глобальный)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ organization_id: null })] });
    await documentTypesRepo.create({ slug: 'global_type', display_name: 'Global' });
    const [, params] = queryMock.mock.calls[0]!;
    expect((params as unknown[])[15]).toBeNull();
  });

  it('toApi() пробрасывает organization_id', () => {
    expect(documentTypesRepo.toApi(row({ organization_id: ORG_A }))).toMatchObject({
      organization_id: ORG_A,
    });
    expect(documentTypesRepo.toApi(row({ organization_id: null }))).toMatchObject({
      organization_id: null,
    });
  });
});

describe('resolver: org-keyed cache isolation', () => {
  it('listActiveForOrg(A) и (B) не делят bucket — каждый свой DB-вызов', async () => {
    const { documentTypeResolver } = await import('../src/pipeline/document-type-resolver.js');
    documentTypeResolver.invalidate();
    const spy = vi
      .spyOn(documentTypesRepo, 'listActiveForOrg')
      .mockImplementation(async (orgId: string | null) =>
        orgId === ORG_A
          ? [row({ slug: 'invoice' }), row({ slug: 'org_a_type', organization_id: ORG_A })]
          : [row({ slug: 'invoice' })],
      );

    const a = await documentTypeResolver.listActiveForOrg(ORG_A);
    const b = await documentTypeResolver.listActiveForOrg(ORG_B);
    expect(a.map((r) => r.slug)).toContain('org_a_type');
    expect(b.map((r) => r.slug)).not.toContain('org_a_type');
    // Разные bucket'ы → два разных DB-вызова (не один закэшированный).
    expect(spy).toHaveBeenCalledTimes(2);

    // Повторный вызов A — из кэша, без нового DB round-trip.
    await documentTypeResolver.listActiveForOrg(ORG_A);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('invalidate() сбрасывает все org-bucket\'ы', async () => {
    const { documentTypeResolver } = await import('../src/pipeline/document-type-resolver.js');
    documentTypeResolver.invalidate();
    const spy = vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([row()]);
    await documentTypeResolver.listActiveForOrg(ORG_A);
    documentTypeResolver.invalidate();
    await documentTypeResolver.listActiveForOrg(ORG_A);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('classifier: tenant scope', () => {
  beforeEach(async () => {
    const { documentTypeResolver } = await import('../src/pipeline/document-type-resolver.js');
    documentTypeResolver.invalidate();
    vi.restoreAllMocks();
  });

  it('orgA видит свой кастомный тип; orgB — нет', async () => {
    const { KeywordClassifier } = await import('../src/pipeline/classifier/keywords.js');
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockImplementation(
      async (orgId: string | null) =>
        orgId === ORG_A
          ? [
              row({
                slug: 'org_a_special',
                organization_id: ORG_A,
                classification_keywords: ['\\bORG-A-MARKER\\b'],
              }),
            ]
          : [],
    );

    const text = 'Header with ORG-A-MARKER inside the document body';
    const rA = await new KeywordClassifier().classify(text, ORG_A);
    expect(rA.type).toBe('org_a_special');

    // orgB: scope не содержит org_a_special; DB-rules пусто → hardcoded
    // fallback тоже не матчит этот текст → type=null.
    const rB = await new KeywordClassifier().classify(text, ORG_B);
    expect(rB.type).toBeNull();
  });
});

/**
 * builtin + org: невозможно через POST /document-types — repo.create()
 * жёстко пишет is_builtin=false, а CreateBody не имеет поля is_builtin.
 * Прямой INSERT с (is_builtin=true, organization_id=<uuid>) отбивает DB
 * CHECK chk_builtin_is_global (миграция 20260525000002). Без живой БД мы
 * проверяем route-layer гарантию косвенно: create() всегда шлёт false в
 * позицию is_builtin INSERT'а.
 */
describe('guard: create never produces a tenant-scoped builtin', () => {
  beforeEach(() => queryMock.mockReset());
  it('create() хардкодит is_builtin=false в INSERT', async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ organization_id: ORG_A })] });
    await documentTypesRepo.create({
      slug: 'org_a_type',
      display_name: 'Org A Type',
      organization_id: ORG_A,
    });
    const [sql] = queryMock.mock.calls[0]!;
    // is_builtin не параметризован — литерал false между is_active и tier.
    expect(sql).toMatch(/COALESCE\(\$4, true\), false, COALESCE\(\$5, 'experimental'\)/);
  });
});
