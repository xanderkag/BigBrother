import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuthHook } from '../auth.js';
import { getOrgId, getUserId, requireProjectAccess, requireProjectWrite } from '../authz.js';
import { jobsRepo } from '../storage/jobs.js';
import { listEntriesRepo, resolutionResultsRepo } from '../resolution/list-repo.js';
import { runResolutionPipeline } from '../resolution/pipeline.js';
import { documentTypeResolver } from '../pipeline/document-type-resolver.js';
import { ErrorResponse } from '../types/api-schemas.js';
import type { EntityLinkApi, ItemMatchApi } from '../resolution/types.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const JobIdParam = z.object({ id: z.string().uuid() });
const LinkIdParam = z.object({ id: z.string().uuid() });
const MatchIdParam = z.object({ id: z.string().uuid() });

/**
 * Тело подтверждения: оператор может переопределить entry_id если
 * автоматический матч указал на неправильную запись справочника.
 */
const ConfirmBody = z.object({
  entry_id: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Shared action helpers — DRY для confirm/reject
// ---------------------------------------------------------------------------

/**
 * Выполнить confirm / reject для entity link.
 * Загружает link → находит job → проверяет write-доступ → обновляет статус.
 */
async function entityLinkAction(
  id: string,
  status: 'confirmed' | 'rejected',
  req: Parameters<typeof requireProjectWrite>[0],
  reply: Parameters<typeof requireProjectWrite>[1],
  entryId?: string,
): Promise<ReturnType<typeof resolutionResultsRepo.entityLinkToApi> | { error: string } | typeof reply> {
  const rawLink = await resolutionResultsRepo.findEntityLinkById(id);
  if (!rawLink) { reply.code(404); return { error: 'entity link not found' }; }

  const job = await jobsRepo.findById(rawLink.job_id);
  if (!job || !(await requireProjectWrite(req, reply, job.project_id))) return reply;

  const updated = await resolutionResultsRepo.updateEntityLinkStatus(
    id, job.organization_id, status, getUserId(req), entryId,
  );
  if (!updated) { reply.code(404); return { error: 'entity link not found' }; }
  return resolutionResultsRepo.entityLinkToApi(updated);
}

/**
 * Выполнить confirm / reject для item match.
 */
async function itemMatchAction(
  id: string,
  status: 'confirmed' | 'rejected',
  req: Parameters<typeof requireProjectWrite>[0],
  reply: Parameters<typeof requireProjectWrite>[1],
  entryId?: string,
): Promise<ReturnType<typeof resolutionResultsRepo.itemMatchToApi> | { error: string } | typeof reply> {
  const rawMatch = await resolutionResultsRepo.findItemMatchById(id);
  if (!rawMatch) { reply.code(404); return { error: 'item match not found' }; }

  const job = await jobsRepo.findById(rawMatch.job_id);
  if (!job || !(await requireProjectWrite(req, reply, job.project_id))) return reply;

  const updated = await resolutionResultsRepo.updateItemMatchStatus(
    id, job.organization_id, status, getUserId(req), entryId,
  );
  if (!updated) { reply.code(404); return { error: 'item match not found' }; }
  return resolutionResultsRepo.itemMatchToApi(updated);
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function resolutionRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('onRequest', bearerAuthHook);

  // ── GET /jobs/:id/resolution ──────────────────────────────────────────────
  //
  // Возвращает entity_links + item_matches + сводку по job.
  // Включает детали привязанных записей справочника (eager join по entry_id).

  r.get(
    '/jobs/:id/resolution',
    {
      schema: {
        tags: ['resolution'],
        summary: 'Результаты резолюции (привязки) документа',
        description:
          'Возвращает entity_links и item_matches с вложенными данными привязанных ' +
          'записей справочника, а также сводку (summary) по числу найденных/подтверждённых.',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
        response: {
          200: z.object({
            entity_links: z.array(z.record(z.unknown())),
            item_matches: z.array(z.record(z.unknown())),
            summary: z.object({
              links_total: z.number(),
              links_confirmed: z.number(),
              links_not_found: z.number(),
              items_total: z.number(),
              items_matched: z.number(),
              items_not_found: z.number(),
            }),
          }),
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const job = await jobsRepo.findById(req.params.id);
      if (!job) { reply.code(404); return { error: 'job not found' }; }
      if (!(await requireProjectAccess(req, reply, job.project_id))) return reply;

      const [linkRows, matchRows] = await Promise.all([
        resolutionResultsRepo.listEntityLinks(req.params.id),
        resolutionResultsRepo.listItemMatches(req.params.id),
      ]);

      // Eagerly join entry details for all non-null entry_ids (one query per entry,
      // но на практике их мало — единицы на документ, не тысячи)
      const allEntryIds = [
        ...new Set([
          ...linkRows.filter((l) => l.entry_id).map((l) => l.entry_id!),
          ...matchRows.filter((m) => m.entry_id).map((m) => m.entry_id!),
        ]),
      ];

      const entryMap = new Map<string, ReturnType<typeof listEntriesRepo.toApi>>();
      await Promise.all(
        allEntryIds.map(async (eid) => {
          const entry = await listEntriesRepo.findById(eid);
          if (entry) entryMap.set(eid, listEntriesRepo.toApi(entry));
        }),
      );

      const entity_links: EntityLinkApi[] = linkRows.map((l) =>
        resolutionResultsRepo.entityLinkToApi(
          l,
          l.entry_id ? (entryMap.get(l.entry_id) ?? null) : null,
        ),
      );

      const item_matches: ItemMatchApi[] = matchRows.map((m) =>
        resolutionResultsRepo.itemMatchToApi(
          m,
          m.entry_id ? (entryMap.get(m.entry_id) ?? null) : null,
        ),
      );

      const summary = {
        links_total: entity_links.length,
        links_confirmed: entity_links.filter((l) => l.status === 'confirmed').length,
        links_not_found: entity_links.filter((l) => l.status === 'not_found').length,
        items_total: item_matches.length,
        items_matched: item_matches.filter((m) => m.status !== 'not_found').length,
        items_not_found: item_matches.filter((m) => m.status === 'not_found').length,
      };

      return { entity_links, item_matches, summary };
    },
  );

  // ── POST /jobs/:id/re-resolve ─────────────────────────────────────────────
  //
  // Сбрасывает старые результаты и перезапускает пайплайн резолюции.
  // Требует write-доступ. Работает только если у типа документа настроен
  // resolution_config. Отвечает 202 — результат смотреть через GET /resolution.

  r.post(
    '/jobs/:id/re-resolve',
    {
      schema: {
        tags: ['resolution'],
        summary: 'Повторный прогон резолюции для документа',
        description:
          'Удаляет предыдущие результаты (entity_links, item_matches) и запускает ' +
          'пайплайн резолюции заново с актуальным extracted. Используйте когда обновился ' +
          'справочник или изменилась конфигурация resolution_config типа документа.',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
        response: {
          202: z.object({ message: z.string() }),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const job = await jobsRepo.findById(req.params.id);
      if (!job) { reply.code(404); return { error: 'job not found' }; }
      if (!(await requireProjectWrite(req, reply, job.project_id))) return reply;

      if (job.status === 'pending' || job.status === 'processing') {
        reply.code(409);
        return { error: `cannot re-resolve job in status "${job.status}"` };
      }
      if (!job.document_type) {
        reply.code(400);
        return { error: 'job has no document_type assigned' };
      }

      const typeConfig = await documentTypeResolver.resolveConfig(
        job.document_type as Parameters<typeof documentTypeResolver.resolveConfig>[0],
      );
      if (!typeConfig.resolutionConfig) {
        reply.code(400);
        return { error: `document type "${job.document_type}" has no resolution_config configured` };
      }

      void runResolutionPipeline({
        jobId: req.params.id,
        organizationId: job.organization_id,
        extracted: (job.extracted ?? {}) as Record<string, unknown>,
        resolutionConfig: typeConfig.resolutionConfig,
        log: req.log as Parameters<typeof runResolutionPipeline>[0]['log'],
      }).catch((err: unknown) => {
        req.log.warn({ jobId: req.params.id, err }, 're-resolve pipeline error');
      });

      reply.code(202);
      return { message: 're-resolve started' };
    },
  );

  // ── Entity link confirm / reject ──────────────────────────────────────────

  r.post(
    '/job-entity-links/:id/confirm',
    {
      schema: {
        tags: ['resolution'],
        summary: 'Подтвердить привязку к сущности',
        description: 'Оператор может передать `entry_id` чтобы переопределить автоматически найденную запись.',
        security: [{ bearerAuth: [] }],
        params: LinkIdParam,
        body: ConfirmBody,
        response: { 200: z.record(z.unknown()), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => entityLinkAction(req.params.id, 'confirmed', req, reply, req.body.entry_id),
  );

  r.post(
    '/job-entity-links/:id/reject',
    {
      schema: {
        tags: ['resolution'],
        summary: 'Отклонить привязку к сущности',
        security: [{ bearerAuth: [] }],
        params: LinkIdParam,
        response: { 200: z.record(z.unknown()), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => entityLinkAction(req.params.id, 'rejected', req, reply),
  );

  // ── Item match confirm / reject ───────────────────────────────────────────

  r.post(
    '/job-item-matches/:id/confirm',
    {
      schema: {
        tags: ['resolution'],
        summary: 'Подтвердить матч строки документа',
        description: 'Оператор может передать `entry_id` чтобы переопределить автоматически найденную запись.',
        security: [{ bearerAuth: [] }],
        params: MatchIdParam,
        body: ConfirmBody,
        response: { 200: z.record(z.unknown()), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => itemMatchAction(req.params.id, 'confirmed', req, reply, req.body.entry_id),
  );

  r.post(
    '/job-item-matches/:id/reject',
    {
      schema: {
        tags: ['resolution'],
        summary: 'Отклонить матч строки документа',
        security: [{ bearerAuth: [] }],
        params: MatchIdParam,
        response: { 200: z.record(z.unknown()), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => itemMatchAction(req.params.id, 'rejected', req, reply),
  );
}
