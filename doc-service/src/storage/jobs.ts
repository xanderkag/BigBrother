import { db } from '../db.js';
import type { DocumentTypeSlug, JobStatus, OcrEngineName } from '../types/documents.js';

export type LlmCallTrace = {
  prompt: string;
  raw_response: string;
  model: string;
  backend: string;
  duration_ms?: number;
  prompt_tokens?: number;
  output_tokens?: number;
};

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
  last_llm_call: LlmCallTrace | null;
  /** Tenant scope — заполняется при create, обязательное поле в БД. */
  organization_id: string;
  project_id: string;
  /** Пользователь-инициатор. Может быть null для legacy job'ов до миграции 008. */
  created_by_user_id: string | null;
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
  /** Tenant scope. Если не задан — caller (route) использует default. */
  organizationId: string;
  projectId: string;
  /** Кто создал job. Опционально (для системных sweeper'ов = null). */
  createdByUserId?: string | null;
};

export type ListFilters = {
  status?: JobStatus;
  document_type?: DocumentTypeSlug;
  from?: string;
  to?: string;
  /** Tenant-фильтр. Если не задан — super_admin видит всё. */
  organization_id?: string;
  project_id?: string;
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
  /**
   * Дебаг-трасса LLM-вызова. `undefined` = не трогать колонку,
   * `null` = очистить, объект = записать. Это позволяет последовательным
   * вызовам не затирать ранее сохранённый trace, если новый run не дёргал LLM.
   */
  llmCall?: LlmCallTrace | null;
};

