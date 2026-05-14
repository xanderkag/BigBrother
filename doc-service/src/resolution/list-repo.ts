import { db, withTransaction } from '../db.js';
import type {
  ReferenceListTypeRow,
  ReferenceListEntryRow,
  JobEntityLinkRow,
  JobItemMatchRow,
  EntryCreateInput,
  SyncEntry,
  ReferenceListTypeApi,
  ReferenceListEntryApi,
  EntityLinkApi,
  ItemMatchApi,
} from './types.js';

// ---------------------------------------------------------------------------
// Reference List Types
// ---------------------------------------------------------------------------

class ReferenceListTypesRepo {
  async list(organizationId: string): Promise<ReferenceListTypeRow[]> {
    const { rows } = await db.query<ReferenceListTypeRow>(
      `SELECT * FROM reference_list_types
       WHERE organization_id = $1
       ORDER BY label`,
      [organizationId],
    );
    return rows;
  }

  async findBySlug(
    slug: string,
    organizationId: string,
  ): Promise<ReferenceListTypeRow | null> {
    const { rows } = await db.query<ReferenceListTypeRow>(
      `SELECT * FROM reference_list_types
       WHERE slug = $1 AND organization_id = $2`,
      [slug, organizationId],
    );
    return rows[0] ?? null;
  }

