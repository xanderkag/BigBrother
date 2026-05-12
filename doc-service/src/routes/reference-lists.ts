import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuthHook } from '../auth.js';
import { getOrgId } from '../authz.js';
import { listTypesRepo, listEntriesRepo } from '../resolution/list-repo.js';
import { ErrorResponse } from '../types/api-schemas.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SlugParam = z.object({ slug: z.string().min(1).max(64) });
const EntryIdParam = z.object({ id: z.string().uuid() });

const OrgQuery = z.object({
  organization_id: z.string().uuid().optional(),
});

const CreateTypeBody = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(200),
  search_hint: z.string().max(500).nullable().optional(),
});

const PatchTypeBody = z.object({
  label: z.string().min(1).max(200).optional(),
  search_hint: z.string().max(500).nullable().optional(),
});

const EntryBody = z.object({
  external_id: z.string().max(256).nullable().optional(),
  display_name: z.string().min(1).max(500),
  search_keys: z.array(z.string().min(1).max(256)).min(1),
  data: z.record(z.unknown()).optional(),
});

const BulkBody = z.object({
  entries: z.array(
    z.object({
      external_id: z.string().min(1).max(256),
      display_name: z.string().min(1).max(500),
      search_keys: z.array(z.string().min(1).max(256)).min(1),
      data: z.record(z.unknown()).optional(),
    }),
  ).min(1),
});

const SyncBody = BulkBody; // же структура, другая семантика (upsert + deactivate)

const ListEntriesQuery = z.object({
  q: z.string().optional(),
  active_only: z.coerce.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  organization_id: z.string().uuid().optional(),
});

