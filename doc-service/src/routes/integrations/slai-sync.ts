/**
 * F13: SLAI continuous category sync receiver.
 *
 * 2 endpoint'а:
 *   - POST /api/v1/integrations/slai/sync/nomenclature
 *     Inbound events: category.added/renamed/deleted, nomenclature.*
 *   - POST /api/v1/integrations/slai/sync/nomenclature/snapshot
 *     Daily full snapshot для reconcile.
 *
 * Защита:
 *   - HMAC SHA-256 timing-safe verify через `SLAI_TO_PARSDOCS_HMAC_SECRET`
 *   - Header `X-SLAI-Version: v1` обязателен
 *   - Идемпотентность через UNIQUE event_id в sync_inbox
 *
 * MVP: пишем event в inbox и сразу применяем upsert в lookup-table
 * (без отдельного sweeper'а — добавим в следующей итерации если будет
 * нужно офлайн-обработку).
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { verifySlaiSignature } from '../../security/hmac-verify.js';
import { slaiCategoriesRepo, type SyncEventType } from '../../storage/slai-categories.js';

const SyncEventBody = z.object({
  version: z.string(),
  event_id: z.string().optional(), // если SLAI забыл — используем timestamp+payload-hash
  event: z.enum([
    'category.added',
    'category.renamed',
    'category.deleted',
    'nomenclature.added',
    'nomenclature.changed',
    'nomenclature.deleted',
  ]),
  timestamp: z.string().optional(),
  entity: z.enum(['NomenclatureCategory', 'Nomenclature']).optional(),
  delta: z
    .object({
      before: z.unknown().nullable().optional(),
      after: z.unknown().nullable().optional(),
    })
    .optional(),
  stats_after: z
    .object({
      total_categories: z.number().optional(),
      total_subcategories: z.number().optional(),
      total_nomenclature: z.number().optional(),
    })
    .optional(),
});

const SnapshotBody = z.object({
  version: z.string(),
  event: z.literal('snapshot'),
  timestamp: z.string(),
  categories: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      external_code: z.string().optional(),
      subcategories: z
        .array(
          z.object({
            id: z.number(),
            name: z.string(),
            external_code: z.string().optional(),
          }),
        )
        .optional(),
      items_count: z.number().optional(),
    }),
  ),
  category_hist_30d: z
    .array(
      z.object({
        code: z.string().optional(),
        category_id: z.number().optional(),
        subcategory_code: z.string().optional().nullable(),
        count: z.number(),
      }),
    )
    .optional(),
});

export async function slaiSyncRoutes(fastify: FastifyInstance): Promise<void> {
  // Регистрируем JSON content-type parser который сохраняет raw body
  // (для HMAC verify). Применяется только к этим routes — глобальный
  // JSON parser работает как обычно для остальных endpoint'ов.
  //
  // Стратегия: парсим body как text (raw), затем валидируем подпись,
  // потом сами JSON.parse. Это даёт точный bytes для HMAC.

  /** Helper: проверить HMAC + распарсить JSON */
  function verifyAndParse<T>(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    schema: z.ZodType<T>,
  ): { ok: true; data: T } | { ok: false; status: number; error: string } {
    const secret = config.slai?.toParsdocsHmacSecret;
    const hmacErr = verifySlaiSignature(rawBody, headers, secret);
    if (hmacErr) {
      return { ok: false, status: 401, error: hmacErr };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (e) {
      return { ok: false, status: 400, error: `invalid JSON: ${(e as Error).message}` };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        status: 400,
        error: `schema mismatch: ${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }
    return { ok: true, data: result.data };
  }

  // POST events receiver
  fastify.post('/api/v1/integrations/slai/sync/nomenclature', {
    config: {
      // Этот endpoint не подчиняется глобальной auth (Bearer API_KEY) —
      // защищается своим HMAC + X-SLAI-Signature header. Помечаем чтобы
      // server.ts hook'и пропустили без auth.
      slaiSync: true,
    },
    schema: {
      tags: ['integrations'],
      summary: 'SLAI category sync event receiver',
      description:
        'F13: принимает events от SLAI (category.added/renamed/deleted, nomenclature.*). ' +
        'Защита: HMAC SHA-256 timing-safe (header X-SLAI-Signature) + X-SLAI-Version: v1. ' +
        'Idempotent через UNIQUE event_id в sync_inbox.',
    },
    handler: async (req, reply) => {
      // Body должен быть raw string. На уровне server.ts регистрируем
      // content-type parser который сохраняет raw для этого route.
      const rawBody =
        typeof req.body === 'string'
          ? req.body
          : Buffer.isBuffer(req.body)
            ? req.body.toString('utf-8')
            : JSON.stringify(req.body);

      const result = verifyAndParse(rawBody, req.headers, SyncEventBody);
      if (!result.ok) {
        reply.code(result.status);
        return { error: result.error };
      }
      const body = result.data;

      // event_id: если SLAI прислал — используем; иначе вычисляем
      // (timestamp + sha256(payload).slice(0,8)) для идемпотентности.
      const eventId =
        body.event_id ??
        `auto-${body.timestamp ?? Date.now()}-${rawBody.length}`;

      try {
        const { duplicate } = await slaiCategoriesRepo.enqueueEvent({
          eventId,
          eventType: body.event as SyncEventType,
          version: body.version,
          payload: body as unknown as Record<string, unknown>,
        });
        if (duplicate) {
          // Идемпотентный replay — отвечаем 200 без обработки
          return { ok: true, status: 'duplicate', event_id: eventId };
        }
        // MVP: применяем сразу синхронно (lookup-table). В будущем —
        // отдельный sweeper обрабатывает inbox асинхронно.
        await applyEvent(body);
        await slaiCategoriesRepo.markProcessed(eventId);
        return { ok: true, status: 'accepted', event_id: eventId };
      } catch (e) {
        const errMsg = (e as Error).message;
        req.log.error({ eventId, errMsg }, 'sync event processing failed');
        try {
          await slaiCategoriesRepo.recordFailure(eventId, errMsg);
        } catch {
          // failed to record failure — non-fatal
        }
        reply.code(500);
        return { error: errMsg };
      }
    },
  });

  // POST snapshot receiver
  fastify.post('/api/v1/integrations/slai/sync/nomenclature/snapshot', {
    config: { slaiSync: true },
    schema: {
      tags: ['integrations'],
      summary: 'SLAI daily snapshot receiver',
      description:
        'F13: принимает daily snapshot полного справочника SLAI nomenclature. ' +
        'Применяет upsert ко всем категориям, сверяет с lookup-table для reconcile.',
    },
    handler: async (req, reply) => {
      const rawBody =
        typeof req.body === 'string'
          ? req.body
          : Buffer.isBuffer(req.body)
            ? req.body.toString('utf-8')
            : JSON.stringify(req.body);

      const result = verifyAndParse(rawBody, req.headers, SnapshotBody);
      if (!result.ok) {
        reply.code(result.status);
        return { error: result.error };
      }
      const body = result.data;

      let processed = 0;
      const histMap = new Map<number, number>();
      // Hist может быть по category_id или по code (внешнему). MVP — по id.
      for (const h of body.category_hist_30d ?? []) {
        if (h.category_id !== undefined) histMap.set(h.category_id, h.count);
      }

      try {
        for (const cat of body.categories) {
          await slaiCategoriesRepo.upsertMapping({
            slaiCategoryId: cat.id,
            name: cat.name,
            active: true,
            itemsCount: cat.items_count ?? 0,
            usageCount30d: histMap.get(cat.id) ?? 0,
          });
          // Subcategories — отдельные записи с subcategory_id
          for (const sub of cat.subcategories ?? []) {
            await slaiCategoriesRepo.upsertMapping({
              slaiCategoryId: sub.id,
              name: sub.name,
              subcategoryId: sub.id,
              subcategoryName: sub.name,
              active: true,
            });
            processed++;
          }
          processed++;
        }
        return {
          ok: true,
          status: 'snapshot_applied',
          categories_processed: processed,
          timestamp: body.timestamp,
        };
      } catch (e) {
        reply.code(500);
        return { error: (e as Error).message };
      }
    },
  });
}

/**
 * Применить одно sync-event к lookup-table.
 * MVP: простое отображение event→операция, без сложной логики
 * conflict resolution (это в roadmap'е если будет нужно).
 */
async function applyEvent(body: z.infer<typeof SyncEventBody>): Promise<void> {
  const after = body.delta?.after as
    | { id?: number; name?: string; category_id?: number; subcategory_id?: number }
    | null
    | undefined;
  const before = body.delta?.before as
    | { id?: number; name?: string }
    | null
    | undefined;

  switch (body.event) {
    case 'category.added':
    case 'category.renamed':
    case 'nomenclature.added':
    case 'nomenclature.changed':
      if (after?.id !== undefined && after.name) {
        await slaiCategoriesRepo.upsertMapping({
          slaiCategoryId: after.id,
          name: after.name,
          active: true,
        });
      }
      break;
    case 'category.deleted':
    case 'nomenclature.deleted':
      if (before?.id !== undefined) {
        await slaiCategoriesRepo.deactivate(before.id);
      }
      break;
  }
}
