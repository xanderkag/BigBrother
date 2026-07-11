/**
 * Ключи каналов шлюза — HTTP-тесты /api/v1/gateway/keys (GET) и
 * /api/v1/gateway/keys/:channel (PUT).
 *
 * Сценарий фичи: owner вносит Anthropic/OpenAI/DaData-ключи САМ через UI
 * «Подключения → Ключи каналов шлюза» — plaintext не ходит через чат и не
 * требует ручной правки .env. Harness как в gateway-admin-routes.spec:
 * голый Fastify, замоканы auth (роль в req.user), config, providerSettingsRepo
 * и audit; сам модуль storage/gateway-channel-keys.ts — НАСТОЯЩИЙ.
 *
 * Проверяем: super_admin-гейт, маппинг канал→well-known строка
 * (chat→'gateway-anthropic', embeddings→'openai', dadata→findDefault),
 * приоритет env над UI в active_source, маску (plaintext не утекает в ответ),
 * create-ветку (upsert + setDefault для dadata), patch-ветку, очистку
 * api_key=null, валидацию тела и канала, аудит create/update.
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

const { cfg } = vi.hoisted(() => ({
  cfg: {
    llmGateway: {
      enabled: true,
      backend: 'anthropic' as string,
      apiKey: undefined as string | undefined,
      embeddings: { enabled: false, apiKey: undefined as string | undefined },
      dadata: { enabled: false, apiKey: undefined as string | undefined },
    },
  },
}));
vi.mock('../src/config.js', () => ({ config: cfg }));

// Репо провайдеров — стейтфул-стаб. toApi повторяет маскировку прод-кода
// (plaintext не возвращается) в объёме, нужном тестам.
const providerRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findDefault: vi.fn(),
  patch: vi.fn(),
  upsert: vi.fn(),
  setDefault: vi.fn(),
  toApi: (row: {
    id: string;
    kind: string;
    api_key: string | null;
    is_active: boolean;
    is_default?: boolean;
  }) => ({
    id: row.id,
    kind: row.kind,
    api_key_masked: row.api_key ? `••••${row.api_key.slice(-4)}` : null,
    has_api_key: !!row.api_key,
    is_active: row.is_active,
    is_default: !!row.is_default,
  }),
}));
vi.mock('../src/storage/provider-settings.js', () => ({ providerSettingsRepo: providerRepo }));

const auditAppend = vi.fn();
vi.mock('../src/storage/audit-log.js', () => ({
  auditLogRepo: { append: (...a: unknown[]) => auditAppend(...a) },
}));

// Остальные зависимости gateway-admin.ts (коннекторы/usage) — не в фокусе.
vi.mock('../src/storage/gateway-connectors.js', () => ({
  gatewayConnectorsRepo: { list: vi.fn(), upsert: vi.fn(), getBySlug: vi.fn() },
  consumerBudgetsRepo: { listByConsumer: vi.fn(), upsert: vi.fn(), getBudget: vi.fn() },
}));
vi.mock('../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../src/storage/users.js', () => ({
  usersRepo: { getAccessibleProjectIds: vi.fn().mockResolvedValue(new Set<string>()) },
}));

let gatewayAdminRoutes: typeof import('../src/routes/gateway-admin.js').gatewayAdminRoutes;

beforeAll(async () => {
  ({ gatewayAdminRoutes } = await import('../src/routes/gateway-admin.js'));
});

function user(over: Partial<AuthUser>): AuthUser {
  return {
    id: 'u-test',
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

function providerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'gateway-anthropic',
    kind: 'llm',
    display_name: 'Anthropic · шлюз SLAI (chat)',
    description: null,
    base_url: null,
    api_key: 'sk-ant-secret-1234',
    model: null,
    is_active: true,
    is_default: false,
    vision: false,
    extra: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
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
  currentUser = superAdmin;
  cfg.llmGateway.apiKey = undefined;
  cfg.llmGateway.embeddings.apiKey = undefined;
  cfg.llmGateway.dadata.apiKey = undefined;
  cfg.llmGateway.enabled = true;
  cfg.llmGateway.embeddings.enabled = false;
  cfg.llmGateway.dadata.enabled = false;
  providerRepo.findById.mockResolvedValue(null);
  providerRepo.findDefault.mockResolvedValue(null);
  app = await makeApp();
});

describe('auth-гейт', () => {
  it('нет user → 401', async () => {
    currentUser = undefined;
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/keys' });
    expect(r.statusCode).toBe(401);
  });

  it('org_admin → 403 на GET и PUT', async () => {
    currentUser = orgAdmin;
    const g = await app.inject({ method: 'GET', url: '/api/v1/gateway/keys' });
    expect(g.statusCode).toBe(403);
    const p = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/chat',
      payload: { api_key: 'sk-ant-secret-1234' },
    });
    expect(p.statusCode).toBe(403);
    expect(providerRepo.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /gateway/keys — состояние каналов', () => {
  it('три канала; well-known id; пустое состояние без ключей', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/keys' });
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.channel)).toEqual(['chat', 'embeddings', 'dadata']);
    const chat = items[0]!;
    expect(chat.provider_id).toBe('gateway-anthropic');
    expect(chat.backend).toBe('anthropic');
    expect(chat.env_configured).toBe(false);
    expect(chat.ui_configured).toBe(false);
    expect(chat.active_source).toBeNull();
    expect(items[1]!.provider_id).toBe('openai');
    // dadata без default-провайдера → id, который создаст PUT
    expect(items[2]!.provider_id).toBe('dadata');
    expect(providerRepo.findById).toHaveBeenCalledWith('gateway-anthropic');
    expect(providerRepo.findById).toHaveBeenCalledWith('openai');
    expect(providerRepo.findDefault).toHaveBeenCalledWith('dadata');
  });

  it('UI-ключ → маска, plaintext в теле ответа отсутствует', async () => {
    providerRepo.findById.mockImplementation(async (id: string) =>
      id === 'gateway-anthropic' ? providerRow() : null,
    );
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/keys' });
    const chat = (r.json().items as Array<Record<string, unknown>>)[0]!;
    expect(chat.ui_configured).toBe(true);
    expect(chat.api_key_masked).toBe('••••1234');
    expect(chat.active_source).toBe('ui');
    expect(r.body).not.toContain('sk-ant-secret-1234');
  });

  it('env-ключ побеждает UI: active_source=env', async () => {
    cfg.llmGateway.apiKey = 'sk-ant-env';
    providerRepo.findById.mockImplementation(async (id: string) =>
      id === 'gateway-anthropic' ? providerRow() : null,
    );
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/keys' });
    const chat = (r.json().items as Array<Record<string, unknown>>)[0]!;
    expect(chat.env_configured).toBe(true);
    expect(chat.ui_configured).toBe(true);
    expect(chat.active_source).toBe('env');
  });

  it('неактивная строка не считается ui_configured', async () => {
    providerRepo.findById.mockImplementation(async (id: string) =>
      id === 'gateway-anthropic' ? providerRow({ is_active: false }) : null,
    );
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/keys' });
    const chat = (r.json().items as Array<Record<string, unknown>>)[0]!;
    expect(chat.ui_configured).toBe(false);
    expect(chat.active_source).toBeNull();
  });

  it('dadata: существующий default-провайдер отражается в provider_id/маске', async () => {
    providerRepo.findDefault.mockImplementation(async (kind: string) =>
      kind === 'dadata'
        ? providerRow({ id: 'dadata-main', kind: 'dadata', is_default: true, api_key: 'dd-key-9876' })
        : null,
    );
    const r = await app.inject({ method: 'GET', url: '/api/v1/gateway/keys' });
    const dd = (r.json().items as Array<Record<string, unknown>>)[2]!;
    expect(dd.provider_id).toBe('dadata-main');
    expect(dd.api_key_masked).toBe('••••9876');
    expect(dd.active_source).toBe('ui');
  });
});

describe('PUT /gateway/keys/:channel — запись ключа', () => {
  it('chat, строки нет → upsert well-known записи + аудит create', async () => {
    providerRepo.upsert.mockImplementation(async (input: Record<string, unknown>) =>
      providerRow({ ...input }),
    );
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/chat',
      payload: { api_key: 'sk-ant-new-key-5678' },
    });
    expect(r.statusCode).toBe(200);
    const input = providerRepo.upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.id).toBe('gateway-anthropic');
    expect(input.kind).toBe('llm');
    expect(input.api_key).toBe('sk-ant-new-key-5678');
    expect(providerRepo.setDefault).not.toHaveBeenCalled(); // default НЕ трогаем (не модель разбора)
    const body = r.json();
    expect(body.channel).toBe('chat');
    expect(body.ui_configured).toBe(true);
    expect(body.api_key_masked).toBe('••••5678');
    expect(r.body).not.toContain('sk-ant-new-key-5678');
    expect(auditAppend).toHaveBeenCalledTimes(1);
    const audit = auditAppend.mock.calls[0]![0] as Record<string, unknown>;
    expect(audit.entity).toBe('provider_setting');
    expect(audit.entity_id).toBe('gateway-anthropic');
    expect(audit.action).toBe('create');
    expect(JSON.stringify(audit)).not.toContain('sk-ant-new-key-5678');
  });

  it('chat, строка есть → patch(api_key, is_active:true) + аудит update', async () => {
    providerRepo.findById.mockImplementation(async (id: string) =>
      id === 'gateway-anthropic' ? providerRow({ api_key: 'sk-ant-old-0000' }) : null,
    );
    providerRepo.patch.mockResolvedValue(providerRow({ api_key: 'sk-ant-new-key-5678' }));
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/chat',
      payload: { api_key: 'sk-ant-new-key-5678' },
    });
    expect(r.statusCode).toBe(200);
    expect(providerRepo.patch).toHaveBeenCalledWith('gateway-anthropic', {
      api_key: 'sk-ant-new-key-5678',
      is_active: true,
    });
    expect(providerRepo.upsert).not.toHaveBeenCalled();
    expect((auditAppend.mock.calls[0]![0] as Record<string, unknown>).action).toBe('update');
  });

  it('api_key=null → очистка через patch, маска null', async () => {
    providerRepo.findById.mockImplementation(async (id: string) =>
      id === 'gateway-anthropic' ? providerRow() : null,
    );
    providerRepo.patch.mockResolvedValue(providerRow({ api_key: null }));
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/chat',
      payload: { api_key: null },
    });
    expect(r.statusCode).toBe(200);
    expect(providerRepo.patch).toHaveBeenCalledWith('gateway-anthropic', {
      api_key: null,
      is_active: true,
    });
    expect(r.json().ui_configured).toBe(false);
    expect(r.json().api_key_masked).toBeNull();
  });

  it('embeddings → пишет в magic-id "openai"', async () => {
    providerRepo.upsert.mockImplementation(async (input: Record<string, unknown>) =>
      providerRow({ ...input }),
    );
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/embeddings',
      payload: { api_key: 'sk-openai-key-4321' },
    });
    expect(r.statusCode).toBe(200);
    const input = providerRepo.upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.id).toBe('openai');
    expect(input.kind).toBe('llm');
    expect(r.json().provider_id).toBe('openai');
  });

  it('dadata без default → upsert + setDefault (request-path читает findDefault)', async () => {
    providerRepo.upsert.mockImplementation(async (input: Record<string, unknown>) =>
      providerRow({ ...input, is_default: false }),
    );
    providerRepo.setDefault.mockImplementation(async (id: string) =>
      providerRow({ id, kind: 'dadata', api_key: 'dd-key-778899', is_default: true }),
    );
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/dadata',
      payload: { api_key: 'dd-key-778899' },
    });
    expect(r.statusCode).toBe(200);
    expect((providerRepo.upsert.mock.calls[0]![0] as Record<string, unknown>).kind).toBe('dadata');
    expect(providerRepo.setDefault).toHaveBeenCalledWith('dadata');
    expect(r.json().api_key_masked).toBe('••••8899');
  });

  it('dadata с существующим default → patch его же, setDefault не зовётся', async () => {
    providerRepo.findDefault.mockImplementation(async (kind: string) =>
      kind === 'dadata' ? providerRow({ id: 'dadata-main', kind: 'dadata', is_default: true }) : null,
    );
    providerRepo.patch.mockResolvedValue(
      providerRow({ id: 'dadata-main', kind: 'dadata', api_key: 'dd-new-1111', is_default: true }),
    );
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/dadata',
      payload: { api_key: 'dd-new-1111' },
    });
    expect(r.statusCode).toBe(200);
    expect(providerRepo.patch).toHaveBeenCalledWith('dadata-main', {
      api_key: 'dd-new-1111',
      is_active: true,
    });
    expect(providerRepo.setDefault).not.toHaveBeenCalled();
  });

  it('валидация: неизвестный канал → 400, короткий ключ → 400', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/yandex',
      payload: { api_key: 'sk-ant-new-key-5678' },
    });
    expect(bad.statusCode).toBe(400);
    const short = await app.inject({
      method: 'PUT',
      url: '/api/v1/gateway/keys/chat',
      payload: { api_key: 'short' },
    });
    expect(short.statusCode).toBe(400);
    expect(providerRepo.upsert).not.toHaveBeenCalled();
    expect(providerRepo.patch).not.toHaveBeenCalled();
  });
});
