import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../db.js';
import {
  gatewayConnectorsRepo,
  consumerBudgetsRepo,
} from '../storage/gateway-connectors.js';
import { auditLogRepo } from '../storage/audit-log.js';
import { ErrorResponse } from '../types/api-schemas.js';
import { bearerAuthHook } from '../auth.js';
import { requireSuperAdmin } from '../authz.js';

/**
 * INTEGRATION_HUB (Ф1) — admin-управление коннекторами, бюджетами и сводка
 * usage для мониторинга. См. docs/INTEGRATION_HUB_VISION.md.
 *
 * Все эндпоинты — платформенного уровня (реестр внешних API + центральные
 * лимиты ключей + персональные бюджеты потребителей), поэтому гейтятся
 * super_admin'ом (как и прочие глобальные ресурсы — provider_settings,
 * глобальные document_types). Org-scope здесь нет: коннекторы общие.
 *
 *   GET   /api/v1/gateway/connectors        — реестр коннекторов.
 *   PATCH /api/v1/gateway/connectors/:slug  — upsert enabled/daily_cap/monthly_cap.
 *   GET   /api/v1/gateway/budgets?consumer=  — бюджеты (все или по потребителю).
 *   PATCH /api/v1/gateway/budgets           — upsert бюджета потребитель×коннектор.
 *   GET   /api/v1/gateway/usage?from=&to=... — агрегаты usage за период.
 */

// Единицы расхода коннекторов. ВАЖНО: это response-схема GET /gateway/connectors —
// любой коннектор в БД с unit_kind вне этого списка уронит валидацией ВЕСЬ экран
// «Интеграции», а не только свою строку. Добавляя коннектор в gateway_connectors,
// сначала добавь его единицу сюда.
//   pages — страницы, отправленные в облачный OCR (коннектор yandex_vision).
const UnitKind = z.enum(['tokens', 'calls', 'geocodes', 'routes', 'pages']);

const Connector = z.object({
  slug: z.string(),
  display_name: z.string(),
  provider_kind: z.string(),
  unit_kind: UnitKind,
  daily_cap: z.number().nullable(),
  monthly_cap: z.number().nullable(),
  enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ConnectorsResponse = z.object({
  items: z.array(Connector),
});

const SlugParam = z.object({
  slug: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: 'slug должен начинаться с буквы/цифры и содержать только [A-Za-z0-9_-]',
  }),
});

// Cap — неотрицательное целое (INTEGER в БД) или null (снять лимит). undefined
// в patch = не трогать колонку (repo делает CASE-гвард).
const Cap = z.number().int().min(0).nullable();

// PATCH коннектора — управляем лимитами/вкл-выкл. provider_kind/unit_kind/
// display_name не правим здесь (это конфиг реестра, не операционный рычаг).
const ConnectorPatchBody = z
  .object({
    enabled: z.boolean().optional(),
    daily_cap: Cap.optional(),
    monthly_cap: Cap.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'нужно хотя бы одно из: enabled, daily_cap, monthly_cap',
  });

const Budget = z.object({
  consumer: z.string(),
  connector: z.string(),
  daily_budget: z.number().nullable(),
  enabled: z.boolean(),
});

const BudgetsResponse = z.object({
  items: z.array(Budget),
});

const BudgetsQuery = z.object({
  consumer: z.string().min(1).max(200).optional(),
});

const BudgetPatchBody = z.object({
  consumer: z.string().min(1).max(200),
  connector: z.string().min(1).max(64),
  daily_budget: z.number().int().min(0).nullable().optional(),
  enabled: z.boolean().optional(),
});

// ── Usage-сводка ──────────────────────────────────────────────────────
const UsageQuery = z.object({
  // ISO-дата/время; пусто = без нижней/верхней границы.
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
  consumer: z.string().min(1).max(200).optional(),
  connector: z.string().min(1).max(64).optional(),
  // by_day=true → дополнительная разбивка по дням (для графика).
  by_day: z.coerce.boolean().optional(),
});

const UsageGroup = z.object({
  consumer: z.string().nullable(),
  connector: z.string(),
  status: z.string(),
  calls: z.number(),
  units: z.number(),
});

const UsageDailyGroup = UsageGroup.extend({
  day: z.string(),
});

const UsageResponse = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  groups: z.array(UsageGroup),
  // Присутствует только при by_day=true.
  daily: z.array(UsageDailyGroup).optional(),
});

type UsageGroupRow = {
  caller: string | null;
  connector: string;
  status: string;
  calls: string | number;
  units: string | number | null;
};

type UsageDailyRow = UsageGroupRow & { day: Date | string };

