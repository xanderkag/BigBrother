/**
 * INTEGRATION_HUB (Ф1) — HTTP-level тесты admin-роутов /api/v1/gateway/*.
 *
 * Harness как в document-types-routes.spec: голый Fastify + zod-компиляторы,
 * монтируем только gatewayAdminRoutes. `../src/auth.js` замокан — bearerAuthHook
 * кладёт выбранную тест-роль в req.user. Гейт requireSuperAdmin из authz.js —
 * настоящий (матрица 401/403 на реальной логике). Репо коннекторов/бюджетов и
 * db.query (для usage + listAllBudgets) замоканы стейтфул-стабом.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { AuthUser } from '../src/auth.js';

let currentUser: AuthUser | undefined;

vi.mock('../src/auth.js', () => ({
  bearerAuthHook: async (req: { user?: AuthUser }) => {
    req.user = currentUser;
  },
}));

const connectorsRepo = {
  list: vi.fn(),
  upsert: vi.fn(),
};
const budgetsRepo = {
  listByConsumer: vi.fn(),
  upsert: vi.fn(),
};
vi.mock('../src/storage/gateway-connectors.js', () => ({
  gatewayConnectorsRepo: connectorsRepo,
  consumerBudgetsRepo: budgetsRepo,
}));

const queryMock = vi.fn();
vi.mock('../src/db.js', () => ({ db: { query: queryMock } }));

// usersRepo нужен authz.getEffectiveScope в некоторых ветках, но super_admin
// его не дёргает; мокаем на всякий.
vi.mock('../src/storage/users.js', () => ({
  usersRepo: { getAccessibleProjectIds: vi.fn().mockResolvedValue(new Set<string>()) },
}));

let gatewayAdminRoutes: typeof import('../src/routes/gateway-admin.js').gatewayAdminRoutes;

beforeAll(async () => {
  ({ gatewayAdminRoutes } = await import('../src/routes/gateway-admin.js'));
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

const superAdmin = user({ role: 'super_admin', isSuperAdmin: true });
const orgAdmin = user({ role: 'org_admin', organization_id: '00000000-0000-0000-0000-0000000000a1' });

function connectorApi(over: Record<string, unknown> = {}) {
  return {
    slug: 'dadata',
    display_name: 'DaData',
    provider_kind: 'dadata',
    unit_kind: 'calls',
    daily_cap: null,
    monthly_cap: null,
    enabled: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(gatewayAdminRoutes, { prefix: '/api/v1' });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  currentUser = undefined;
  app = await makeApp();
});

describe('auth-гейт (super_admin only)', () => {
  it('нет user → 401 на GET connectors', async () => {
    currentUser = undefined;
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/connectors' });
    expect(r.statusCode).toBe(401);
    expect(connectorsRepo.list).not.toHaveBeenCalled();
  });

  it('org_admin (не super) → 403 на GET connectors', async () => {
    currentUser = orgAdmin;
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/connectors' });
    expect(r.statusCode).toBe(403);
    expect(connectorsRepo.list).not.toHaveBeenCalled();
  });

  it('org_admin → 403 на PATCH connector', async () => {
    currentUser = orgAdmin;
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/connectors/dadata',
      payload: { enabled: true },
    });
    expect(r.statusCode).toBe(403);
    expect(connectorsRepo.upsert).not.toHaveBeenCalled();
  });

  it('org_admin → 403 на GET budgets / PATCH budgets / GET usage', async () => {
    currentUser = orgAdmin;
    const a = await app.inject({ method: 'GET', url: '/api/v1/gateway/budgets' });
    const b = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/budgets',
      payload: { consumer: 'c1', connector: 'dadata', daily_budget: 10 },
    });
    const c = await app.inject({ method: 'GET', url: '/api/v1/gateway/usage' });
    expect(a.statusCode).toBe(403);
    expect(b.statusCode).toBe(403);
    expect(c.statusCode).toBe(403);
  });
});

describe('GET /api/v1/gateway/connectors', () => {
  it('super_admin → repo.list()', async () => {
    currentUser = superAdmin;
    connectorsRepo.list.mockResolvedValue([
      connectorApi({ slug: 'llm', enabled: true, unit_kind: 'tokens', daily_cap: 100000 }),
      connectorApi({ slug: 'dadata' }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/connectors' });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((i: { slug: string }) => i.slug)).toEqual(['llm', 'dadata']);
    expect(connectorsRepo.list).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /api/v1/gateway/connectors/:slug', () => {
  it('round-trip: enabled+daily_cap → repo.upsert, отдаёт обновлённый', async () => {
    currentUser = superAdmin;
    connectorsRepo.upsert.mockResolvedValue(
      connectorApi({ slug: 'dadata', enabled: true, daily_cap: 5000 }),
    );
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/connectors/dadata',
      payload: { enabled: true, daily_cap: 5000 },
    });
    expect(r.statusCode).toBe(200);
    expect(connectorsRepo.upsert).toHaveBeenCalledWith('dadata', {
      enabled: true,
      daily_cap: 5000,
    });
    expect(r.json().daily_cap).toBe(5000);
    expect(r.json().enabled).toBe(true);
  });

  it('daily_cap: null снимает лимит (явный null проброшен)', async () => {
    currentUser = superAdmin;
    connectorsRepo.upsert.mockResolvedValue(connectorApi({ slug: 'dadata', daily_cap: null }));
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/connectors/dadata',
      payload: { daily_cap: null },
    });
    expect(r.statusCode).toBe(200);
    expect(connectorsRepo.upsert).toHaveBeenCalledWith('dadata', { daily_cap: null });
  });

  it('пустое тело → 400 (нужно хотя бы одно поле)', async () => {
    currentUser = superAdmin;
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/connectors/dadata',
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(connectorsRepo.upsert).not.toHaveBeenCalled();
  });

  it('отрицательный cap → 400', async () => {
    currentUser = superAdmin;
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/connectors/dadata',
      payload: { daily_cap: -5 },
    });
    expect(r.statusCode).toBe(400);
    expect(connectorsRepo.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/gateway/budgets', () => {
  it('с ?consumer= → listByConsumer', async () => {
    currentUser = superAdmin;
    budgetsRepo.listByConsumer.mockResolvedValue([
      { consumer: 'c1', connector: 'dadata', daily_budget: 200, enabled: true },
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/budgets?consumer=c1' });
    expect(r.statusCode).toBe(200);
    expect(budgetsRepo.listByConsumer).toHaveBeenCalledWith('c1');
    expect(r.json().items).toHaveLength(1);
  });

  it('без ?consumer= → listAllBudgets через db.query', async () => {
    currentUser = superAdmin;
    queryMock.mockResolvedValueOnce({
      rows: [
        { consumer: 'c1', connector: 'dadata', daily_budget: 200, enabled: true },
        { consumer: 'c2', connector: 'llm', daily_budget: null, enabled: false },
      ],
    });
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/budgets' });
    expect(r.statusCode).toBe(200);
    expect(budgetsRepo.listByConsumer).not.toHaveBeenCalled();
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toMatch(/FROM gateway_consumer_budgets/);
    expect(r.json().items.map((i: { consumer: string }) => i.consumer)).toEqual(['c1', 'c2']);
  });
});

describe('PATCH /api/v1/gateway/budgets', () => {
  it('round-trip: upsert(consumer, connector, {daily_budget,enabled})', async () => {
    currentUser = superAdmin;
    budgetsRepo.upsert.mockResolvedValue({
      consumer: 'c1',
      connector: 'dadata',
      daily_budget: 150,
      enabled: true,
    });
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/budgets',
      payload: { consumer: 'c1', connector: 'dadata', daily_budget: 150, enabled: true },
    });
    expect(r.statusCode).toBe(200);
    expect(budgetsRepo.upsert).toHaveBeenCalledWith('c1', 'dadata', {
      daily_budget: 150,
      enabled: true,
    });
    expect(r.json().daily_budget).toBe(150);
  });

  it('опущенные поля не попадают в patch (undefined не передаётся)', async () => {
    currentUser = superAdmin;
    budgetsRepo.upsert.mockResolvedValue({
      consumer: 'c1',
      connector: 'dadata',
      daily_budget: null,
      enabled: false,
    });
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/budgets',
      payload: { consumer: 'c1', connector: 'dadata', enabled: false },
    });
    expect(r.statusCode).toBe(200);
    expect(budgetsRepo.upsert).toHaveBeenCalledWith('c1', 'dadata', { enabled: false });
  });

  it('без consumer/connector → 400', async () => {
    currentUser = superAdmin;
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/gateway/budgets',
      payload: { daily_budget: 10 },
    });
    expect(r.statusCode).toBe(400);
    expect(budgetsRepo.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/gateway/usage — агрегация', () => {
  it('группы по (consumer,connector,status); числа приведены из строк', async () => {
    currentUser = superAdmin;
    queryMock.mockResolvedValueOnce({
      rows: [
        { caller: 'slai', connector: 'llm', status: 'success', calls: '12', units: '3400' },
        { caller: 'slai', connector: 'llm', status: 'error', calls: '2', units: '0' },
        { caller: null, connector: 'dadata', status: 'success', calls: '5', units: '5' },
      ],
    });
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/usage' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.groups).toHaveLength(3);
    expect(body.groups[0]).toEqual({
      consumer: 'slai',
      connector: 'llm',
      status: 'success',
      calls: 12,
      units: 3400,
    });
    expect(body.groups[2].consumer).toBeNull();
    expect(body.daily).toBeUndefined();
  });

  it('from/to/consumer/connector → параметризованный WHERE', async () => {
    currentUser = superAdmin;
    queryMock.mockResolvedValueOnce({ rows: [] });
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/gateway/usage?from=2026-06-01&to=2026-06-25&consumer=slai&connector=llm',
    });
    expect(r.statusCode).toBe(200);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/started_at >= \$1/);
    expect(sql).toMatch(/started_at < \$2/);
    expect(sql).toMatch(/caller = \$3/);
    expect(sql).toMatch(/connector = \$4/);
    expect(params).toEqual(['2026-06-01', '2026-06-25', 'slai', 'llm']);
    expect(r.json().from).toBe('2026-06-01');
    expect(r.json().to).toBe('2026-06-25');
  });

  it('by_day=true → второй запрос + daily-массив', async () => {
    currentUser = superAdmin;
    queryMock
      .mockResolvedValueOnce({
        rows: [{ caller: 'slai', connector: 'llm', status: 'success', calls: '10', units: '100' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            day: '2026-06-24',
            caller: 'slai',
            connector: 'llm',
            status: 'success',
            calls: '4',
            units: '40',
          },
          {
            day: '2026-06-25',
            caller: 'slai',
            connector: 'llm',
            status: 'success',
            calls: '6',
            units: '60',
          },
        ],
      });
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/usage?by_day=true' });
    expect(r.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(2);
    const body = r.json();
    expect(body.daily).toHaveLength(2);
    expect(body.daily[0]).toEqual({
      day: '2026-06-24',
      consumer: 'slai',
      connector: 'llm',
      status: 'success',
      calls: 4,
      units: 40,
    });
  });
});
