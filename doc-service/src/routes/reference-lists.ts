import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuthHook } from '../auth.js';
import { getOrgId, requireOrgAdmin } from '../authz.js';
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
  /** Опционально для super_admin: записать в указанную организацию. */
  organization_id: z.string().uuid().optional(),
});

const PatchTypeBody = z.object({
  label: z.string().min(1).max(200).optional(),
  search_hint: z.string().max(500).nullable().optional(),
  organization_id: z.string().uuid().optional(),
});

const EntryBody = z.object({
  external_id: z.string().max(256).nullable().optional(),
  display_name: z.string().min(1).max(500),
  search_keys: z.array(z.string().min(1).max(256)).min(1),
  data: z.record(z.unknown()).optional(),
  organization_id: z.string().uuid().optional(),
});

const BulkBody = z.object({
  organization_id: z.string().uuid().optional(),
  entries: z.array(
    z.object({
      // bulk-create — external_id опционален; sync — обязателен (валидируется отдельно).
      external_id: z.string().min(1).max(256).nullable().optional(),
      display_name: z.string().min(1).max(500),
      search_keys: z.array(z.string().min(1).max(256)).min(1),
      data: z.record(z.unknown()).optional(),
    }),
  ).min(1),
});

const SyncBody = z.object({
  organization_id: z.string().uuid().optional(),
  entries: z.array(
    z.object({
      external_id: z.string().min(1).max(256),  // sync требует external_id для upsert
      display_name: z.string().min(1).max(500),
      search_keys: z.array(z.string().min(1).max(256)).min(1),
      data: z.record(z.unknown()).optional(),
    }),
  ).min(1),
});

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
  organization_id: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Helpers — резолюция organization_id с явной обработкой super_admin кейса
// ---------------------------------------------------------------------------

/**
 * Резолвит organization_id для read-операции.
 * Возвращает '' если ни в токене, ни в query — caller сам решит как реагировать
 * (например GET /reference-list-types возвращает пустой массив).
 */
function resolveOrgIdForRead(
  req: FastifyRequest & { query?: { organization_id?: string } },
): string {
  return getOrgId(req) || req.query?.organization_id || '';
}

/**
 * Резолвит organization_id для write-операции. Super_admin (без org в токене)
 * ОБЯЗАН явно указать organization_id в body / query — иначе 400.
 * Возвращает null если orgId не разрешён (caller должен прервать обработку,
 * reply уже отправлен).
 */
async function resolveOrgIdForWrite(
  req: FastifyRequest,
  reply: FastifyReply,
  bodyOrgId: string | undefined,
  queryOrgId?: string,
): Promise<string | null> {
  const tokenOrg = getOrgId(req);
  const orgId = tokenOrg || bodyOrgId || queryOrgId || '';
  if (!orgId) {
    reply.code(400).send({ error: 'organization_id required (in body or query for super_admin)' });
    return null;
  }
  // org_admin / writers разрешены только в свою орг; super_admin — везде.
  if (!requireOrgAdmin(req, reply, orgId)) return null;
  return orgId;
}

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
      const orgId = resolveOrgIdForRead(req);
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
        description: 'Требует org_admin/super_admin. super_admin должен передать organization_id в body.',
        security: [{ bearerAuth: [] }],
        body: CreateTypeBody,
        response: { 201: z.record(z.unknown()), 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      const orgId = await resolveOrgIdForWrite(req, reply, req.body.organization_id);
      if (!orgId) return reply;
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
        response: { 200: z.record(z.unknown()), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const orgId = await resolveOrgIdForWrite(req, reply, req.body.organization_id);
      if (!orgId) return reply;
      const updated = await listTypesRepo.update(req.params.slug, orgId, {
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
        querystring: OrgQuery,
        response: { 204: z.null(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const orgId = await resolveOrgIdForWrite(req, reply, undefined, req.query.organization_id);
      if (!orgId) return reply;
      const ok = await listTypesRepo.delete(req.params.slug, orgId);
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
      const orgId = resolveOrgIdForRead(req);
      if (!orgId) { reply.code(404); return { error: 'list type not found' }; }
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
        response: { 201: z.record(z.unknown()), 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const orgId = await resolveOrgIdForWrite(req, reply, req.body.organization_id);
      if (!orgId) return reply;
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
        summary: 'Bulk-создание записей (без дедупликации, транзакция all-or-nothing)',
        description:
          'Создаёт записи в одной транзакции. Если хотя бы одна упадёт — откатываем все. ' +
          'Для полной push-синхронизации с внешней системой используйте `/sync`.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: BulkBody,
        response: {
          201: z.object({ created: z.number() }),
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const orgId = await resolveOrgIdForWrite(req, reply, req.body.organization_id);
      if (!orgId) return reply;
      const typeExists = await listTypesRepo.findBySlug(req.params.slug, orgId);
      if (!typeExists) { reply.code(404); return { error: 'list type not found' }; }
      const created = await listEntriesRepo.bulkCreate({
        listTypeSlug: req.params.slug,
        organizationId: orgId,
        entries: req.body.entries,
      });
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
          'Транзакция all-or-nothing. Вызывается WMS/ERP при изменении своего списка.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: SyncBody,
        response: {
          200: z.object({ upserted: z.number(), deactivated: z.number() }),
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const orgId = await resolveOrgIdForWrite(req, reply, req.body.organization_id);
      if (!orgId) return reply;
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
        response: { 200: z.record(z.unknown()), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const orgId = await resolveOrgIdForWrite(req, reply, req.body.organization_id);
      if (!orgId) return reply;
      const updated = await listEntriesRepo.update(req.params.id, orgId, req.body);
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
        querystring: OrgQuery,
        response: { 204: z.null(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const orgId = await resolveOrgIdForWrite(req, reply, undefined, req.query.organization_id);
      if (!orgId) return reply;
      const ok = await listEntriesRepo.deactivate(req.params.id, orgId);
      if (!ok) { reply.code(404); return { error: 'entry not found' }; }
      reply.code(204);
      return null;
    },
  );
}
