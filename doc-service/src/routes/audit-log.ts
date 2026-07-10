import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditLogRepo, type AuditEntity } from '../storage/audit-log.js';
import { ErrorResponse } from '../types/api-schemas.js';
import { bearerAuthHook } from '../auth.js';

/**
 * Read-only API над `audit_log` для UI «История изменений».
 *
 * Список с пагинацией (limit/offset) и фильтрами по entity/entity_id.
 * Пишут в таблицу только хендлеры CRUD из document-types и provider-settings
 * — здесь только чтение.
 */

const Entity = z.enum([
  'document_type',
  'provider_setting',
  'gateway_connector',
  'gateway_budget',
]);

const AuditRow = z.object({
  id: z.number(),
  at: z.string(),
  actor: z.string(),
  entity: Entity,
  entity_id: z.string(),
  action: z.enum(['create', 'update', 'delete']),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  diff: z.record(z.object({ from: z.unknown(), to: z.unknown() })).nullable(),
});

const ListResponse = z.object({
  items: z.array(AuditRow),
});

const ListQuery = z.object({
  entity: Entity.optional(),
  entity_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  r.get(
    '/audit-log',
    {
      schema: {
        tags: ['audit-log'],
        summary: 'История админ-изменений document_types и provider_settings',
        description:
          'Возвращает записи в порядке at DESC. Поддерживает фильтры entity и entity_id, плюс limit/offset пагинацию. ' +
          'Снимки before/after уже содержат маскированные секреты (provider api_key никогда не записывается в plaintext).',
        security: [{ bearerAuth: [] }],
        querystring: ListQuery,
        response: { 200: ListResponse, 401: ErrorResponse },
      },
    },
    async (req) => {
      const rows = await auditLogRepo.list({
        entity: req.query.entity as AuditEntity | undefined,
        entity_id: req.query.entity_id,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return { items: rows.map((r) => auditLogRepo.toApi(r)) };
    },
  );
}