const PatchEntryBody = z.object({
  display_name: z.string().min(1).max(500).optional(),
  search_keys: z.array(z.string().min(1).max(256)).min(1).optional(),
  data: z.record(z.unknown()).optional(),
  is_active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function referenceListsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('onRequest', bearerAuthHook);

  // ── Types CRUD ────────────────────────────────────────────────────────────

  r.get(
    '/reference-list-types',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Список типов справочников',
        description:
          'Возвращает типы справочников текущей организации (из токена). ' +
          'Query-параметр `organization_id` используется только для super_admin.',
        security: [{ bearerAuth: [] }],
        querystring: OrgQuery,
        response: { 200: z.array(z.record(z.unknown())), 401: ErrorResponse },
      },
    },
    async (req) => {
      // Токен → orgId, fallback на query-параметр (только для super_admin)
      const orgId = getOrgId(req) || req.query.organization_id || '';
      if (!orgId) return [];
      const rows = await listTypesRepo.list(orgId);
      return rows.map((row) => listTypesRepo.toApi(row));
    },
  );

  r.post(
    '/reference-list-types',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Создать тип справочника',
        security: [{ bearerAuth: [] }],
        body: CreateTypeBody,
        response: { 201: z.record(z.unknown()), 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const orgId = getOrgId(req);
      if (!orgId) { reply.code(401); return { error: 'organization_id required' }; }
      const existing = await listTypesRepo.findBySlug(req.body.slug, orgId);
      if (existing) { reply.code(400); return { error: `slug '${req.body.slug}' already exists` }; }
      const row = await listTypesRepo.create({
        slug: req.body.slug,
        organizationId: orgId,
        label: req.body.label,
        searchHint: req.body.search_hint,
      });
      reply.code(201);
      return listTypesRepo.toApi(row);
    },
  );

  r.patch(
    '/reference-list-types/:slug',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Обновить тип справочника',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: PatchTypeBody,
        response: { 200: z.record(z.unknown()), 404: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const updated = await listTypesRepo.update(req.params.slug, getOrgId(req), {
        label: req.body.label,
        searchHint: req.body.search_hint,
      });
      if (!updated) { reply.code(404); return { error: 'list type not found' }; }
      return listTypesRepo.toApi(updated);
    },
  );

  r.delete(
    '/reference-list-types/:slug',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Удалить тип справочника (вместе со всеми записями)',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        response: { 204: z.null(), 404: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const ok = await listTypesRepo.delete(req.params.slug, getOrgId(req));
      if (!ok) { reply.code(404); return { error: 'list type not found' }; }
      reply.code(204);
      return null;
    },
  );

  // ── Entries CRUD ───────────────────────────────────────────────────────────

  r.get(
    '/reference-list-types/:slug/entries',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Записи справочника с поиском',
        description:
          'Поиск по `q`: точное совпадение в `search_keys[]` или подстрока в `display_name`. ' +
          'GIN-индекс на `search_keys` обеспечивает O(1) на типичных объёмах.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        querystring: ListEntriesQuery,
        response: {
          200: z.object({
            items: z.array(z.record(z.unknown())),
            limit: z.number(),
            offset: z.number(),
          }),
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const orgId = getOrgId(req) || req.query.organization_id || '';
      const typeExists = await listTypesRepo.findBySlug(req.params.slug, orgId);
      if (!typeExists) { reply.code(404); return { error: 'list type not found' }; }
      const rows = await listEntriesRepo.list({
        listTypeSlug: req.params.slug,
        organizationId: orgId,
        search: req.query.q,
        activeOnly: req.query.active_only,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return {
        items: rows.map((row) => listEntriesRepo.toApi(row)),
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );

  r.post(
    '/reference-list-types/:slug/entries',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Добавить запись в справочник',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: EntryBody,
        response: { 201: z.record(z.unknown()), 400: ErrorResponse, 404: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const orgId = getOrgId(req);
      const typeExists = await listTypesRepo.findBySlug(req.params.slug, orgId);
      if (!typeExists) { reply.code(404); return { error: 'list type not found' }; }
      const row = await listEntriesRepo.create({
        listTypeSlug: req.params.slug,
        organizationId: orgId,
        input: {
          external_id: req.body.external_id,
          display_name: req.body.display_name,
          search_keys: req.body.search_keys,
          data: req.body.data,
        },
      });
      reply.code(201);
      return listEntriesRepo.toApi(row);
    },
  );

  r.post(
    '/reference-list-types/:slug/entries/bulk',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Bulk-создание записей (без дедупликации)',
        description: 'Создаёт записи в цикле без проверки дублей. Для полной синхронизации с внешней системой используйте `/sync`.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: BulkBody,
        response: {
          201: z.object({ created: z.number() }),
          404: ErrorResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const orgId = getOrgId(req);
      const typeExists = await listTypesRepo.findBySlug(req.params.slug, orgId);
      if (!typeExists) { reply.code(404); return { error: 'list type not found' }; }
      let created = 0;
      for (const entry of req.body.entries) {
        await listEntriesRepo.create({ listTypeSlug: req.params.slug, organizationId: orgId, input: entry });
        created++;
      }
      reply.code(201);
      return { created };
    },
  );

  r.post(
    '/reference-list-types/:slug/sync',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Push-синхронизация от внешней системы (upsert + деактивация удалённых)',
        description:
          'Принимает полный список актуальных записей. Записи с совпадающим `external_id` ' +
          'обновляются. Новые — создаются. Записи которых нет в теле — деактивируются (soft-delete). ' +
          'Вызывается WMS/ERP при изменении своего списка.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: SyncBody,
        response: {
          200: z.object({ upserted: z.number(), deactivated: z.number() }),
          404: ErrorResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const orgId = getOrgId(req);
      const typeExists = await listTypesRepo.findBySlug(req.params.slug, orgId);
      if (!typeExists) { reply.code(404); return { error: 'list type not found' }; }
      return listEntriesRepo.bulkSync({
        listTypeSlug: req.params.slug,
        organizationId: orgId,
        entries: req.body.entries,
      });
    },
  );

  r.patch(
    '/reference-list-entries/:id',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Обновить запись справочника',
        security: [{ bearerAuth: [] }],
        params: EntryIdParam,
        body: PatchEntryBody,
        response: { 200: z.record(z.unknown()), 404: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const updated = await listEntriesRepo.update(req.params.id, getOrgId(req), req.body);
      if (!updated) { reply.code(404); return { error: 'entry not found' }; }
      return listEntriesRepo.toApi(updated);
    },
  );

  r.delete(
    '/reference-list-entries/:id',
    {
      schema: {
        tags: ['reference-lists'],
        summary: 'Деактивировать запись справочника (soft-delete)',
        security: [{ bearerAuth: [] }],
        params: EntryIdParam,
        response: { 204: z.null(), 404: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const ok = await listEntriesRepo.deactivate(req.params.id, getOrgId(req));
      if (!ok) { reply.code(404); return { error: 'entry not found' }; }
      reply.code(204);
      return null;
    },
  );
}
