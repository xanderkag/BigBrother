import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { documentTypesRepo } from '../storage/document-types.js';
import { auditLogRepo } from '../storage/audit-log.js';
import { jobsRepo } from '../storage/jobs.js';
import { documentTypeResolver } from '../pipeline/document-type-resolver.js';
import { ErrorResponse, Job } from '../types/api-schemas.js';
import { bearerAuthHook } from '../auth.js';
import { requireSuperAdmin } from '../authz.js';

/**
 * Document Type Registry — admin CRUD.
 *
 * Read endpoints — surface the configured state for the admin UI dropdowns
 * and detail pages.
 *
 * Write endpoints (POST/PATCH/DELETE) — let the operator add custom document
 * types, retune prompts/schemas/thresholds, deactivate types that are no
 * longer needed. Every write:
 *   1. mutates the row in the DB,
 *   2. fires `documentTypeResolver.invalidate(slug)` so the next job picks
 *      up the new config without waiting for TTL,
 *   3. appends an `audit_log` entry with before/after snapshots.
 *
 * Builtin-protection: `is_builtin=true` rows can be edited (admins do tune
 * them), but never deleted via the API. Deactivate them instead.
 *
 * Auth: same Bearer scheme as the rest of /api/v1/*. There are no per-user
 * roles yet — any valid token can write. Future: gate writes on `admin` role.
 */

const ParserKind = z.enum(['builtin:invoice_regex', 'builtin:upd_regex', 'llm_extract']);

const DocumentType = z.object({
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  is_builtin: z.boolean(),
  parser_kind: ParserKind,
  llm_prompt: z.string().nullable(),
  llm_schema: z.record(z.unknown()).nullable(),
  expected_fields: z.array(z.string()),
  validators: z.array(z.string()),
  confidence_threshold: z.number().nullable(),
  regex_fallback_threshold: z.number().nullable(),
  classification_keywords: z.array(z.string()),
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ListResponse = z.object({
  items: z.array(DocumentType),
});

const SlugParam = z.object({
  slug: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: 'slug должен начинаться с буквы/цифры и содержать только [A-Za-z0-9_-]',
  }),
});

const Threshold = z.number().min(0).max(1).nullable();

