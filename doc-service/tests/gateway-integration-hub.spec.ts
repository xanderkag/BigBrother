/**
 * Integration Hub backbone — gateway_connectors + gateway_consumer_budgets +
 * checkConsumerQuota + generic-units метеринг (INTEGRATION_HUB_VISION, Ф1).
 *
 * db.query замокан стейтфул-стабом, эмулирующим три таблицы:
 *   - gateway_connectors        (по slug, ON CONFLICT upsert)
 *   - gateway_consumer_budgets  (по (consumer,connector), ON CONFLICT upsert)
 *   - llm_gateway_usage         (хранит строки; SUM(units) success-today)
 * Так round-trip и квота проверяются end-to-end через реальные repo + функцию.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY ?? 'a'.repeat(64);

type ConnRow = {
  slug: string;
  display_name: string;
  provider_kind: string;
  unit_kind: string;
  daily_cap: number | null;
  monthly_cap: number | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

type BudgetRow = {
  consumer: string;
  connector: string;
  daily_budget: number | null;
  enabled: boolean;
};

type UsageRow = {
  caller: string | null;
  connector: string;
  units: number | null;
  status: string;
};

const connectors = new Map<string, ConnRow>();
const budgets = new Map<string, BudgetRow>();
const usage: UsageRow[] = [];

const bkey = (consumer: string, connector: string) => `${consumer}::${connector}`;

const queryMock = vi.fn(async (sql: string, params: unknown[] = []) => {
  // ── gateway_connectors ───────────────────────────────────────────
  if (/INSERT INTO gateway_connectors/i.test(sql)) {
    const [slug, dn, pk, uk, dcap, mcap, enabled, dcapSet, mcapSet] = params as [
      string,
      string | null,
      string | null,
      string | null,
      number | null,
      number | null,
      boolean | null,
      boolean,
      boolean,
    ];
    const existing = connectors.get(slug);
    const now = new Date();
    let next: ConnRow;
    if (!existing) {
      next = {
        slug,
        display_name: dn ?? slug,
        provider_kind: pk ?? 'llm',
        unit_kind: uk ?? 'calls',
        daily_cap: dcap,
        monthly_cap: mcap,
        enabled: enabled ?? false,
        created_at: now,
        updated_at: now,
      };
    } else {
      next = {
        ...existing,
        display_name: dn ?? existing.display_name,
        provider_kind: pk ?? existing.provider_kind,
        unit_kind: uk ?? existing.unit_kind,
        daily_cap: dcapSet ? dcap : existing.daily_cap,
        monthly_cap: mcapSet ? mcap : existing.monthly_cap,
        enabled: enabled ?? existing.enabled,
        updated_at: now,
      };
    }
    connectors.set(slug, next);
    return { rows: [next] };
  }
  if (/SELECT \* FROM gateway_connectors WHERE slug/i.test(sql)) {
    const row = connectors.get(params[0] as string);
    return { rows: row ? [row] : [] };
  }
  if (/SELECT \* FROM gateway_connectors/i.test(sql)) {
    return { rows: [...connectors.values()] };
  }

  // ── gateway_consumer_budgets ─────────────────────────────────────
  if (/INSERT INTO gateway_consumer_budgets/i.test(sql)) {
    const [consumer, connector, daily, enabled, dailySet] = params as [
      string,
      string,
      number | null,
      boolean | null,
      boolean,
    ];
    const k = bkey(consumer, connector);
    const existing = budgets.get(k);
    const next: BudgetRow = existing
      ? {
          ...existing,
          daily_budget: dailySet ? daily : existing.daily_budget,
          enabled: enabled ?? existing.enabled,
        }
      : { consumer, connector, daily_budget: daily, enabled: enabled ?? true };
    budgets.set(k, next);
    return { rows: [next] };
  }
  if (/SELECT \* FROM gateway_consumer_budgets\s+WHERE consumer = \$1 AND connector/i.test(sql)) {
    const row = budgets.get(bkey(params[0] as string, params[1] as string));
    return { rows: row ? [row] : [] };
  }
  if (/SELECT \* FROM gateway_consumer_budgets WHERE consumer/i.test(sql)) {
    const consumer = params[0] as string;
    return { rows: [...budgets.values()].filter((b) => b.consumer === consumer) };
  }

  // ── llm_gateway_usage ────────────────────────────────────────────
  if (/INSERT INTO llm_gateway_usage/i.test(sql)) {
    // positions: 0 caller, ... 6 status, ... 8 connector, 9 units, 10 unit_kind
    usage.push({
      caller: params[0] as string | null,
      status: params[6] as string,
      connector: params[8] as string,
      units: params[9] as number | null,
    });
    return { rows: [] };
  }
  if (/SUM\(units\)/i.test(sql)) {
    const caller = params[0] as string;
    const connector = params[1] as string;
    const sum = usage
      .filter((u) => u.caller === caller && u.connector === connector && u.status === 'success')
      .reduce((acc, u) => acc + (u.units ?? 0), 0);
    return { rows: [{ used: String(sum) }] };
  }

  throw new Error(`unexpected sql: ${sql}`);
});

vi.mock('../src/db.js', () => ({ db: { query: queryMock } }));

let repos: typeof import('../src/storage/gateway-connectors.js');
let usageRepo: typeof import('../src/storage/llm-usage.js');

beforeEach(async () => {
  vi.clearAllMocks();
  connectors.clear();
  budgets.clear();
  usage.length = 0;
  repos = await import('../src/storage/gateway-connectors.js');
  usageRepo = await import('../src/storage/llm-usage.js');
});

describe('gatewayConnectorsRepo round-trip', () => {
  it('upsert → getBySlug возвращает коннектор', async () => {
    await repos.gatewayConnectorsRepo.upsert('dadata', {
      display_name: 'DaData',
      provider_kind: 'dadata',
      unit_kind: 'calls',
      daily_cap: 10000,
      enabled: true,
    });
    const got = await repos.gatewayConnectorsRepo.getBySlug('dadata');
    expect(got).not.toBeNull();
    expect(got!.display_name).toBe('DaData');
    expect(got!.unit_kind).toBe('calls');
    expect(got!.daily_cap).toBe(10000);
    expect(got!.enabled).toBe(true);
  });

  it('getBySlug неизвестного → null; list возвращает все', async () => {
    expect(await repos.gatewayConnectorsRepo.getBySlug('nope')).toBeNull();
    await repos.gatewayConnectorsRepo.upsert('llm', { display_name: 'LLM', enabled: true });
    await repos.gatewayConnectorsRepo.upsert('yandex_maps', { display_name: 'Я.Карты' });
    const all = await repos.gatewayConnectorsRepo.list();
    expect(all.map((c) => c.slug).sort()).toEqual(['llm', 'yandex_maps']);
  });

  it('upsert второй раз патчит, undefined cap не затирает', async () => {
    await repos.gatewayConnectorsRepo.upsert('dadata', {
      display_name: 'DaData',
      daily_cap: 500,
      enabled: false,
    });
    await repos.gatewayConnectorsRepo.upsert('dadata', { enabled: true });
    const got = await repos.gatewayConnectorsRepo.getBySlug('dadata');
    expect(got!.enabled).toBe(true);
    expect(got!.daily_cap).toBe(500); // не затёрт undefined
  });
});

describe('consumerBudgetsRepo round-trip', () => {
  it('upsert → getBudget по (consumer,connector)', async () => {
    await repos.consumerBudgetsRepo.upsert('podrazdelenie', 'dadata', { daily_budget: 200 });
    const b = await repos.consumerBudgetsRepo.getBudget('podrazdelenie', 'dadata');
    expect(b).not.toBeNull();
    expect(b!.daily_budget).toBe(200);
    expect(b!.enabled).toBe(true);
  });

  it('getBudget без строки → null', async () => {
    expect(await repos.consumerBudgetsRepo.getBudget('x', 'dadata')).toBeNull();
  });
});

describe('checkConsumerQuota', () => {
  async function seedConnector(patch: Parameters<typeof repos.gatewayConnectorsRepo.upsert>[1]) {
    await repos.gatewayConnectorsRepo.upsert('dadata', {
      display_name: 'DaData',
      provider_kind: 'dadata',
      unit_kind: 'calls',
      enabled: true,
      ...patch,
    });
  }
  function pushUsage(units: number, status = 'success') {
    usage.push({ caller: 'c1', connector: 'dadata', units, status });
  }

  it('под лимитом → allowed', async () => {
    await seedConnector({ daily_cap: 100 });
    pushUsage(10);
    pushUsage(20);
    const q = await repos.checkConsumerQuota('c1', 'dadata');
    expect(q.allowed).toBe(true);
    expect(q.used).toBe(30);
    expect(q.dailyCap).toBe(100);
  });

  it('превышен connector cap → !allowed (quota_exceeded)', async () => {
    await seedConnector({ daily_cap: 50 });
    pushUsage(30);
    pushUsage(25);
    const q = await repos.checkConsumerQuota('c1', 'dadata');
    expect(q.allowed).toBe(false);
    expect(q.used).toBe(55);
    expect(q.reason).toBe('quota_exceeded');
  });

  it('нет cap (connector.daily_cap=null, нет бюджета) → allowed/fail-open', async () => {
    await seedConnector({ daily_cap: null });
    pushUsage(99999);
    const q = await repos.checkConsumerQuota('c1', 'dadata');
    expect(q.allowed).toBe(true);
    expect(q.reason).toBe('no_cap');
  });

  it('per-consumer бюджет строже connector cap → бьёт по бюджету', async () => {
    await seedConnector({ daily_cap: 1000 });
    await repos.consumerBudgetsRepo.upsert('c1', 'dadata', { daily_budget: 40 });
    pushUsage(40);
    const q = await repos.checkConsumerQuota('c1', 'dadata');
    expect(q.allowed).toBe(false);
    expect(q.dailyBudget).toBe(40);
    expect(q.reason).toBe('quota_exceeded');
  });

  it('error-вызовы не учитываются в used', async () => {
    await seedConnector({ daily_cap: 100 });
    pushUsage(60, 'error');
    pushUsage(60, 'timeout');
    pushUsage(10, 'success');
    const q = await repos.checkConsumerQuota('c1', 'dadata');
    expect(q.used).toBe(10);
    expect(q.allowed).toBe(true);
  });

  it('неизвестный коннектор → allowed (нечего энфорсить)', async () => {
    const q = await repos.checkConsumerQuota('c1', 'nope');
    expect(q.allowed).toBe(true);
    expect(q.reason).toBe('unknown_connector');
  });

  it('disabled коннектор → !allowed (connector_disabled)', async () => {
    await seedConnector({ daily_cap: 100, enabled: false });
    const q = await repos.checkConsumerQuota('c1', 'dadata');
    expect(q.allowed).toBe(false);
    expect(q.reason).toBe('connector_disabled');
  });

  it('disabled бюджет потребителя → !allowed (consumer_disabled)', async () => {
    await seedConnector({ daily_cap: 100 });
    await repos.consumerBudgetsRepo.upsert('c1', 'dadata', { enabled: false });
    const q = await repos.checkConsumerQuota('c1', 'dadata');
    expect(q.allowed).toBe(false);
    expect(q.reason).toBe('consumer_disabled');
  });
});

describe('llm_gateway_usage пишет generic-units', () => {
  it('LLM-путь по умолчанию: connector=llm, unit_kind=tokens, units=сумма', async () => {
    await usageRepo.llmGatewayUsageRepo.record({
      caller: 'slai',
      alias: 'parsdocs-chat',
      model: 'mistral',
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 12,
      status: 'success',
    });
    const [sql, params] = queryMock.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toMatch(/connector, units, unit_kind/);
    expect(params[8]).toBe('llm'); // connector
    expect(params[9]).toBe(150); // units = 100+50
    expect(params[10]).toBe('tokens'); // unit_kind
  });

  it('LLM без токенов → units=null', async () => {
    await usageRepo.llmGatewayUsageRepo.record({
      caller: 'slai',
      alias: 'parsdocs-chat',
      model: 'mistral',
      latencyMs: 5,
      status: 'error',
    });
    const [, params] = queryMock.mock.calls.at(-1) as [string, unknown[]];
    expect(params[8]).toBe('llm');
    expect(params[9]).toBeNull();
  });

  it('коннектор-путь: connector/units/unitKind проброшены явно', async () => {
    await usageRepo.llmGatewayUsageRepo.record({
      caller: 'podrazdelenie',
      alias: 'dadata-findById',
      model: 'dadata',
      latencyMs: 80,
      status: 'success',
      connector: 'dadata',
      units: 1,
      unitKind: 'calls',
    });
    const [, params] = queryMock.mock.calls.at(-1) as [string, unknown[]];
    expect(params[8]).toBe('dadata');
    expect(params[9]).toBe(1);
    expect(params[10]).toBe('calls');
  });
});