export async function gatewayAdminRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  r.get(
    '/gateway/connectors',
    {
      schema: {
        tags: ['gateway'],
        summary: 'Реестр коннекторов интеграционного хаба',
        description:
          'Список внешних API (llm/dadata/yandex_maps) с центральными лимитами ключа ' +
          '(daily_cap/monthly_cap) и флагом enabled. super_admin only.',
        security: [{ bearerAuth: [] }],
        response: { 200: ConnectorsResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const items = await gatewayConnectorsRepo.list();
      return { items };
    },
  );

  r.patch(
    '/gateway/connectors/:slug',
    {
      schema: {
        tags: ['gateway'],
        summary: 'Обновить лимиты/вкл-выкл коннектора',
        description:
          'Upsert по slug: enabled, daily_cap, monthly_cap. Поле = undefined ' +
          'оставляется как есть, явный null обнуляет cap (снять лимит). super_admin only.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: ConnectorPatchBody,
        response: {
          200: Connector,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      // before-state для diff (enabled/cap). null → строки не было (create).
      const before = await gatewayConnectorsRepo.getBySlug(req.params.slug);
      const updated = await gatewayConnectorsRepo.upsert(req.params.slug, req.body);
      // Аудит: смена рубильника/лимита теперь попадает в «Историю изменений»
      // карточки. actor='admin' пока общий Bearer (как в provider-settings).
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'gateway_connector',
        entity_id: req.params.slug,
        action: before ? 'update' : 'create',
        before: before as unknown as Record<string, unknown> | null,
        after: updated as unknown as Record<string, unknown>,
      });
      return updated;
    },
  );

  r.get(
    '/gateway/budgets',
    {
      schema: {
        tags: ['gateway'],
        summary: 'Суточные бюджеты потребителей',
        description:
          'Персональные суточные лимиты потребителя (=caller в usage) на коннектор. ' +
          'Без ?consumer= — все бюджеты; с ?consumer= — только этого потребителя. super_admin only.',
        security: [{ bearerAuth: [] }],
        querystring: BudgetsQuery,
        response: { 200: BudgetsResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const items = req.query.consumer
        ? await consumerBudgetsRepo.listByConsumer(req.query.consumer)
        : await listAllBudgets();
      return { items };
    },
  );

  r.patch(
    '/gateway/budgets',
    {
      schema: {
        tags: ['gateway'],
        summary: 'Upsert суточного бюджета потребителя на коннектор',
        description:
          'Создаёт/обновляет строку (consumer, connector). daily_budget=null — без ' +
          'персонального лимита (в рамках общего connector cap). super_admin only.',
        security: [{ bearerAuth: [] }],
        body: BudgetPatchBody,
        response: {
          200: Budget,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const { consumer, connector, daily_budget, enabled } = req.body;
      const before = await consumerBudgetsRepo.getBudget(consumer, connector);
      const updated = await consumerBudgetsRepo.upsert(consumer, connector, {
        ...(daily_budget !== undefined ? { daily_budget } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      });
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'gateway_budget',
        entity_id: `${consumer}::${connector}`,
        action: before ? 'update' : 'create',
        before: before as unknown as Record<string, unknown> | null,
        after: updated as unknown as Record<string, unknown>,
      });
      return updated;
    },
  );

  r.get(
    '/gateway/usage',
    {
      schema: {
        tags: ['gateway'],
        summary: 'Сводка usage интеграционного хаба за период',
        description:
          'Агрегаты llm_gateway_usage: count вызовов и сумма units, сгруппированные ' +
          'по (consumer/caller, connector, status) за период [from, to). Фильтры ' +
          'consumer/connector опциональны; by_day=true добавляет дневную разбивку ' +
          'для графика. Только чтение. super_admin only.',
        security: [{ bearerAuth: [] }],
        querystring: UsageQuery,
        response: { 200: UsageResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const { from, to, consumer, connector, by_day } = req.query;

      // Параметризованный WHERE: границы периода + опц. фильтры. started_at —
      // момент вызова; period halfopen [from, to) (to эксклюзивно — стандартно
      // для дневных бакетов).
      const where: string[] = [];
      const params: unknown[] = [];
      if (from) {
        params.push(from);
        where.push(`started_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        where.push(`started_at < $${params.length}`);
      }
      if (consumer) {
        params.push(consumer);
        where.push(`caller = $${params.length}`);
      }
      if (connector) {
        params.push(connector);
        where.push(`connector = $${params.length}`);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const groupsQ = await db.query<UsageGroupRow>(
        `SELECT caller, connector, status,
                COUNT(*)::bigint            AS calls,
                COALESCE(SUM(units), 0)     AS units
           FROM llm_gateway_usage
           ${whereSql}
          GROUP BY caller, connector, status
          ORDER BY connector, caller, status`,
        params,
      );
      const groups = groupsQ.rows.map((row) => ({
        consumer: row.caller,
        connector: row.connector,
        status: row.status,
        calls: Number(row.calls),
        units: Number(row.units),
      }));

      const out: {
        from: string | null;
        to: string | null;
        groups: typeof groups;
        daily?: Array<{
          day: string;
          consumer: string | null;
          connector: string;
          status: string;
          calls: number;
          units: number;
        }>;
      } = { from: from ?? null, to: to ?? null, groups };

      if (by_day) {
        const dailyQ = await db.query<UsageDailyRow>(
          `SELECT started_at::date         AS day,
                  caller, connector, status,
                  COUNT(*)::bigint         AS calls,
                  COALESCE(SUM(units), 0)  AS units
             FROM llm_gateway_usage
             ${whereSql}
            GROUP BY started_at::date, caller, connector, status
            ORDER BY day, connector, caller, status`,
          params,
        );
        out.daily = dailyQ.rows.map((row) => ({
          day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
          consumer: row.caller,
          connector: row.connector,
          status: row.status,
          calls: Number(row.calls),
          units: Number(row.units),
        }));
      }

      return out;
    },
  );
}

/**
 * Все бюджеты всех потребителей. Репо отдаёт только per-consumer срез, а
 * админ-список «всё» — отдельный лёгкий SELECT (без scope: коннекторы и их
 * бюджеты — платформенный ресурс, доступ уже отбит super_admin-гейтом).
 */
async function listAllBudgets() {
  const { rows } = await db.query<{
    consumer: string;
    connector: string;
    daily_budget: number | null;
    enabled: boolean;
  }>(
    `SELECT consumer, connector, daily_budget, enabled
       FROM gateway_consumer_budgets
      ORDER BY consumer, connector`,
  );
  return rows;
}
