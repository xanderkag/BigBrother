import { db } from '../db.js';

/**
 * Audit log over admin-facing entities (document_types, provider_settings).
 *
 * Append-only: every CRUD route handler calls `append()` with the before/after
 * snapshots and lets us reconstruct what changed and when. We don't run a
 * background diff job — `diff` is computed at write time by the route layer
 * so the same shape is stored consistently regardless of which endpoint
 * produced the row.
 *
 * Actor: while we have a single shared Bearer token, `actor` is the string
 * `'admin'`. When per-user tokens land, the auth hook will populate
 * `req.actor` and routes will pass it through. The schema doesn't change.
 *
 * Reads: paginated by `(at DESC, id DESC)` so two rows landing in the same
 * millisecond keep a stable order.
 */

export type AuditEntity =
  | 'document_type'
  | 'provider_setting'
  | 'gateway_connector'
  | 'gateway_budget';
export type AuditAction = 'create' | 'update' | 'delete';

export type AuditLogRow = {
  id: number;
  at: Date;
  actor: string;
  entity: AuditEntity;
  entity_id: string;
  action: AuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: Record<string, { from: unknown; to: unknown }> | null;
};

export type AuditAppendInput = {
  actor: string;
  entity: AuditEntity;
  entity_id: string;
  action: AuditAction;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/**
 * Compute a per-field diff between two flat objects. Nested objects/arrays
 * compared by JSON equality — good enough for human-readable change log; we
 * don't try to produce a deep RFC 6902 patch.
 */
function computeDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Record<string, { from: unknown; to: unknown }> | null {
  if (!before && !after) return null;
  if (!before) {
    // Pure create: every present field is "new"
    const out: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(after ?? {})) {
      out[k] = { from: null, to: v };
    }
    return Object.keys(out).length ? out : null;
  }
  if (!after) {
    // Pure delete: every previous field is "gone"
    const out: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(before)) {
      out[k] = { from: v, to: null };
    }
    return Object.keys(out).length ? out : null;
  }
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[k] = { from: a ?? null, to: b ?? null };
    }
  }
  return Object.keys(out).length ? out : null;
}

class AuditLogRepo {
  async append(input: AuditAppendInput): Promise<AuditLogRow> {
    const diff = computeDiff(input.before, input.after);
    const { rows } = await db.query<AuditLogRow>(
      `INSERT INTO audit_log (actor, entity, entity_id, action, before, after, diff)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.actor,
        input.entity,
        input.entity_id,
        input.action,
        input.before ?? null,
        input.after ?? null,
        diff,
      ],
    );
    return rows[0]!;
  }

  /**
   * Удалить строки старше N дней. Возвращает количество удалённых.
   * Используется фоновым AuditLogSweeper'ом — без чистки таблица
   * растёт линейно от частоты админских правок: при ~1000 правок в
   * день и снимках before/after по 5-20 KB через год выходит 5-20 GB.
   *
   * `daysAgo` берётся из retention-конфига (по умолчанию 365). Безопасное
   * значение — рассчитайте регуляторные требования клиента: для типового
   * IT-change-audit 1-2 года достаточно, для финансовых операций
   * нужны 5-7 лет (но тут аудитятся не сами документы, а изменения
   * конфигурации, поэтому требования слабее).
   */
  async deleteOlderThan(daysAgo: number): Promise<number> {
    if (daysAgo < 0) {
      throw new Error('deleteOlderThan: daysAgo must be non-negative');
    }
    const { rowCount } = await db.query(
      `DELETE FROM audit_log WHERE at < now() - ($1 || ' days')::interval`,
      [String(daysAgo)],
    );
    return rowCount ?? 0;
  }

  async list(opts: {
    entity?: AuditEntity;
    entity_id?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AuditLogRow[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (opts.entity !== undefined) {
      where.push(`entity = $${i++}`);
      values.push(opts.entity);
    }
    if (opts.entity_id !== undefined) {
      where.push(`entity_id = $${i++}`);
      values.push(opts.entity_id);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    values.push(opts.limit ?? 100);
    values.push(opts.offset ?? 0);
    const { rows } = await db.query<AuditLogRow>(
      `SELECT * FROM audit_log ${whereSql}
       ORDER BY at DESC, id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      values,
    );
    return rows;
  }

  toApi(row: AuditLogRow) {
    return {
      // BIGSERIAL → pg возвращает строкой (избегает потери precision >2^53).
      // Аудит-log id не вырастет до 2^53, кастуем в number чтобы попасть
      // в response-schema (z.number()). Если эта таблица когда-то будет
      // расти как jobs — пересмотрим: тогда хранить как string по всей
      // цепочке (TS-type + schema).
      id: Number(row.id),
      at: row.at.toISOString(),
      actor: row.actor,
      entity: row.entity,
      entity_id: row.entity_id,
      action: row.action,
      before: row.before,
      after: row.after,
      diff: row.diff,
    };
  }
}

export const auditLogRepo = new AuditLogRepo();
export { computeDiff as _computeDiffForTesting };
