import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuthHook } from '../auth.js';
import { getEffectiveScope } from '../authz.js';
import { jobsRepo } from '../storage/jobs.js';
import { ErrorResponse } from '../types/api-schemas.js';

/**
 * GET /api/v1/metrics/operational — операционный дашборд.
 *
 * Считаем из БД БЕЗ ground-truth (то, что можно без эталонов):
 *   - status breakdown
 *   - latency P50/P95 (end-to-end, includes очередь)
 *   - LLM tokens/duration P95 и fallback rate
 *   - per-type breakdown
 *   - throughput per hour
 *
 * Что СЮДА не входит и быть не может: classification accuracy и
 * field exact-match — нужен golden-set, см. `npm run eval`.
 *
 * Tenant-scope: ответ автоматически отфильтрован под текущего user'а
 * (через getEffectiveScope). super_admin видит всё, org_admin — свою
 * organization, обычный user — свои проекты.
 *
 * Query:
 *   window=24h|7d|30d  (default 7d). Любой ISO-8601 duration не парсим
 *                       — фикс. набор, чтобы legacy SQL мог использовать
 *                       один параметр часов.
 */

// Маппинг window-токенов в часы. Один источник правды.
const WINDOW_HOURS: Record<string, number> = {
  '1h': 1,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};
const WindowSchema = z.enum(['1h', '24h', '7d', '30d']).default('7d');

const OperationalQuery = z.object({
  window: WindowSchema.optional(),
});

const TypeRow = z.object({
  slug: z.string(),
  total: z.number().int(),
  done: z.number().int(),
  needs_review: z.number().int(),
  failed: z.number().int(),
  validation_issues: z.number().int(),
  llm_used: z.number().int(),
  latency_p50_ms: z.number().nullable(),
  latency_p95_ms: z.number().nullable(),
  avg_confidence: z.number().nullable(),
  done_rate: z.number(),
  needs_review_rate: z.number(),
  failed_rate: z.number(),
  validation_issue_rate: z.number(),
  llm_fallback_rate: z.number(),
});

const OperationalResponse = z.object({
  window: WindowSchema,
  window_hours: z.number(),
  generated_at: z.string(),
  scope: z.enum(['all', 'org', 'projects']),
  totals: z.object({
    total: z.number().int(),
    pending: z.number().int(),
    processing: z.number().int(),
    done: z.number().int(),
    needs_review: z.number().int(),
    failed: z.number().int(),
    validation_issues: z.number().int(),
    llm_used: z.number().int(),
  }),
  rates: z.object({
    done_rate: z.number(),
    needs_review_rate: z.number(),
    failed_rate: z.number(),
    validation_issue_rate: z.number(),
    llm_fallback_rate: z.number(),
  }),
  latency: z.object({
    p50_ms: z.number().nullable(),
    p95_ms: z.number().nullable(),
  }),
  llm: z.object({
    tokens_in_p95: z.number().nullable(),
    tokens_out_p95: z.number().nullable(),
    duration_p95_ms: z.number().nullable(),
  }),
  avg_confidence: z.number().nullable(),
  throughput_per_hour: z.number(),
  by_type: z.array(TypeRow),
});

export async function operationalMetricsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  r.get(
    '/metrics/operational',
    {
      schema: {
        tags: ['metrics'],
        summary: 'Operational-сводка: статусы, latency, LLM, throughput',
        description:
          'Возвращает агрегированную картину за окно (1h / 24h / 7d / 30d). ' +
          'Отвечает на «как работает прод сейчас» — без необходимости в golden-set. ' +
          'Для accuracy/coverage используйте `npm run eval`.',
        security: [{ bearerAuth: [] }],
        querystring: OperationalQuery,
        response: {
          200: OperationalResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req) => {
      const win = req.query.window ?? '7d';
      const hours = WINDOW_HOURS[win]!;
      const scope = await getEffectiveScope(req);
      const summary = await jobsRepo.getOperationalSummary(hours, scope);
      return {
        window: win,
        window_hours: summary.window_hours,
        generated_at: new Date().toISOString(),
        scope: scope.kind,
        totals: summary.totals,
        rates: summary.rates,
        latency: summary.latency,
        llm: summary.llm,
        avg_confidence: summary.avg_confidence,
        throughput_per_hour: summary.throughput_per_hour,
        by_type: summary.by_type,
      };
    },
  );
}