class JobsRepo {
  async create(input: CreateJobInput): Promise<JobRow> {
    const { rows } = await db.query<JobRow>(
      `INSERT INTO jobs (
         file_name, file_path, file_size, mime_type,
         document_hint, webhook_url, metadata, idempotency_key,
         organization_id, project_id, created_by_user_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
        input.organizationId,
        input.projectId,
        input.createdByUserId ?? null,
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
    // last_llm_call: undefined → не менять, null → очистить, объект → записать.
    // Через $9 передаём JSON-encoded или null; через $10 — boolean флаг
    // «обновлять ли поле вообще».
    const llmCallProvided = update.llmCall !== undefined;
    const llmCallJson = update.llmCall == null ? null : JSON.stringify(update.llmCall);
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET
         status        = $2,
         document_type = COALESCE($3, document_type),
         ocr_engine    = COALESCE($4, ocr_engine),
         raw_text      = COALESCE($5, raw_text),
         confidence    = COALESCE($6, confidence),
         extracted     = COALESCE($7::jsonb, extracted),
         error         = $8,
         last_llm_call = CASE WHEN $10::boolean THEN $9::jsonb ELSE last_llm_call END,
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
        llmCallJson,
        llmCallProvided,
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

  /**
   * Раздельный список jobs по типу документа — оптимизированный путь для
   * страницы /document-types/:slug/jobs. Возвращает последние N документов
   * этого типа (по created_at DESC).
   */
  async listByDocumentType(slug: string, limit = 50): Promise<JobRow[]> {
    const { rows } = await db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE document_type = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [slug, limit],
    );
    return rows;
  }

  /**
   * Агрегированная статистика по типу документа за последние N дней.
   *
   * Что считаем (всё — на стороне Postgres, без выгрузки строк в Node):
   *   - total_jobs            — сколько всего jobs этого типа за период.
   *   - terminal_breakdown    — раскладка по итоговому статусу (done /
   *                             needs_review / failed). Идёт в product-метрику
   *                             "сколько процентов уходит в ручной review".
   *   - avg_confidence        — средний overall confidence по терминальным.
   *                             NULL когда нет ни одного готового.
   *
   * Покрытие по полям (`expected_fields_coverage`) считается отдельным
   * запросом, см. `getFieldCoverage`. Разделили чтобы не делать
   * мегазапрос ради нескольких процентов производительности.
   */
  async getTypeStats(
    slug: string,
    sinceDays: number,
  ): Promise<{
    total_jobs: number;
    terminal_breakdown: { done: number; needs_review: number; failed: number };
    avg_confidence: number | null;
  }> {
    const { rows } = await db.query<{
      total_jobs: string;
      done: string;
      needs_review: string;
      failed: string;
      avg_confidence: string | null;
    }>(
      `SELECT
         COUNT(*)::text                                                                  AS total_jobs,
         COUNT(*) FILTER (WHERE status = 'done')::text                                    AS done,
         COUNT(*) FILTER (WHERE status = 'needs_review')::text                            AS needs_review,
         COUNT(*) FILTER (WHERE status = 'failed')::text                                  AS failed,
         AVG(confidence) FILTER (WHERE status IN ('done', 'needs_review'))::text          AS avg_confidence
       FROM jobs
       WHERE document_type = $1
         AND created_at >= now() - ($2 || ' days')::interval`,
      [slug, String(sinceDays)],
    );
    const r = rows[0]!;
    return {
      total_jobs: Number(r.total_jobs),
      terminal_breakdown: {
        done: Number(r.done),
        needs_review: Number(r.needs_review),
        failed: Number(r.failed),
      },
      avg_confidence: r.avg_confidence === null ? null : Number(r.avg_confidence),
    };
  }

  /**
   * Покрытие по каждому ожидаемому полю: какая доля терминальных jobs
   * этого типа имеет это поле в `extracted` непустым.
   *
   * Поле может быть вложенным (`seller.inn`) — обрабатываем через
   * jsonb path: `extracted #> '{seller,inn}'`. SQL вычисляет всё разом
   * для всех полей, что важно при большой истории.
   *
   * «Непустое» = JSON value не null и не пустая строка (`""`). Числа,
   * массивы и объекты считаются непустыми. Для глубоких объектов
   * пустота не проверяется рекурсивно — упрощение, в реальных
   * docs-сценариях лучше иметь конкретный leaf-путь типа `seller.inn`,
   * а не `seller` целиком.
   */
  async getFieldCoverage(
    slug: string,
    expectedFields: readonly string[],
    sinceDays: number,
  ): Promise<Array<{ field: string; filled: number; total: number }>> {
    if (expectedFields.length === 0) return [];
    const expressions = expectedFields.map((field, i) => {
      const path = field.split('.');
      // jsonb #> '{a,b,c}' — извлекаем по dot-path. Параметризуем сам path
      // массивом ($i), чтобы избежать SQL-инъекций в имени поля.
      return `COUNT(*) FILTER (
        WHERE extracted #> $${i + 3} IS NOT NULL
          AND extracted #> $${i + 3} <> 'null'::jsonb
          AND extracted #> $${i + 3} <> '""'::jsonb
      )::text AS f${i}`;
    });
    const params: unknown[] = [slug, String(sinceDays)];
    for (const field of expectedFields) params.push(field.split('.'));

    const { rows } = await db.query<Record<string, string>>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('done', 'needs_review'))::text AS total,
         ${expressions.join(',\n         ')}
       FROM jobs
       WHERE document_type = $1
         AND created_at >= now() - ($2 || ' days')::interval`,
      params,
    );
    const r = rows[0]!;
    const total = Number(r.total ?? 0);
    return expectedFields.map((field, i) => ({
      field,
      filled: Number(r[`f${i}`] ?? 0),
      total,
    }));
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
    if (filters.organization_id) {
      params.push(filters.organization_id);
      where.push(`organization_id = $${params.length}`);
    }
    if (filters.project_id) {
      params.push(filters.project_id);
      where.push(`project_id = $${params.length}`);
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
      last_llm_call: row.last_llm_call,
      organization_id: row.organization_id,
      project_id: row.project_id,
      created_by_user_id: row.created_by_user_id,
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
