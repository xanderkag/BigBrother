/**
 * F13: storage layer для SLAI category sync.
 *
 * Реализует две вещи:
 * 1. `sync_inbox` — write-only buffer для входящих events.
 *    UNIQUE constraint на `event_id` даёт идемпотентность повторных
 *    доставок (см. PARSDOCS_CATEGORY_SYNC_REPLY.md ответ 7).
 * 2. `slai_category_map` — текущий снимок lookup-table. Обновляется
 *    background sweeper'ом (или snapshot reconciler'ом).
 *
 * MVP: Redis cache опущен — все обращения напрямую в Postgres.
 * Если на пилоте увидим latency проблемы — добавим in-process кеш
 * (TTL 5 мин) либо Redis.
 */
import { db } from '../db.js';

export type SyncEventType =
  | 'category.added'
  | 'category.renamed'
  | 'category.deleted'
  | 'nomenclature.added'
  | 'nomenclature.changed'
  | 'nomenclature.deleted'
  | 'snapshot';

export interface SyncInboxRow {
  event_id: string;
  event_type: SyncEventType;
  version: string;
  payload: Record<string, unknown>;
  received_at: Date;
  processed_at: Date | null;
  last_error: string | null;
  attempts: number;
}

export interface SlaiCategoryMapRow {
  slai_category_id: number;
  name: string;
  our_hint: string | null;
  subcategory_id: number | null;
  subcategory_name: string | null;
  active: boolean;
  usage_count_30d: number;
  items_count: number;
  created_at: Date;
  updated_at: Date;
}

export const slaiCategoriesRepo = {
  /**
   * Принять event в inbox. Идемпотентно через ON CONFLICT (event_id).
   * Возвращает true если запись новая, false если дубль (уже в inbox).
   */
  async enqueueEvent(input: {
    eventId: string;
    eventType: SyncEventType;
    version: string;
    payload: Record<string, unknown>;
  }): Promise<{ accepted: boolean; duplicate: boolean }> {
    const res = await db.query(
      `INSERT INTO sync_inbox (event_id, event_type, version, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [input.eventId, input.eventType, input.version, JSON.stringify(input.payload)],
    );
    return {
      accepted: true,
      duplicate: (res.rowCount ?? 0) === 0,
    };
  },

  /**
   * Прочитать pending-events для sweeper'а. Сортировка по received_at
   * (FIFO). Если sweeper не успеет за N attempts — событие остаётся в
   * inbox для manual recovery (см. SyncFailedQueue в SLAI ТЗ).
   */
  async listPending(limit = 50): Promise<SyncInboxRow[]> {
    const res = await db.query(
      `SELECT event_id, event_type, version, payload, received_at,
              processed_at, last_error, attempts
         FROM sync_inbox
        WHERE processed_at IS NULL
          AND attempts < 10
        ORDER BY received_at ASC
        LIMIT $1`,
      [limit],
    );
    return res.rows as SyncInboxRow[];
  },

  /** Mark event обработанным (sweeper'ом). */
  async markProcessed(eventId: string): Promise<void> {
    await db.query(
      `UPDATE sync_inbox
          SET processed_at = now(),
              last_error = NULL
        WHERE event_id = $1`,
      [eventId],
    );
  },

  /** Записать ошибку обработки + увеличить attempts. */
  async recordFailure(eventId: string, error: string): Promise<void> {
    await db.query(
      `UPDATE sync_inbox
          SET attempts = attempts + 1,
              last_error = $2
        WHERE event_id = $1`,
      [eventId, error.slice(0, 500)],
    );
  },

  /** Upsert mapping (используется sweeper'ом + snapshot reconciler'ом). */
  async upsertMapping(input: {
    slaiCategoryId: number;
    name: string;
    ourHint?: string | null;
    subcategoryId?: number | null;
    subcategoryName?: string | null;
    active?: boolean;
    usageCount30d?: number;
    itemsCount?: number;
  }): Promise<void> {
    await db.query(
      `INSERT INTO slai_category_map (
          slai_category_id, name, our_hint, subcategory_id, subcategory_name,
          active, usage_count_30d, items_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slai_category_id) DO UPDATE SET
          name = EXCLUDED.name,
          our_hint = COALESCE(EXCLUDED.our_hint, slai_category_map.our_hint),
          subcategory_id = EXCLUDED.subcategory_id,
          subcategory_name = EXCLUDED.subcategory_name,
          active = EXCLUDED.active,
          usage_count_30d = EXCLUDED.usage_count_30d,
          items_count = EXCLUDED.items_count`,
      [
        input.slaiCategoryId,
        input.name,
        input.ourHint ?? null,
        input.subcategoryId ?? null,
        input.subcategoryName ?? null,
        input.active ?? true,
        input.usageCount30d ?? 0,
        input.itemsCount ?? 0,
      ],
    );
  },

  /** Найти mapping по SLAI category_id. */
  async findById(slaiCategoryId: number): Promise<SlaiCategoryMapRow | null> {
    const res = await db.query(
      `SELECT * FROM slai_category_map WHERE slai_category_id = $1`,
      [slaiCategoryId],
    );
    return (res.rows[0] as SlaiCategoryMapRow | undefined) ?? null;
  },

  /** Найти mapping по имени категории (case-insensitive fuzzy). */
  async findByName(name: string): Promise<SlaiCategoryMapRow | null> {
    const res = await db.query(
      `SELECT * FROM slai_category_map
        WHERE LOWER(name) = LOWER($1)
          AND active = true
        LIMIT 1`,
      [name],
    );
    return (res.rows[0] as SlaiCategoryMapRow | undefined) ?? null;
  },

  /** Soft-delete (по `category.deleted` event). */
  async deactivate(slaiCategoryId: number): Promise<void> {
    await db.query(
      `UPDATE slai_category_map SET active = false WHERE slai_category_id = $1`,
      [slaiCategoryId],
    );
  },

  /** Список всех активных категорий — для debug/snapshot reconcile. */
  async listAllActive(): Promise<SlaiCategoryMapRow[]> {
    const res = await db.query(
      `SELECT * FROM slai_category_map WHERE active = true ORDER BY usage_count_30d DESC`,
    );
    return res.rows as SlaiCategoryMapRow[];
  },

  /**
   * F13 polish: bulk-load `our_hint → slai_category_id` карта. Используется
   * orchestrator'ом для обогащения items[]._slai_category_id после
   * applyCategoryHints. Возвращает только активные категории и только те,
   * у которых operator/sweeper заполнил `our_hint`.
   *
   * Если у нескольких SLAI-категорий тот же our_hint (например 3 подкатегории
   * молочки → все "food") — побеждает первая по usage_count_30d DESC. Это
   * грубое приближение: чаще используемая категория — наиболее вероятный
   * матч. Перфектное решение требует subcategory mapping, отложено.
   */
  async loadHintToIdMap(): Promise<Map<string, number>> {
    const res = await db.query(
      `SELECT DISTINCT ON (our_hint) our_hint, slai_category_id
         FROM slai_category_map
        WHERE active = true AND our_hint IS NOT NULL
        ORDER BY our_hint, usage_count_30d DESC`,
    );
    const map = new Map<string, number>();
    for (const row of res.rows as Array<{ our_hint: string; slai_category_id: number }>) {
      map.set(row.our_hint, row.slai_category_id);
    }
    return map;
  },
};
