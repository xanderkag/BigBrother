import { db } from '../db.js';
import type { GatewayUnitKind } from './llm-usage.js';

/**
 * Integration Hub — реестр коннекторов + суточные бюджеты потребителей +
 * проверка квоты (INTEGRATION_HUB_VISION, Ф1 backbone).
 *
 * Ось учёта: потребитель × коннектор × units × время. Коннектор = внешний
 * API (llm/dadata/yandex_maps) с центральным ключом в сейфе (provider_settings
 * по provider_kind). Бюджет = персональный суточный лимит потребителя
 * (= caller в llm_gateway_usage) на конкретный коннектор.
 *
 * checkConsumerQuota() считает СЕГОДНЯШНИЕ success-units и сравнивает с
 * min(connector.daily_cap, budget.daily_budget). Enforcement в роуты пока
 * НЕ вшит (следующий инкремент) — это готовая, протестированная спина.
 */

export type GatewayConnectorRow = {
  slug: string;
  display_name: string;
  provider_kind: string;
  unit_kind: string; // 'tokens' | 'calls' | 'geocodes' | 'routes'
  daily_cap: number | null;
  monthly_cap: number | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type GatewayConnector = {
  slug: string;
  display_name: string;
  provider_kind: string;
  unit_kind: GatewayUnitKind;
  daily_cap: number | null;
  monthly_cap: number | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

/** Patch для upsert. undefined = не трогать колонку (COALESCE). */
export type GatewayConnectorPatch = {
  display_name?: string;
  provider_kind?: string;
  unit_kind?: GatewayUnitKind;
  daily_cap?: number | null;
  monthly_cap?: number | null;
  enabled?: boolean;
};

function connectorToApi(row: GatewayConnectorRow): GatewayConnector {
  return {
    slug: row.slug,
    display_name: row.display_name,
    provider_kind: row.provider_kind,
    unit_kind: row.unit_kind as GatewayUnitKind,
    daily_cap: row.daily_cap,
    monthly_cap: row.monthly_cap,
    enabled: row.enabled,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

class GatewayConnectorsRepo {
  /** Все коннекторы, по slug. */
  async list(): Promise<GatewayConnector[]> {
    const { rows } = await db.query<GatewayConnectorRow>(
      `SELECT * FROM gateway_connectors ORDER BY slug`,
    );
    return rows.map(connectorToApi);
  }

  /** Коннектор по slug, или null. */
  async getBySlug(slug: string): Promise<GatewayConnector | null> {
    const { rows } = await db.query<GatewayConnectorRow>(
      `SELECT * FROM gateway_connectors WHERE slug = $1`,
      [slug],
    );
    return rows[0] ? connectorToApi(rows[0]) : null;
  }

  /**
   * INSERT ... ON CONFLICT (slug) DO UPDATE. На INSERT-ветке отсутствующие
   * в patch поля берут дефолты таблицы; на UPDATE-ветке undefined-поля
   * остаются как есть (COALESCE на NOT NULL, CASE-гвард на nullable cap).
   */
  async upsert(slug: string, patch: GatewayConnectorPatch): Promise<GatewayConnector> {
    const { rows } = await db.query<GatewayConnectorRow>(
      `INSERT INTO gateway_connectors (
         slug, display_name, provider_kind, unit_kind,
         daily_cap, monthly_cap, enabled, updated_at
       ) VALUES (
         $1,
         COALESCE($2, $1),
         COALESCE($3, 'llm'),
         COALESCE($4, 'calls'),
         $5, $6, COALESCE($7, false), now()
       )
       ON CONFLICT (slug) DO UPDATE SET
         display_name  = COALESCE($2, gateway_connectors.display_name),
         provider_kind = COALESCE($3, gateway_connectors.provider_kind),
         unit_kind     = COALESCE($4, gateway_connectors.unit_kind),
         daily_cap     = CASE WHEN $8 THEN $5 ELSE gateway_connectors.daily_cap END,
         monthly_cap   = CASE WHEN $9 THEN $6 ELSE gateway_connectors.monthly_cap END,
         enabled       = COALESCE($7, gateway_connectors.enabled),
         updated_at    = now()
       RETURNING *`,
      [
        slug,
        patch.display_name ?? null,
        patch.provider_kind ?? null,
        patch.unit_kind ?? null,
        patch.daily_cap ?? null,
        patch.monthly_cap ?? null,
        patch.enabled ?? null,
        patch.daily_cap !== undefined,
        patch.monthly_cap !== undefined,
      ],
    );
    return connectorToApi(rows[0]!);
  }
}

export type ConsumerBudgetRow = {
  consumer: string;
  connector: string;
  daily_budget: number | null;
  enabled: boolean;
};

export type ConsumerBudget = {
  consumer: string;
  connector: string;
  daily_budget: number | null;
  enabled: boolean;
};

/** Patch для upsert бюджета. undefined = не трогать. */
export type ConsumerBudgetPatch = {
  daily_budget?: number | null;
  enabled?: boolean;
};

class ConsumerBudgetsRepo {
  /** Бюджет (consumer, connector), или null если строки нет. */
  async getBudget(consumer: string, connector: string): Promise<ConsumerBudget | null> {
    const { rows } = await db.query<ConsumerBudgetRow>(
      `SELECT * FROM gateway_consumer_budgets
        WHERE consumer = $1 AND connector = $2`,
      [consumer, connector],
    );
    return rows[0] ?? null;
  }

  /** Все бюджеты потребителя. */
  async listByConsumer(consumer: string): Promise<ConsumerBudget[]> {
    const { rows } = await db.query<ConsumerBudgetRow>(
      `SELECT * FROM gateway_consumer_budgets WHERE consumer = $1 ORDER BY connector`,
      [consumer],
    );
    return rows;
  }

  /** INSERT ... ON CONFLICT (consumer, connector) DO UPDATE. */
  async upsert(
    consumer: string,
    connector: string,
    patch: ConsumerBudgetPatch,
  ): Promise<ConsumerBudget> {
    const { rows } = await db.query<ConsumerBudgetRow>(
      `INSERT INTO gateway_consumer_budgets (consumer, connector, daily_budget, enabled)
       VALUES ($1, $2, $3, COALESCE($4, true))
       ON CONFLICT (consumer, connector) DO UPDATE SET
         daily_budget = CASE WHEN $5 THEN $3 ELSE gateway_consumer_budgets.daily_budget END,
         enabled      = COALESCE($4, gateway_consumer_budgets.enabled)
       RETURNING *`,
      [
        consumer,
        connector,
        patch.daily_budget ?? null,
        patch.enabled ?? null,
        patch.daily_budget !== undefined,
      ],
    );
    return rows[0]!;
  }
}

export const gatewayConnectorsRepo = new GatewayConnectorsRepo();
export const consumerBudgetsRepo = new ConsumerBudgetsRepo();

export type ConsumerQuotaResult = {
  allowed: boolean;
  used: number;
  dailyCap: number | null;
  dailyBudget: number | null;
  reason?: string;
};

/**
 * Проверка суточной квоты потребителя на коннектор.
 *
 * Считает СЕГОДНЯШНИЕ (по started_at, date) success-units из
 * llm_gateway_usage по (caller=consumer, connector) и сравнивает с
 * effectiveCap = min(connector.daily_cap, budget.daily_budget) (NULL-cap'ы
 * выпадают из min).
 *
 * Семантика fail-open:
 *   - неизвестный коннектор          → allowed (нечего энфорсить);
 *   - коннектор/бюджет disabled       → !allowed (явный stop);
 *   - effectiveCap = null (нет cap'ов) → allowed (fail-open, лимита нет);
 *   - used >= effectiveCap            → !allowed (квота исчерпана);
 *   - иначе                           → allowed.
 *
 * Enforcement в роуты пока НЕ вшит — это следующий инкремент (за фича-флагом).
 */
export async function checkConsumerQuota(
  consumer: string,
  connector: string,
): Promise<ConsumerQuotaResult> {
  const conn = await gatewayConnectorsRepo.getBySlug(connector);
  if (!conn) {
    return { allowed: true, used: 0, dailyCap: null, dailyBudget: null, reason: 'unknown_connector' };
  }
  if (!conn.enabled) {
    return {
      allowed: false,
      used: 0,
      dailyCap: conn.daily_cap,
      dailyBudget: null,
      reason: 'connector_disabled',
    };
  }

  const budget = await consumerBudgetsRepo.getBudget(consumer, connector);
  if (budget && !budget.enabled) {
    return {
      allowed: false,
      used: 0,
      dailyCap: conn.daily_cap,
      dailyBudget: budget.daily_budget,
      reason: 'consumer_disabled',
    };
  }

  const dailyCap = conn.daily_cap;
  const dailyBudget = budget?.daily_budget ?? null;
  const caps = [dailyCap, dailyBudget].filter((c): c is number => c !== null);
  const effectiveCap = caps.length > 0 ? Math.min(...caps) : null;

  // Сегодняшние списанные units (только успешные вызовы).
  const { rows } = await db.query<{ used: string | null }>(
    `SELECT COALESCE(SUM(units), 0) AS used
       FROM llm_gateway_usage
      WHERE caller = $1
        AND connector = $2
        AND status = 'success'
        AND started_at::date = now()::date`,
    [consumer, connector],
  );
  const used = Number(rows[0]?.used ?? 0);

  // Нет cap'ов → fail-open (учитываем, но не блокируем).
  if (effectiveCap === null) {
    return { allowed: true, used, dailyCap, dailyBudget, reason: 'no_cap' };
  }

  if (used >= effectiveCap) {
    return { allowed: false, used, dailyCap, dailyBudget, reason: 'quota_exceeded' };
  }
  return { allowed: true, used, dailyCap, dailyBudget };
}