// Поля, которые валидны в create. is_builtin не выставляется через API.
const CreateBody = z.object({
  slug: SlugParam.shape.slug,
  display_name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  is_active: z.boolean().optional(),
  parser_kind: ParserKind.optional(),
  llm_prompt: z.string().max(8000).nullable().optional(),
  llm_schema: z.record(z.unknown()).nullable().optional(),
  expected_fields: z.array(z.string().min(1).max(80)).max(64).optional(),
  validators: z.array(z.string().min(1).max(120)).max(64).optional(),
  confidence_threshold: Threshold.optional(),
  regex_fallback_threshold: Threshold.optional(),
  classification_keywords: z.array(z.string().min(1).max(200)).max(64).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

// PATCH — все поля опциональные, slug нельзя менять (берётся из URL).
const PatchBody = CreateBody.omit({ slug: true }).partial();

export async function documentTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  r.get(
    '/document-types',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Список всех зарегистрированных типов документов',
        description:
          'Возвращает все document_types из БД (включая inactive). Для админ-UI.',
        security: [{ bearerAuth: [] }],
        response: {
          200: ListResponse,
          401: ErrorResponse,
        },
      },
    },
    async () => {
      const rows = await documentTypesRepo.list();
      return { items: rows.map((r) => documentTypesRepo.toApi(r)) };
    },
  );

  r.get(
    '/document-types/:slug',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Конфигурация конкретного типа документа',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        response: {
          200: DocumentType,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const row = await documentTypesRepo.findBySlug(req.params.slug);
      if (!row) {
        reply.code(404);
        return { error: 'document type not found' };
      }
      return documentTypesRepo.toApi(row);
    },
  );

  r.post(
    '/document-types',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Создать новый тип документа',
        description:
          'Заводит пользовательский тип (is_builtin=false). slug должен быть уникален. ' +
          'После создания — инвалидируется resolver-кэш, пишется запись в audit_log.',
        security: [{ bearerAuth: [] }],
        body: CreateBody,
        response: {
          201: DocumentType,
          400: ErrorResponse,
          401: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const existing = await documentTypesRepo.findBySlug(req.body.slug);
      if (existing) {
        reply.code(409);
        return { error: `document type "${req.body.slug}" already exists` };
      }
      const row = await documentTypesRepo.create(req.body);
      const after = documentTypesRepo.toApi(row);
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'document_type',
        entity_id: row.slug,
        action: 'create',
        after,
      });
      documentTypeResolver.invalidate(row.slug);
      reply.code(201);
      return after;
    },
  );

  r.patch(
    '/document-types/:slug',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Частичное обновление типа документа',
        description:
          'Любое поле = `undefined` оставляется как есть, явный `null` — обнуляет. ' +
          'Инвалидирует resolver-кэш, пишет audit_log.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: PatchBody,
        response: {
          200: DocumentType,
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const before = await documentTypesRepo.findBySlug(req.params.slug);
      if (!before) {
        reply.code(404);
        return { error: 'document type not found' };
      }
      const updated = await documentTypesRepo.patch(req.params.slug, req.body);
      if (!updated) {
        // race: row vanished between findBySlug and patch
        reply.code(404);
        return { error: 'document type not found' };
      }
      const beforeApi = documentTypesRepo.toApi(before);
      const afterApi = documentTypesRepo.toApi(updated);
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'document_type',
        entity_id: updated.slug,
        action: 'update',
        before: beforeApi,
        after: afterApi,
      });
      documentTypeResolver.invalidate(updated.slug);
      return afterApi;
    },
  );

  r.delete(
    '/document-types/:slug',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Удалить тип документа',
        description:
          'Удаляет пользовательский тип. Builtin-типы (is_builtin=true) защищены — ' +
          'их следует деактивировать через PATCH { is_active: false }, а не удалять.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        response: {
          204: z.null(),
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const row = await documentTypesRepo.findBySlug(req.params.slug);
      if (!row) {
        reply.code(404);
        return { error: 'document type not found' };
      }
      if (row.is_builtin) {
        reply.code(403);
        return {
          error:
            'builtin types cannot be deleted; deactivate via PATCH { is_active: false } instead',
        };
      }
      const deleted = await documentTypesRepo.delete(req.params.slug);
      if (deleted) {
        await auditLogRepo.append({
          actor: 'admin',
          entity: 'document_type',
          entity_id: row.slug,
          action: 'delete',
          before: documentTypesRepo.toApi(row),
        });
        documentTypeResolver.invalidate(row.slug);
      }
      reply.code(204);
      return null;
    },
  );

  // --- Observation endpoints: realtime feedback на работу типа ---

  const RecentJobsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  const RecentJobsResponse = z.object({
    items: z.array(Job),
  });

  r.get(
    '/document-types/:slug/jobs',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Последние jobs этого типа документа',
        description:
          'Возвращает N последних jobs с `document_type=:slug`, по убыванию created_at. ' +
          'Используется страницей типа документа для отображения реальных примеров обработки.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        querystring: RecentJobsQuery,
        response: {
          200: RecentJobsResponse,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const exists = await documentTypesRepo.findBySlug(req.params.slug);
      if (!exists) {
        reply.code(404);
        return { error: 'document type not found' };
      }
      const rows = await jobsRepo.listByDocumentType(req.params.slug, req.query.limit);
      return { items: rows.map((r) => jobsRepo.toApi(r)) };
    },
  );

  const StatsQuery = z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
  });

  const StatsResponse = z.object({
    slug: z.string(),
    period_days: z.number(),
    total_jobs: z.number(),
    terminal_breakdown: z.object({
      done: z.number(),
      needs_review: z.number(),
      failed: z.number(),
    }),
    avg_confidence: z.number().nullable(),
    expected_fields_coverage: z.array(
      z.object({
        field: z.string(),
        filled: z.number(),
        total: z.number(),
        filled_pct: z.number(),
      }),
    ),
  });

  r.get(
    '/document-types/:slug/stats',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Сводная статистика по типу: покрытие полей, doneness, avg confidence',
        description:
          'За последние N дней (по умолчанию 30) возвращает: сколько jobs обработано, ' +
          'раскладку по терминальным статусам, средний confidence терминальных, и ' +
          'для каждого `expected_field` — долю jobs где это поле фактически заполнено. ' +
          'Под выявление пробелов в parser/prompt — если `seller.inn` filled_pct=0.6, ' +
          'значит модель не справляется и нужно тюнить инструкцию или схему.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        querystring: StatsQuery,
        response: {
          200: StatsResponse,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const type = await documentTypesRepo.findBySlug(req.params.slug);
      if (!type) {
        reply.code(404);
        return { error: 'document type not found' };
      }

      const days = req.query.days;
      const [stats, coverage] = await Promise.all([
        jobsRepo.getTypeStats(req.params.slug, days),
        jobsRepo.getFieldCoverage(req.params.slug, type.expected_fields, days),
      ]);

      return {
        slug: req.params.slug,
        period_days: days,
        total_jobs: stats.total_jobs,
        terminal_breakdown: stats.terminal_breakdown,
        avg_confidence: stats.avg_confidence,
        expected_fields_coverage: coverage.map((c) => ({
          field: c.field,
          filled: c.filled,
          total: c.total,
          filled_pct: c.total === 0 ? 0 : Math.round((c.filled / c.total) * 100) / 100,
        })),
      };
    },
  );
}
