import { db } from '../db.js';
import type { DocumentTypeSlug, JobStatus, OcrEngineName } from '../types/documents.js';

export type JobRow = {
  id: string;
  status: JobStatus;
  file_name: string;
  file_path: string;
  file_size: string; // pg BIGINT comes back as string
  mime_type: string;
  document_hint: DocumentTypeSlug | null;
  document_type: DocumentTypeSlug | null;
  ocr_engine: OcrEngineName | null;
  raw_text: string | null;
  confidence: string | null; // NUMERIC -> string
  extracted: Record<string, unknown> | null;
  extracted_corrected_at: Date | null;
  metadata: Record<string, unknown> | null;
  webhook_url: string | null;
  webhook_attempts: number;
  webhook_delivered_at: Date | null;
  webhook_last_error: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  idempotency_key: string | null;
};

export type CreateJobInput = {
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  documentHint: DocumentTypeSlug | null;
  webhookUrl: string | null;
  metadata: unknown;
  idempotencyKey?: string | null;
};

export type ListFilters = {
  status?: JobStatus;
  document_type?: DocumentTypeSlug;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
};

export type ProcessingUpdate = {
  status: JobStatus;
  documentType?: DocumentTypeSlug | null;
  ocrEngine?: OcrEngineName | null;
  rawText?: string | null;
  confidence?: number | null;
  extracted?: Record<string, unknown> | null;
  error?: string | null;
};

class JobsRepo {
  async create(input: CreateJobInput): Promise<JobRow> {
    const { rows } = await db.query<JobRow>(
      `INSERT INTO jobs (file_name, file_path, file_size, mime_type, document_hint, webhook_url, metadata, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        input.fileName,
        input.filePath,
        input.fileSize,
        input.mimeType,
        input.documentHint,
        input.webhookUrl,
        input.metadata == null ? null : JSON.stringify(input.metadata),
        input.idempotencyKey ?? null,
      ],
    );
    return rows[0]!;
  }

  async findById(id: string): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /**
   * Look up an existing job by its caller-supplied `Idempotency-Key`.
   * Used by `POST /api/v1/jobs` to short-circuit retries: if a key is
   * present and we already have a job for it, return that one instead
   * of creating a duplicate.
   */
  async findByIdempotencyKey(key: string): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(
      `SELECT * FROM jobs WHERE idempotency_key = $1 LIMIT 1`,
      [key],
    );
    return rows[0] ?? null;
  }

  async markProcessing(id: string): Promise<void> {
    await db.query(
      `UPDATE jobs SET status = 'processing', started_at = COALESCE(started_at, now()) WHERE id = $1`,
      [id],
    );
  }

  async finalize(id: string, update: ProcessingUpdate): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET
         status        = $2,
         document_type = COALESCE($3, document_type),
         ocr_engine    = COALESCE($4, ocr_engine),
         raw_text      = COALESCE($5, raw_text),
         confidence    = COALESCE($6, confidence),
         extracted     = COALESCE($7::jsonb, extracted),
         error         = $8,
         finished_at   = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        update.status,
        update.documentType ?? null,
        update.ocrEngine ?? null,
        update.rawText ?? null,
        update.confidence ?? null,
        update.extracted == null ? null : JSON.stringify(update.extracted),
        update.error ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  async applyExtractedCorrection(
    id: string,
    extracted: Record<string, unknown>,
  ): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET
         extracted = $2::jsonb,
         status = 'done',
         extracted_corrected_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify(extracted)],
    );
    return rows[0] ?? null;
  }

  /**
   * Rows that the API created in `pending` but BullMQ never received (or
   * received and lost). `graceSeconds` ignores fresh rows so the normal
   * enqueue path isn't second-guessed during its window. `markProcessing`
   * is the natural boundary: once it sets `started_at`, the row is no
   * longer a sweeper target.
   */
  async findStalePending(graceSeconds: number, limit = 100): Promise<JobRow[]> {
    const { rows } = await db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'pending'
         AND created_at < now() - ($1 || ' seconds')::interval
       ORDER BY created_at ASC
       LIMIT $2`,
      [String(graceSeconds), limit],
    );
    return rows;
  }

  /**
   * Terminal-state jobs (done / failed / needs_review) older than retention
   * whose source file is still on disk. `file_path IS NOT NULL` is the
   * "already cleaned up" gate — we NULL it inside `markFileDeleted` so
   * subsequent sweeps don't keep re-finding the same row.
   */
  async findFinishedWithFileOlderThan(retentionDays: number, limit = 500): Promise<JobRow[]> {
    const { rows } = await db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status IN ('done', 'failed', 'needs_review')
         AND finished_at < now() - ($1 || ' days')::interval
         AND file_path IS NOT NULL
       ORDER BY finished_at ASC
       LIMIT $2`,
      [String(retentionDays), limit],
    );
    return rows;
  }

  async markFileDeleted(id: string): Promise<void> {
    await db.query(`UPDATE jobs SET file_path = NULL WHERE id = $1`, [id]);
  }

  async recordWebhookAttempt(id: string, success: boolean, error: string | null): Promise<void> {
    if (success) {
      await db.query(
        `UPDATE jobs SET
           webhook_attempts = webhook_attempts + 1,
           webhook_delivered_at = now(),
           webhook_last_error = NULL
         WHERE id = $1`,
        [id],
      );
    } else {
      await db.query(
        `UPDATE jobs SET
           webhook_attempts = webhook_attempts + 1,
           webhook_last_error = $2
         WHERE id = $1`,
        [id, error],
      );
    }
  }

  async list(filters: ListFilters): Promise<JobRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.status) {
      params.push(filters.status);
      where.push(`status = $${params.length}`);
    }
    if (filters.document_type) {
      params.push(filters.document_type);
      where.push(`document_type = $${params.length}`);
    }
    if (filters.from) {
      params.push(filters.from);
      where.push(`created_at >= $${params.length}`);
    }
    if (filters.to) {
      params.push(filters.to);
      where.push(`created_at <= $${params.length}`);
    }
    params.push(filters.limit);
    params.push(filters.offset);
    const sql = `SELECT * FROM jobs
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC
                 LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await db.query<JobRow>(sql, params);
    return rows;
  }

  /**
   * Public API shape — never expose internal column names directly. Dates
   * are converted to ISO strings here so the zod response schema (which
   * uses z.string()) accepts them; the file_path column is omitted.
   *
   * Validation issues are stored as the reserved key `_issues` inside the
   * `extracted` JSONB to avoid a schema migration; on the way out we lift
   * them into a top-level `validation_issues` field for clean API ergonomics.
   */
  toApi(row: JobRow) {
    const { extracted, issues } = splitExtractedAndIssues(row.extracted);
    return {
      job_id: row.id,
      status: row.status,
      document_type: row.document_type,
      document_hint: row.document_hint,
      confidence: row.confidence === null ? null : Number(row.confidence),
      ocr_engine: row.ocr_engine,
      raw_text: row.raw_text,
      extracted,
      validation_issues: issues,
      metadata: row.metadata,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size: Number(row.file_size),
      error: row.error,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    };
  }
}

function splitExtractedAndIssues(
  raw: Record<string, unknown> | null,
): { extracted: Record<string, unknown> | null; issues: string[] } {
  if (raw === null) return { extracted: null, issues: [] };
  const { _issues, ...rest } = raw as { _issues?: unknown } & Record<string, unknown>;
  const issues = Array.isArray(_issues)
    ? _issues.filter((x): x is string => typeof x === 'string')
    : [];
  return { extracted: rest, issues };
}

export const jobsRepo = new JobsRepo();
