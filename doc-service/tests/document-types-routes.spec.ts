/**
 * CP7 фаза 1 — HTTP-level authz matrix для /api/v1/document-types.
 *
 * Harness: minimal-route, НЕ полный server.ts. Регистрируем только
 * documentTypesRoutes на голом Fastify с zod-компиляторами. Полный
 * buildServer тянет rate-limit/multipart/swagger/DB-pool/Redis/BullMQ —
 * нерелевантно для проверки route-handler'ов и нечисто мокается.
 *
 * Auth: `../src/auth.js` замокан так, что bearerAuthHook кладёт в req.user
 * выбранную тест-роль (currentUser). Сами guard'ы (requireSuperAdmin /
 * requireOrgAdmin / getEffectiveScope из authz.js) — настоящие: матрица
 * проверяется на реальной логике, мок только подменяет identity.
 *
 * Repo/audit/resolver/jobs/usersRepo замоканы — без живой БД.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { AuthUser } from '../src/auth.js';

const ORG_A = '00000000-0000-0000-0000-0000000000a1';
const ORG_B = '00000000-0000-0000-0000-0000000000b2';

let currentUser: AuthUser | undefined;

vi.mock('../src/auth.js', () => ({
  bearerAuthHook: async (req: { user?: AuthUser }) => {
    req.user = currentUser;
  },
}));

const repo = {
  list: vi.fn(),
  listForOrg: vi.fn(),
  listActiveForOrg: vi.fn(),
  findBySlug: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  toApi: (row: Record<string, unknown>) => row,
};
vi.mock('../src/storage/document-types.js', () => ({ documentTypesRepo: repo }));
vi.mock('../src/storage/audit-log.js', () => ({
  auditLogRepo: { append: vi.fn().mockResolvedValue(undefined), list: vi.fn(), toApi: (r: unknown) => r },
}));
vi.mock('../src/storage/jobs.js', () => ({
  jobsRepo: { listByDocumentType: vi.fn(), getTypeStats: vi.fn(), getFieldCoverage: vi.fn(), toApi: (r: unknown) => r },
}));
// Роут импортирует ЧИСТУЮ resolveConfigFromRow (счётчик «Поля» по эффективной
// схеме) — оставляем её настоящей через importActual, мокаем только stateful
// documentTypeResolver (invalidate). Так тесты гоняют реальный код-fallback
// (EXTENDED_SCHEMAS для bill_of_lading и т.п.).
vi.mock('../src/pipeline/document-type-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/pipeline/document-type-resolver.js')>();
  return {
    ...actual,
    documentTypeResolver: { invalidate: vi.fn() },
  };
});
vi.mock('../src/storage/users.js', () => ({
  usersRepo: { getAccessibleProjectIds: vi.fn().mockResolvedValue(new Set<string>()) },
}));

let documentTypesRoutes: typeof import('../src/routes/document-types.js').documentTypesRoutes;

beforeAll(async () => {
  ({ documentTypesRoutes } = await import('../src/routes/document-types.js'));
});

function user(over: Partial<AuthUser>): AuthUser {
  return {
    id: 'u-' + Math.random().toString(36).slice(2),
    role: 'viewer',
    organization_id: null,
    default_project_id: '00000000-0000-0000-0000-0000000000d1',
    isSuperAdmin: false,
    row: { id: 'r', role: 'viewer', organization_id: null } as never,
    ...over,
  };
}

const superAdmin = user({ role: 'super_admin', isSuperAdmin: true, organization_id: null });
const adminA = user({ role: 'org_admin', organization_id: ORG_A });
const adminB = user({ role: 'org_admin', organization_id: ORG_B });
const viewerA = user({ role: 'viewer', organization_id: ORG_A });

function apiRow(over: Record<string, unknown> = {}) {
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
    metadata: null,
    resolution_config: null,
    organization_id: null,
    prefer_vision: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(documentTypesRoutes, { prefix: '/api/v1' });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  for (const fn of Object.values(repo)) if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  currentUser = undefined;
  app = await makeApp();
});

describe('GET /api/v1/document-types — scope', () => {
  it('super_admin → repo.list() (видит global + orgA + orgB)', async () => {
    currentUser = superAdmin;
    repo.list.mockResolvedValue([
      apiRow({ slug: 'invoice', organization_id: null }),
      apiRow({ slug: 'org_a_type', organization_id: ORG_A }),
      apiRow({ slug: 'org_b_type', organization_id: ORG_B }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/document-types' });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((i: { slug: string }) => i.slug)).toEqual([
      'invoice',
      'org_a_type',
      'org_b_type',
    ]);
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(repo.listForOrg).not.toHaveBeenCalled();
  });

  it('org_admin A → listForOrg(A) (globals + orgA, не orgB)', async () => {
    currentUser = adminA;
    repo.listForOrg.mockResolvedValue([
      apiRow({ slug: 'invoice', organization_id: null }),
      apiRow({ slug: 'org_a_type', organization_id: ORG_A }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/document-types' });
    expect(r.statusCode).toBe(200);
    const slugs = r.json().items.map((i: { slug: string }) => i.slug);
    expect(slugs).toContain('invoice');
    expect(slugs).toContain('org_a_type');
    expect(slugs).not.toContain('org_b_type');
    expect(repo.listForOrg).toHaveBeenCalledWith(ORG_A);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('viewer A (kind=projects, есть орг) → listForOrg(A)', async () => {
    currentUser = viewerA;
    repo.listForOrg.mockResolvedValue([apiRow({ slug: 'invoice', organization_id: null })]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/document-types' });
    expect(r.statusCode).toBe(200);
    expect(repo.listForOrg).toHaveBeenCalledWith(ORG_A);
  });
});

describe('extracted_fields_count — счётчик «Поля» по эффективной схеме', () => {
  it('bill_of_lading с llm_schema=NULL → счётчик из код-схемы (>20), а не 0', async () => {
    // Регресс-кейс бага витрины: expected_fields=[] и llm_schema=NULL в БД,
    // но боевая схема (EXTENDED_SCHEMAS.bill_of_lading = BL_SCHEMA) богатая —
    // раньше UI показывал 0.
    currentUser = superAdmin;
    repo.list.mockResolvedValue([
      apiRow({ slug: 'bill_of_lading', llm_schema: null, expected_fields: [] }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/document-types' });
    expect(r.statusCode).toBe(200);
    const item = r.json().items[0];
    expect(item.extracted_fields_count).toBeGreaterThan(20);
  });

  it('явная llm_schema из БД приоритетнее fallback — считаем её листья', async () => {
    currentUser = superAdmin;
    repo.list.mockResolvedValue([
      apiRow({
        slug: 'custom_test',
        llm_schema: {
          type: 'object',
          properties: {
            number: { type: 'string' },
            seller: { type: 'object', properties: { name: { type: 'string' }, inn: { type: 'string' } } },
            items: {
              type: 'array',
              items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' }, price: { type: 'number' } } },
            },
          },
        },
      }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/document-types' });
    // number(1) + seller{name,inn}(2) + items[]{name,qty,price}(3) = 6 листьев
    expect(r.json().items[0].extracted_fields_count).toBe(6);
  });

  it('custom-тип без схемы вообще → честный 0', async () => {
    currentUser = superAdmin;
    repo.list.mockResolvedValue([
      apiRow({ slug: 'totally_unknown_custom', llm_schema: null, expected_fields: [] }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/document-types' });
    expect(r.json().items[0].extracted_fields_count).toBe(0);
  });

  it('GET /:slug (деталь) тоже несёт счётчик', async () => {
    currentUser = superAdmin;
    repo.findBySlug.mockResolvedValue(
      apiRow({ slug: 'bill_of_lading', llm_schema: null, expected_fields: [] }),
    );
    const r = await app.inject({ method: 'GET', url: '/api/v1/document-types/bill_of_lading' });
    expect(r.statusCode).toBe(200);
    expect(r.json().extracted_fields_count).toBeGreaterThan(20);
  });
});

describe('POST /api/v1/document-types — create authz', () => {
  beforeEach(() => {
    repo.findBySlug.mockResolvedValue(null);
  });

  it('super_admin создаёт global (organization_id omitted) → 201', async () => {
    currentUser = superAdmin;
    repo.create.mockResolvedValue(apiRow({ slug: 'new_global', organization_id: null }));
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      payload: { slug: 'new_global', display_name: 'New Global' },
    });
    expect(r.statusCode).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ organization_id: null }));
  });

  it('org_admin A создаёт global → 403', async () => {
    currentUser = adminA;
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      payload: { slug: 'new_global', display_name: 'New Global' },
    });
    expect(r.statusCode).toBe(403);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('org_admin A создаёт тип для своей орг A → 201', async () => {
    currentUser = adminA;
    repo.create.mockResolvedValue(apiRow({ slug: 'org_a_type', organization_id: ORG_A }));
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      payload: { slug: 'org_a_type', display_name: 'Org A', organization_id: ORG_A },
    });
    expect(r.statusCode).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ organization_id: ORG_A }));
  });

  it('org_admin A создаёт тип для чужой орг B → 403', async () => {
    currentUser = adminA;
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      payload: { slug: 'org_b_type', display_name: 'Org B', organization_id: ORG_B },
    });
    expect(r.statusCode).toBe(403);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('viewer A → 403', async () => {
    currentUser = viewerA;
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      payload: { slug: 'org_a_type', display_name: 'Org A', organization_id: ORG_A },
    });
    expect(r.statusCode).toBe(403);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('super_admin создаёт тип для произвольной орг B → 201', async () => {
    currentUser = superAdmin;
    repo.create.mockResolvedValue(apiRow({ slug: 'org_b_type', organization_id: ORG_B }));
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      payload: { slug: 'org_b_type', display_name: 'Org B', organization_id: ORG_B },
    });
    expect(r.statusCode).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ organization_id: ORG_B }));
  });
});

describe('PATCH /api/v1/document-types/:slug — mutate authz', () => {
  it('org_admin A правит tenant-owned тип орг A → 200', async () => {
    currentUser = adminA;
    repo.findBySlug.mockResolvedValue(apiRow({ slug: 'org_a_type', organization_id: ORG_A }));
    repo.patch.mockResolvedValue(apiRow({ slug: 'org_a_type', organization_id: ORG_A, display_name: 'Renamed' }));
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/document-types/org_a_type',
      payload: { display_name: 'Renamed' },
    });
    expect(r.statusCode).toBe(200);
    expect(repo.patch).toHaveBeenCalledTimes(1);
  });

  it('org_admin B правит тип орг A → 403', async () => {
    currentUser = adminB;
    repo.findBySlug.mockResolvedValue(apiRow({ slug: 'org_a_type', organization_id: ORG_A }));
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/document-types/org_a_type',
      payload: { display_name: 'Hijack' },
    });
    expect(r.statusCode).toBe(403);
    expect(repo.patch).not.toHaveBeenCalled();
  });

  it('org_admin A правит global тип → 403', async () => {
    currentUser = adminA;
    repo.findBySlug.mockResolvedValue(apiRow({ slug: 'invoice', organization_id: null }));
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/document-types/invoice',
      payload: { display_name: 'Hijack' },
    });
    expect(r.statusCode).toBe(403);
    expect(repo.patch).not.toHaveBeenCalled();
  });

  it('super_admin правит global тип → 200', async () => {
    currentUser = superAdmin;
    repo.findBySlug.mockResolvedValue(apiRow({ slug: 'invoice', organization_id: null }));
    repo.patch.mockResolvedValue(apiRow({ slug: 'invoice', organization_id: null, display_name: 'Renamed' }));
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/document-types/invoice',
      payload: { display_name: 'Renamed' },
    });
    expect(r.statusCode).toBe(200);
    expect(repo.patch).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/v1/document-types/:slug — mutate authz + builtin guard', () => {
  it('org_admin A удаляет tenant-owned тип орг A → 204', async () => {
    currentUser = adminA;
    repo.findBySlug.mockResolvedValue(apiRow({ slug: 'org_a_type', organization_id: ORG_A, is_builtin: false }));
    repo.delete.mockResolvedValue(apiRow({ slug: 'org_a_type', organization_id: ORG_A }));
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/document-types/org_a_type' });
    expect(r.statusCode).toBe(204);
    expect(repo.delete).toHaveBeenCalledWith('org_a_type');
  });

  it('org_admin B удаляет тип орг A → 403', async () => {
    currentUser = adminB;
    repo.findBySlug.mockResolvedValue(apiRow({ slug: 'org_a_type', organization_id: ORG_A, is_builtin: false }));
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/document-types/org_a_type' });
    expect(r.statusCode).toBe(403);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('super_admin удаляет builtin (global) → 403 (deactivate-only)', async () => {
    currentUser = superAdmin;
    repo.findBySlug.mockResolvedValue(apiRow({ slug: 'invoice', organization_id: null, is_builtin: true }));
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/document-types/invoice' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/builtin/i);
    expect(repo.delete).not.toHaveBeenCalled();
  });
});