  async create(params: {
    slug: string;
    organizationId: string;
    label: string;
    searchHint?: string | null;
  }): Promise<ReferenceListTypeRow> {
    const { rows } = await db.query<ReferenceListTypeRow>(
      `INSERT INTO reference_list_types (slug, organization_id, label, search_hint)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [params.slug, params.organizationId, params.label, params.searchHint ?? null],
    );
    return rows[0]!;
  }

  async update(
    slug: string,
    organizationId: string,
    patch: { label?: string; searchHint?: string | null },
  ): Promise<ReferenceListTypeRow | null> {
    const { rows } = await db.query<ReferenceListTypeRow>(
      `UPDATE reference_list_types
       SET label       = COALESCE($3, label),
           search_hint = CASE WHEN $4::boolean THEN $5 ELSE search_hint END,
           updated_at  = now()
       WHERE slug = $1 AND organization_id = $2
       RETURNING *`,
      [
        slug,
        organizationId,
        patch.label ?? null,
        patch.searchHint !== undefined,
        patch.searchHint ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  async delete(slug: string, organizationId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `DELETE FROM reference_list_types
       WHERE slug = $1 AND organization_id = $2`,
      [slug, organizationId],
    );
    return (rowCount ?? 0) > 0;
  }

  toApi(row: ReferenceListTypeRow): ReferenceListTypeApi {
    return {
      slug: row.slug,
      organization_id: row.organization_id,
      label: row.label,
      search_hint: row.search_hint,
      created_at: row.created_at.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Reference List Entries
// ---------------------------------------------------------------------------

class ReferenceListEntriesRepo {
  async list(params: {
    listTypeSlug: string;
    organizationId: string;
    search?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<ReferenceListEntryRow[]> {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const activeOnly = params.activeOnly ?? true;

    if (params.search) {
      // Поиск по search_keys (точный) или display_name (prefix/trigram в v2)
      const { rows } = await db.query<ReferenceListEntryRow>(
        `SELECT * FROM reference_list_entries
         WHERE list_type_slug = $1
           AND organization_id = $2
           AND ($3 OR is_active)
           AND (search_keys @> ARRAY[$4]
                OR display_name ILIKE $5)
         ORDER BY display_name
         LIMIT $6 OFFSET $7`,
        [
          params.listTypeSlug,
          params.organizationId,
          !activeOnly,
          params.search,
          `%${params.search}%`,
          limit,
          offset,
        ],
      );
      return rows;
    }

    const { rows } = await db.query<ReferenceListEntryRow>(
      `SELECT * FROM reference_list_entries
       WHERE list_type_slug = $1
         AND organization_id = $2
         AND ($3 OR is_active)
       ORDER BY display_name
       LIMIT $4 OFFSET $5`,
      [params.listTypeSlug, params.organizationId, !activeOnly, limit, offset],
    );
    return rows;
  }

  async findById(id: string): Promise<ReferenceListEntryRow | null> {
    const { rows } = await db.query<ReferenceListEntryRow>(
      `SELECT * FROM reference_list_entries WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Batch-поиск по списку id — для eager-join в `GET /resolution`. */
  async findByIds(ids: string[]): Promise<ReferenceListEntryRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query<ReferenceListEntryRow>(
      `SELECT * FROM reference_list_entries WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return rows;
  }

  /**
   * E2: Fuzzy-поиск через pg_trgm. Используется когда exactSearch ничего не
   * нашёл — даёт «мягкое» совпадение для случаев типа `"Простоквашино"` vs
   * `"Простоквашино, ООО"` или OCR-опечаток.
   *
   * Возвращает entries с similarity ≥ threshold, отсортированные по убыванию
   * score'а. similarity() = pg_trgm функция (0..1, 1 = идентично).
   *
   * **Performance:** для среднего справочника (<10K entries) sequential scan
   * приемлем (<50ms). Для больших — потребуется GIN-индекс на display_name
   * gin_trgm_ops (создаётся в миграции 0011: idx_ref_entries_name_trgm).
   * Запрос построен так, чтобы планировщик использовал индекс автоматически.
   *
   * Score возвращается отдельным полем для downstream-логики (Resolution
   * Engine пишет его в `match_score`).
   */
  async fuzzySearch(params: {
    listTypeSlug: string;
    organizationId: string;
    query: string;
    threshold?: number; // default 0.3 — соответствует pg_trgm-дефолту
    limit?: number;
  }): Promise<Array<ReferenceListEntryRow & { _score: number }>> {
    if (!params.query.trim()) return [];
    const threshold = params.threshold ?? 0.3;
    const { rows } = await db.query<ReferenceListEntryRow & { _score: number }>(
      `SELECT *, similarity(display_name, $3) AS _score
         FROM reference_list_entries
        WHERE list_type_slug = $1
          AND organization_id = $2
          AND is_active
          AND display_name % $3   -- оператор % использует GIN-индекс
          AND similarity(display_name, $3) >= $4
        ORDER BY _score DESC, display_name ASC
        LIMIT $5`,
      [
        params.listTypeSlug,
        params.organizationId,
        params.query,
        threshold,
        params.limit ?? 5,
      ],
    );
    return rows;
  }

  /**
   * Exact-поиск по search_keys — ядро матчинга v1.
   * GIN-индекс даёт O(1) на типичных объёмах каталога.
   */
  async exactSearch(params: {
    listTypeSlug: string;
    organizationId: string;
    values: string[];
    limit?: number;
  }): Promise<ReferenceListEntryRow[]> {
    if (params.values.length === 0) return [];
    const { rows } = await db.query<ReferenceListEntryRow>(
      `SELECT * FROM reference_list_entries
       WHERE list_type_slug = $1
         AND organization_id = $2
         AND is_active
         AND search_keys && $3
       ORDER BY display_name
       LIMIT $4`,
      [
        params.listTypeSlug,
        params.organizationId,
        params.values,       // && = пересечение массивов, GIN-индекс
        params.limit ?? 10,
      ],
    );
    return rows;
  }

  async create(params: {
    listTypeSlug: string;
    organizationId: string;
    input: EntryCreateInput;
  }): Promise<ReferenceListEntryRow> {
    const { rows } = await db.query<ReferenceListEntryRow>(
      `INSERT INTO reference_list_entries
         (list_type_slug, organization_id, external_id, display_name, search_keys, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        params.listTypeSlug,
        params.organizationId,
        params.input.external_id ?? null,
        params.input.display_name,
        params.input.search_keys,
        JSON.stringify(params.input.data ?? {}),
      ],
    );
    return rows[0]!;
  }

  async update(
    id: string,
    organizationId: string,
    patch: Partial<EntryCreateInput> & { is_active?: boolean },
  ): Promise<ReferenceListEntryRow | null> {
    const { rows } = await db.query<ReferenceListEntryRow>(
      `UPDATE reference_list_entries
       SET display_name = COALESCE($3, display_name),
           search_keys  = COALESCE($4, search_keys),
           data         = COALESCE($5::jsonb, data),
           is_active    = COALESCE($6, is_active),
           updated_at   = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [
        id,
        organizationId,
        patch.display_name ?? null,
        patch.search_keys ?? null,
        patch.data != null ? JSON.stringify(patch.data) : null,
        patch.is_active ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  /** Soft-delete: ставим is_active=false. */
  async deactivate(id: string, organizationId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE reference_list_entries
       SET is_active = FALSE, updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Bulk create — все или ничего: одна транзакция, при ошибке полный rollback.
   * Используется `POST /entries/bulk`. external_id может отсутствовать (в отличие от sync).
   */
  async bulkCreate(params: {
    listTypeSlug: string;
    organizationId: string;
    entries: Array<EntryCreateInput>;
  }): Promise<number> {
    if (params.entries.length === 0) return 0;
    return withTransaction(async (client) => {
      let created = 0;
      for (const entry of params.entries) {
        await client.query(
          `INSERT INTO reference_list_entries
             (list_type_slug, organization_id, external_id, display_name, search_keys, data)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            params.listTypeSlug,
            params.organizationId,
            entry.external_id ?? null,
            entry.display_name,
            entry.search_keys,
            JSON.stringify(entry.data ?? {}),
          ],
        );
        created++;
      }
      return created;
    });
  }

  /**
   * Bulk upsert — используется push-sync от внешних систем.
   * Ключ: (list_type_slug, organization_id, external_id).
   * Записи с external_id которых нет в переданном массиве — деактивируются.
   *
   * All-or-nothing: вся операция в одной транзакции. Если упало на любой
   * строке — rollback всего, чтобы snapshot оставался согласованным.
   */
  async bulkSync(params: {
    listTypeSlug: string;
    organizationId: string;
    entries: SyncEntry[];
  }): Promise<{ upserted: number; deactivated: number }> {
    if (params.entries.length === 0) {
      return { upserted: 0, deactivated: 0 };
    }

    return withTransaction(async (client) => {
      let upserted = 0;
      const externalIds: string[] = [];

      for (const entry of params.entries) {
        await client.query(
          `INSERT INTO reference_list_entries
             (list_type_slug, organization_id, external_id, display_name, search_keys, data, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (list_type_slug, organization_id, external_id)
             WHERE external_id IS NOT NULL
           DO UPDATE SET
             display_name = EXCLUDED.display_name,
             search_keys  = EXCLUDED.search_keys,
             data         = EXCLUDED.data,
             is_active    = TRUE,
             synced_at    = now(),
             updated_at   = now()`,
          [
            params.listTypeSlug,
            params.organizationId,
            entry.external_id,
            entry.display_name,
            entry.search_keys,
            JSON.stringify(entry.data ?? {}),
          ],
        );
        upserted++;
        externalIds.push(entry.external_id);
      }

      // Деактивируем записи которых нет в новой выгрузке
      const { rowCount } = await client.query(
        `UPDATE reference_list_entries
         SET is_active = FALSE, updated_at = now()
         WHERE list_type_slug = $1
           AND organization_id = $2
           AND external_id IS NOT NULL
           AND external_id <> ALL($3)
           AND is_active`,
        [params.listTypeSlug, params.organizationId, externalIds],
      );

      return { upserted, deactivated: rowCount ?? 0 };
    });
  }

  toApi(row: ReferenceListEntryRow): ReferenceListEntryApi {
    return {
      id: row.id,
      list_type_slug: row.list_type_slug,
      organization_id: row.organization_id,
      external_id: row.external_id,
      display_name: row.display_name,
      search_keys: row.search_keys,
      data: row.data,
      is_active: row.is_active,
      synced_at: row.synced_at ? row.synced_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Resolution results (entity links + item matches)
// ---------------------------------------------------------------------------

class ResolutionResultsRepo {
  async insertEntityLink(params: {
    jobId: string;
    organizationId: string;
    listTypeSlug: string;
    entryId: string | null;
    matchScore: number | null;
    matchMethod: string | null;
    matchField: string | null;
    matchValue: string | null;
    status: 'suggested' | 'not_found';
  }): Promise<JobEntityLinkRow> {
    const { rows } = await db.query<JobEntityLinkRow>(
      `INSERT INTO job_entity_links
         (job_id, organization_id, list_type_slug, entry_id,
          match_score, match_method, match_field, match_value, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        params.jobId,
        params.organizationId,
        params.listTypeSlug,
        params.entryId,
        params.matchScore,
        params.matchMethod,
        params.matchField,
        params.matchValue,
        params.status,
      ],
    );
    return rows[0]!;
  }

  async insertItemMatch(params: {
    jobId: string;
    organizationId: string;
    listTypeSlug: string;
    itemIndex: number;
    itemRaw: Record<string, unknown>;
    entryId: string | null;
    matchScore: number | null;
    matchMethod: string | null;
    status: 'suggested' | 'not_found';
    issues?: string[];
  }): Promise<JobItemMatchRow> {
    const { rows } = await db.query<JobItemMatchRow>(
      `INSERT INTO job_item_matches
         (job_id, organization_id, list_type_slug, item_index, item_raw,
          entry_id, match_score, match_method, status, issues)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        params.jobId,
        params.organizationId,
        params.listTypeSlug,
        params.itemIndex,
        JSON.stringify(params.itemRaw),
        params.entryId,
        params.matchScore,
        params.matchMethod,
        params.status,
        params.issues ?? [],
      ],
    );
    return rows[0]!;
  }

  async listEntityLinks(jobId: string): Promise<JobEntityLinkRow[]> {
    const { rows } = await db.query<JobEntityLinkRow>(
      `SELECT * FROM job_entity_links WHERE job_id = $1 ORDER BY created_at`,
      [jobId],
    );
    return rows;
  }

  async listItemMatches(jobId: string): Promise<JobItemMatchRow[]> {
    const { rows } = await db.query<JobItemMatchRow>(
      `SELECT * FROM job_item_matches WHERE job_id = $1 ORDER BY item_index`,
      [jobId],
    );
    return rows;
  }

  /** Подтвердить / отклонить entity link. Оператор может указать другой entry_id. */
  async updateEntityLinkStatus(
    id: string,
    organizationId: string,
    status: 'confirmed' | 'rejected',
    confirmedBy: string,
    entryId?: string,
  ): Promise<JobEntityLinkRow | null> {
    const { rows } = await db.query<JobEntityLinkRow>(
      `UPDATE job_entity_links
       SET status       = $3,
           confirmed_by = $4,
           confirmed_at = now(),
           entry_id     = COALESCE($5::uuid, entry_id)
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [id, organizationId, status, confirmedBy, entryId ?? null],
    );
    return rows[0] ?? null;
  }

  async updateItemMatchStatus(
    id: string,
    organizationId: string,
    status: 'confirmed' | 'rejected',
    confirmedBy: string,
    entryId?: string,
  ): Promise<JobItemMatchRow | null> {
    const { rows } = await db.query<JobItemMatchRow>(
      `UPDATE job_item_matches
       SET status       = $3,
           confirmed_by = $4,
           confirmed_at = now(),
           entry_id     = COALESCE($5::uuid, entry_id)
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [id, organizationId, status, confirmedBy, entryId ?? null],
    );
    return rows[0] ?? null;
  }

  /** Найти entity link по id (без org-фильтра — для authz через job). */
  async findEntityLinkById(id: string): Promise<JobEntityLinkRow | null> {
    const { rows } = await db.query<JobEntityLinkRow>(
      `SELECT * FROM job_entity_links WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Найти item match по id (без org-фильтра — для authz через job). */
  async findItemMatchById(id: string): Promise<JobItemMatchRow | null> {
    const { rows } = await db.query<JobItemMatchRow>(
      `SELECT * FROM job_item_matches WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Удалить все результаты резолюции по job — перед повторным прогоном. */
  async deleteByJob(jobId: string): Promise<void> {
    await db.query(`DELETE FROM job_entity_links WHERE job_id = $1`, [jobId]);
    await db.query(`DELETE FROM job_item_matches  WHERE job_id = $1`, [jobId]);
  }

  entityLinkToApi(row: JobEntityLinkRow, entry?: ReferenceListEntryApi | null): EntityLinkApi {
    return {
      id: row.id,
      job_id: row.job_id,
      list_type_slug: row.list_type_slug,
      entry_id: row.entry_id,
      entry: entry ?? null,
      match_score: row.match_score !== null ? Number(row.match_score) : null,
      match_method: row.match_method,
      match_field: row.match_field,
      match_value: row.match_value,
      status: row.status,
      confirmed_at: row.confirmed_at ? row.confirmed_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
    };
  }

  itemMatchToApi(row: JobItemMatchRow, entry?: ReferenceListEntryApi | null): ItemMatchApi {
    return {
      id: row.id,
      job_id: row.job_id,
      list_type_slug: row.list_type_slug,
      item_index: row.item_index,
      item_raw: row.item_raw,
      entry_id: row.entry_id,
      entry: entry ?? null,
      match_score: row.match_score !== null ? Number(row.match_score) : null,
      match_method: row.match_method,
      status: row.status,
      issues: row.issues,
      confirmed_at: row.confirmed_at ? row.confirmed_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
    };
  }
}

export const listTypesRepo = new ReferenceListTypesRepo();
export const listEntriesRepo = new ReferenceListEntriesRepo();
export const resolutionResultsRepo = new ResolutionResultsRepo();
