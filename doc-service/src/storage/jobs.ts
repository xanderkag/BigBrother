import { db } from '../db.js';
import { normalizeExtracted } from './normalize-extracted.js';
import {
  normalizeSlugForApi,
  expandSlugForms,
  INBOUND_SLUG_ALIASES,
} from '../types/slug-normalize.js';
import { stripInlineCredentials } from '../pipeline/llm/inline-credentials.js';
import { countBusinessFields } from '../pipeline/quality-assessment.js';
import { computeJobCost } from '../pipeline/cost.js';
import { config } from '../config.js';
import type { JobLlmUsage } from '../pipeline/llm/usage-context.js';
import type { ClassificationMetadata } from '../pipeline/classifier/llm-classifier.js';
import type { DocumentTypeSlug, JobStatus, OcrEngineName } from '../types/documents.js';

/** Slug'и (UPPER-case) через табличную OCR-модель — дороже (оценка ₽/док, cost.ts). */
const COST_TABLE_TYPES = new Set((config.yandex.tableModelTypes ?? []).map((t) => t.toUpperCase()));

/**
 * Сводный operational-результат, отдаваемый в /api/v1/metrics/operational.
 * Поля выбраны так, чтобы фронт мог их рисовать без пересчёта.
 */
export type OperationalSummary = {
  window_hours: number;
  totals: {
    total: number;
    pending: number;
    processing: number;
    done: number;
    needs_review: number;
    failed: number;
    validation_issues: number;
    llm_used: number;
  };
  rates: {
    done_rate: number;
    needs_review_rate: number;
    failed_rate: number;
    validation_issue_rate: number;
    llm_fallback_rate: number;
  };
  latency: { p50_ms: number | null; p95_ms: number | null };
  llm: {
    tokens_in_p95: number | null;
    tokens_out_p95: number | null;
    duration_p95_ms: number | null;
  };
  avg_confidence: number | null;
  throughput_per_hour: number;
  by_type: OperationalGroupRow<'slug'>[];
  by_engine: OperationalGroupRow<'engine'>[];
  by_tier: OperationalGroupRow<'tier'>[];
};

/**
 * Time-series bucket для дашборд-графиков. Каждый бакет — интервал
 * шириной `bucket_minutes` (см. TimeseriesResult), содержит агрегаты
 * по документам, попавшим в этот интервал по `created_at`.
 *
 * ts — начало бакета (UTC ISO). fronted строит по нему подписи оси X.
 * latency_p95_ms считается только по терминальным (finished_at IS NOT
 * NULL); pending/failed без finished_at в percentile не входят.
 */
export type TimeseriesBucket = {
  ts: string;
  total: number;
  done: number;
  needs_review: number;
  failed: number;
  latency_p95_ms: number | null;
};

/**
 * Результат /api/v1/metrics/timeseries: сетка бакетов + шаг сетки.
 *
 * `bucket_minutes` вычисляется автоматически из window'а так, чтобы
 * получилось 24–30 бакетов (оптимально для читаемого графика на десктопе).
 * Соответствие: 1h→5min · 24h→60min · 7d→360min (6h) · 30d→1440min (1d).
 *
 * Список бакетов — plottable-ready: **гарантированно 24+ точек**
 * даже для пустых интервалов (заполняем нулями SQL-side через
 * generate_series). Иначе бары «схлопывались» бы в дыры.
 */
export type TimeseriesResult = {
  window_hours: number;
  bucket_minutes: number;
  buckets: TimeseriesBucket[];
};

/**
 * Строка per-group breakdown. Ключ группы (`slug` / `engine` / `tier`)
 * параметризован — метрики одинаковы для всех трёх разрезов.
 */
export type OperationalGroupRow<K extends string> = {
  [P in K]: string;
} & {
  total: number;
  done: number;
  needs_review: number;
  failed: number;
  validation_issues: number;
  llm_used: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  avg_confidence: number | null;
  done_rate: number;
  needs_review_rate: number;
  failed_rate: number;
  validation_issue_rate: number;
  llm_fallback_rate: number;
};

/**
 * Шаг сетки для time-series графика. Цель — ~24-30 бакетов, читаемо на
 * десктопе (>30 → бары становятся тонкими, <20 → «зубчато»).
 *
 * Формула: `windowMinutes / TARGET_BUCKETS`, округлённая вверх до ближайшего
 * «человеческого» шага (5/10/15/30 мин, 1/2/3/6/12 ч, 1/2/3/7 дней) —
 * иначе на графике 47-минутные бакеты. Для стандартных окон получаем:
 *
 *   1h  →  5 мин  (12 бакетов)
 *   24h →  60 мин (24)
 *   7d  → 360 мин / 6 ч (28)
 *   30d → 1440 мин / 1 д (30)
 *   14d → 720 мин / 12 ч (28)   ← нестандартное окно масштабируется
 */
const NICE_BUCKET_MINUTES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080];
const TARGET_BUCKETS = 28;

function pickBucketMinutes(windowHours: number): number {
  const target = Math.max(5, (windowHours * 60) / TARGET_BUCKETS);
  return NICE_BUCKET_MINUTES.find((m) => m >= target) ?? NICE_BUCKET_MINUTES[NICE_BUCKET_MINUTES.length - 1]!;
}

function emptySummary(windowHours: number): OperationalSummary {
  return {
    window_hours: windowHours,
    totals: {
      total: 0,
      pending: 0,
      processing: 0,
      done: 0,
      needs_review: 0,
      failed: 0,
      validation_issues: 0,
      llm_used: 0,
    },
    rates: {
      done_rate: 0,
      needs_review_rate: 0,
      failed_rate: 0,
      validation_issue_rate: 0,
      llm_fallback_rate: 0,
    },
    latency: { p50_ms: null, p95_ms: null },
    llm: { tokens_in_p95: null, tokens_out_p95: null, duration_p95_ms: null },
    avg_confidence: null,
    throughput_per_hour: 0,
    by_type: [],
    by_engine: [],
    by_tier: [],
  };
}

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
  /**
   * SHA-256 хэш файла-источника (migration 0027). Заполняется при upload.
   * Используется для cache lookup — при повторной загрузке того же файла
   * возвращаем cached job_id без новой обработки. nullable для legacy
   * jobs до миграции 0027.
   */
  file_sha256: string | null;
  last_llm_call: LlmCallTrace | null;
  /** Суммарный расход токенов за джобу (см. миграцию 20260708000001). */
  llm_usage: JobLlmUsage | null;
  /**
   * Число OCR-страниц (для оценки стоимости ₽/док, миграция 20260713000001).
   * Заполняется на finalize из ocr.pages.length. NULL для legacy / до миграции.
   */
  ocr_pages: number | null;
  /** Tenant scope — заполняется при create, обязательное поле в БД. */
  organization_id: string;
  project_id: string;
  /** Пользователь-инициатор. Может быть null для legacy job'ов до миграции 008. */
  created_by_user_id: string | null;
  /**
   * Append-only список событий пайплайна. Заполняется оркестратором на каждой
   * стадии (upload, classify, ocr.<engine>, parse, validate, resolve, finalize).
   * UI читает для live-прогресса; пост-мортем при ошибках показывает на какой
   * именно ступени job упал.
   */
  pipeline_steps: PipelineStep[];
  /**
   * Метаданные LLM-классификатора (production LLM classifier, migration
   * 20260701000002). Заполняется на classify-стадии оркестратором/reprocess'ом.
   * UI (job detail) показывает «почему этот тип»: keyword_said, llm_said,
   * method, duration_ms, candidates, флаг unknown. NULL для legacy jobs.
   */
  classification: ClassificationMetadata | null;
};

/**
 * Одно событие пайплайна. Хранится в jobs.pipeline_steps как элемент JSONB-массива.
 *
 *   step:        'upload' | 'classify' | 'ocr.tesseract' | 'ocr.vision-llm' | 'parse.<kind>' | 'validate' | 'resolve' | 'finalize'
 *   status:      'started' | 'done' | 'failed' | 'skipped'
 *   at:          ISO-таймстамп
 *   duration_ms: только у done/failed/skipped — сколько шаг занял
 *   details:     произвольный JSON с конкретикой шага (confidence, engine, issues_count, …)
 */
export type PipelineStep = {
  step: string;
  status: 'started' | 'done' | 'failed' | 'skipped';
  at: string;
  duration_ms?: number;
  details?: Record<string, unknown>;
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
  /**
   * SHA-256 hash файла (hex lowercase, 64 chars). Вычисляется в
   * routes/jobs.ts при upload через streaming hash. Используется для
   * cache lookup при повторной загрузке того же файла.
   */
  fileSha256?: string | null;
  /** Tenant scope. Если не задан — caller (route) использует default. */
  organizationId: string;
  projectId: string;
  /** Кто создал job. Опционально (для системных sweeper'ов = null). */
  createdByUserId?: string | null;
};

export type ListFilters = {
  status?: JobStatus;
  document_type?: DocumentTypeSlug;
  /** Несколько типов сразу (OR). Приходит из query `document_types` (comma-separated). */
  document_types?: DocumentTypeSlug[];
  /** Формат(ы) исходного файла (OR) — см. FORMAT_PREDICATES ниже. */
  format?: Array<'pdf' | 'excel' | 'word' | 'image' | 'xml' | 'other'>;
  from?: string;
  to?: string;
  /** Tenant-фильтр. Если не задан — super_admin видит всё. */
  organization_id?: string;
  project_id?: string;
  /**
   * Free-text quick-search: ищет по file_name (ILIKE), id (prefix) и
   * выбранным extracted-полям (INN, contract_number). См. buildJobsFilter.
   */
  q?: string;
  limit: number;
  offset: number;
};

export type ProcessingUpdate = {
  status: JobStatus;
  /**
   * Суммарный расход токенов за джобу (все LLM-вызовы: classify + проходы
   * extract + verify + vision). `undefined` = не трогать колонку.
   * `calls_without_usage > 0` → суммы неполны, см. usage-context.ts.
   */
  llmUsage?: JobLlmUsage | null;
  /** Число OCR-страниц (для оценки ₽/док). `undefined` = не трогать колонку. */
  ocrPages?: number | null;
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

/**
 * SQL-предикаты фильтра «Формат» (ListFilters.format). Статические строки —
 * пользовательский ввод сюда не попадает (format прошёл z.enum). `x-cfb`
 * (OLE-контейнер, общий для legacy .xls и .doc) разводится по расширению
 * file_name — та же логика, что у роутинга OCR-движков (xlsx.ts / doc.ts).
 * `other` — всё, что не подошло ни под один формат (честное дополнение).
 */
const EXCEL_PRED = `(mime_type IN ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','application/vnd.ms-excel.sheet.macroEnabled.12') OR (mime_type = 'application/x-cfb' AND file_name ~* '\\.(xls|xlsm|xlsb|xlt)$'))`;
const WORD_PRED = `(mime_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword') OR (mime_type = 'application/x-cfb' AND file_name ~* '\\.doc$'))`;
const PDF_PRED = `mime_type = 'application/pdf'`;
const IMAGE_PRED = `mime_type LIKE 'image/%'`;
const XML_PRED = `mime_type IN ('application/xml','text/xml')`;

const FORMAT_PREDICATES: Record<NonNullable<ListFilters['format']>[number], string> = {
  pdf: PDF_PRED,
  excel: EXCEL_PRED,
  word: WORD_PRED,
  image: IMAGE_PRED,
  xml: XML_PRED,
  other: `NOT (${PDF_PRED} OR ${EXCEL_PRED} OR ${WORD_PRED} OR ${IMAGE_PRED} OR ${XML_PRED})`,
};

class JobsRepo {
  async create(input: CreateJobInput): Promise<JobRow> {
    // B4: явный ::jsonb cast на metadata — pg-driver передаёт JSON.stringify(null)
    // как text NULL, а не jsonb NULL. На JSONB-колонке обычно справляется, но
    // явный cast убирает неопределённость и помогает type-inference Postgres
    // если когда-нибудь добавим триггеры/expressions на metadata.
    const { rows } = await db.query<JobRow>(
      `INSERT INTO jobs (
         file_name, file_path, file_size, mime_type,
         document_hint, webhook_url, metadata, idempotency_key,
         file_sha256,
         organization_id, project_id, created_by_user_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
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
        input.fileSha256 ?? null,
        input.organizationId,
        input.projectId,
        input.createdByUserId ?? null,
      ],
    );
    return rows[0]!;
  }

  /**
   * SHA-256 cache lookup. Returns job с тем же hash в той же организации
   * со status='done' age < N часов. Если найден — caller возвращает
   * cached job_id без обработки.
   *
   * Возвращает только finished jobs — pending/processing не cached
   * (могут провалиться, и пользователь застрял на их результате).
   * `extracted_corrected_at` не учитываем — даже если оператор правил
   * extracted, hash файла тот же, return cache OK.
   */
  async findCachedBySha256(
    sha256: string,
    organizationId: string,
    maxAgeHours: number,
  ): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE file_sha256 = $1
         AND organization_id = $2
         AND status = 'done'
         AND created_at > now() - ($3 || ' hours')::interval
       ORDER BY created_at DESC
       LIMIT 1`,
      [sha256, organizationId, String(maxAgeHours)],
    );
    return rows[0] ?? null;
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
  async findByIdempotencyKey(key: string, orgId?: string): Promise<JobRow | null> {
    // audit #1: при передаче orgId — tenant-scoped lookup (ключ уникален в
    // рамках орг). Без orgId — глобальный (для short-circuit до резолва орг;
    // там дополнительно проверяется доступ к проекту найденной задачи).
    const { rows } = orgId
      ? await db.query<JobRow>(
          `SELECT * FROM jobs WHERE idempotency_key = $1 AND organization_id = $2 LIMIT 1`,
          [key, orgId],
        )
      : await db.query<JobRow>(`SELECT * FROM jobs WHERE idempotency_key = $1 LIMIT 1`, [key]);
    return rows[0] ?? null;
  }

  /**
   * Append одного события пайплайна в jobs.pipeline_steps. Best-effort:
   * исключения логирует caller, мы не хотим что pipeline-observability
   * валила основной поток обработки. Один запрос на событие — для типичных
   * 10-20 событий на job это ~10ms суммарно.
   */
  async appendPipelineStep(id: string, step: PipelineStep): Promise<void> {
    await db.query(
      `UPDATE jobs SET pipeline_steps = pipeline_steps || $2::jsonb WHERE id = $1`,
      [id, JSON.stringify(step)],
    );
  }

  /**
   * Сохранить метаданные классификации (production LLM classifier). Вызывается
   * на classify-стадии — до finalize(). best-effort как pipeline steps: caller
   * логирует ошибку, но не роняет обработку из-за метаданных наблюдаемости.
   */
  async saveClassification(id: string, meta: ClassificationMetadata): Promise<void> {
    await db.query(`UPDATE jobs SET classification = $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify(meta),
    ]);
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
    // Та же семантика для llm_usage: undefined → не трогать, null → очистить.
    const llmUsageProvided = update.llmUsage !== undefined;
    const llmUsageJson = update.llmUsage == null ? null : JSON.stringify(update.llmUsage);
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
         llm_usage     = CASE WHEN $12::boolean THEN $11::jsonb ELSE llm_usage END,
         ocr_pages     = COALESCE($13, ocr_pages),
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
        llmUsageJson,
        llmUsageProvided,
        update.ocrPages ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Ручная корректировка extracted.
   *
   * По умолчанию (`keepStatus=false`) переводит job в `done` — поведение
   * «сохранить = одобрить», как было исторически.
   *
   * При `keepStatus=true` (ТЗ §8.1, вариант A) статус НЕ трогаем: оператор
   * правит данные, но job остаётся в `needs_review` до явного одобрения.
   * Это разводит «сохранить черновик правки» и «одобрить» на два действия.
   * В обоих случаях фиксируем `extracted_corrected_at`.
   */
  async applyExtractedCorrection(
    id: string,
    extracted: Record<string, unknown>,
    keepStatus = false,
  ): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET
         extracted = $2::jsonb,
         ${keepStatus ? '' : "status = 'done',"}
         extracted_corrected_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify(extracted)],
    );
    return rows[0] ?? null;
  }

  /**
   * CP6: Human approval — переводит needs_review → done без изменения
   * extracted. Используется оператором в Review Queue после проверки,
   * когда он убедился что данные верны. Если статус уже не needs_review
   * (например, конкурентный approve или reprocess) — операция идемпотентна
   * и возвращает актуальную строку без изменений.
   */
  /**
   * Принудительно перевести job в `needs_review` и добавить `reason` в
   * `extracted._issues[]`. Используется Resolution Engine'ом когда сущность не
   * нашлась в справочнике с `on_not_found: 'needs_review'`.
   *
   * Работает только если job уже в терминальном статусе (done|needs_review) —
   * чтобы не перебить нормальный pipeline-flow. Возвращает обновлённую строку
   * или null если переход не произошёл.
   */
  async markNeedsReview(id: string, reason: string): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs
       SET status    = 'needs_review',
           extracted = CASE
             WHEN extracted IS NULL THEN
               jsonb_build_object('_issues', jsonb_build_array($2::text))
             ELSE
               jsonb_set(
                 extracted,
                 '{_issues}',
                 COALESCE(extracted->'_issues', '[]'::jsonb) || to_jsonb($2::text),
                 true
               )
           END
       WHERE id = $1 AND status IN ('done', 'needs_review')
       RETURNING *`,
      [id, reason],
    );
    return rows[0] ?? null;
  }

  async approve(id: string): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs
         SET status = 'done',
             extracted_corrected_at = COALESCE(extracted_corrected_at, now())
       WHERE id = $1 AND status = 'needs_review'
       RETURNING *`,
      [id],
    );
    // If row wasn't in needs_review — return current state (idempotent).
    if (rows.length === 0) return this.findById(id);
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
   * Stuck-processing jobs — те что застряли в status='processing' без
   * прогресса worker'а. Типовая причина: worker рестартован/убит, BullMQ
   * остался без consumer'а, job завис в active queue.
   *
   * Эвристика: status='processing' AND updated_at старше graceSeconds.
   * `updated_at` обновляется на каждом step (pipeline_steps append),
   * поэтому worker, который реально работает, не попадёт в выборку.
   * Если worker молчит graceSeconds (default = LLM_TIMEOUT_MS / 1000 + buffer),
   * значит job orphan'нулся.
   *
   * Возвращаем эти jobs для re-enqueue'я. processJobInner идемпотентен
   * (повторное finalize OK), так что race с реально работающим worker'ом
   * безопасен в худшем случае.
   */
  async findStuckProcessing(graceSeconds: number, limit = 50): Promise<JobRow[]> {
    const { rows } = await db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'processing'
         AND updated_at < now() - ($1 || ' seconds')::interval
       ORDER BY updated_at ASC
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

  async markFileDeleted(id: string, clearRawText = true): Promise<void> {
    // §8.1 (ПДн-блокер): NULL-им file_path; raw_text — по флагу.
    // clearRawText=true (F27 delete_after_processing): клиент просит уничтожить
    // ПДн → чистим и OCR-текст (иначе паспортные страницы утекали наружу).
    // clearRawText=false (audit #9): retention-sweeper для needs_review НЕ трогает
    // raw_text — он ещё нужен оператору (reprocess под новый промпт + просмотр OCR
    // в очереди ревью); зануление ломало эти сценарии. Файл удаляется в обоих.
    if (clearRawText) {
      await db.query(`UPDATE jobs SET file_path = NULL, raw_text = NULL WHERE id = $1`, [id]);
    } else {
      await db.query(`UPDATE jobs SET file_path = NULL WHERE id = $1`, [id]);
    }
  }

  /**
   * A4: Сброс счётчика попыток перед ре-доставкой. Вызывается из
   * POST /jobs/:id/redeliver-webhook перед тем как заново запустить
   * `deliverWebhook` — иначе счётчик продолжается с последнего значения
   * и не даёт полных maxAttempts новых попыток.
   */
  async resetWebhookAttempts(id: string): Promise<void> {
    await db.query(
      `UPDATE jobs SET
         webhook_attempts = 0,
         webhook_delivered_at = NULL,
         webhook_last_error = NULL
       WHERE id = $1`,
      [id],
    );
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
    // Обе формы слага (CMR/cmr): в колонке живут и исторические (keyword-
    // классификатор), и outbound (document_hint) — см. expandSlugForms.
    const { rows } = await db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE document_type = ANY($1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [expandSlugForms(slug), limit],
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
       WHERE document_type = ANY($1)
         AND created_at >= now() - ($2 || ' days')::interval`,
      [expandSlugForms(slug), String(sinceDays)],
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
    const params: unknown[] = [expandSlugForms(slug), String(sinceDays)];
    for (const field of expectedFields) params.push(field.split('.'));

    const { rows } = await db.query<Record<string, string>>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('done', 'needs_review'))::text AS total,
         ${expressions.join(',\n         ')}
       FROM jobs
       WHERE document_type = ANY($1)
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

  /**
   * Системная сводка для operations-дашборда: за окно (часах) считаем —
   *  - тоталы по статусам,
   *  - перцентили end-to-end latency,
   *  - LLM-метрики (fallback rate, P95 tokens in/out, P95 call duration),
   *  - per-type breakdown.
   *
   * Зачем именно так: эти цифры есть в БД без всякого ground-truth (в
   * отличие от accuracy, которая требует golden-set). Дают честную
   * картину operational health: «у нас 14% needs_review и P95 9сек на
   * UPD'ах, latency растёт» — это видно по graph'у, без выгрузки.
   *
   * Tenant-scope:
   *   - kind:'all'        — без фильтра (super_admin)
   *   - kind:'org'        — добавляем organization_id = $X
   *   - kind:'projects'   — добавляем project_id = ANY($X). Пустой набор
   *     → пустой результат (0 jobs во всём).
   */
  async getOperationalSummary(
    windowHours: number,
    scope:
      | { kind: 'all' }
      | { kind: 'org'; orgId: string }
      | { kind: 'projects'; projectIds: Set<string> },
  ): Promise<OperationalSummary> {
    // Пустой projects-scope = «нет доступа ни к одному проекту». Возвращаем
    // пустую сводку, чтобы UI показал «нет данных», а не ронялся.
    if (scope.kind === 'projects' && scope.projectIds.size === 0) {
      return emptySummary(windowHours);
    }

    // Сборка scope-фильтра. Кладём в начало параметров, дальше idx сдвигается.
    // ВАЖНО: prefix `j.` для колонок, потому что by_tier делает LEFT JOIN
    // с document_types (у них тоже есть organization_id). totalsSql тоже
    // aliasit jobs как `j`, чтобы whereExtra работал единообразно во всех
    // четырёх подзапросах.
    const params: unknown[] = [String(windowHours)];
    const scopeWhere: string[] = [];
    if (scope.kind === 'org') {
      params.push(scope.orgId);
      scopeWhere.push(`j.organization_id = $${params.length}`);
    } else if (scope.kind === 'projects') {
      params.push(Array.from(scope.projectIds));
      scopeWhere.push(`j.project_id = ANY($${params.length}::uuid[])`);
    }
    const whereExtra = scopeWhere.length ? `AND ${scopeWhere.join(' AND ')}` : '';

    // --- 1. Тоталы + perсentile + LLM-сводка ---
    //
    // percentile_cont — линейная интерполяция, корректно работает на
    // малых выборках. Считаем по терминальным (done/needs_review) —
    // failed не имеют finished_at, pending/processing не финальные.
    const totalsSql = `
      SELECT
        COUNT(*)::text                                                AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::text              AS pending,
        COUNT(*) FILTER (WHERE status = 'processing')::text           AS processing,
        COUNT(*) FILTER (WHERE status = 'done')::text                 AS done,
        COUNT(*) FILTER (WHERE status = 'needs_review')::text         AS needs_review,
        COUNT(*) FILTER (WHERE status = 'failed')::text               AS failed,
        COUNT(*) FILTER (
          WHERE extracted ? '_issues'
            AND jsonb_array_length(COALESCE(extracted->'_issues','[]'::jsonb)) > 0
        )::text                                                       AS validation_issues,
        COUNT(*) FILTER (WHERE last_llm_call IS NOT NULL)::text       AS llm_used,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000
        ) FILTER (WHERE finished_at IS NOT NULL)                      AS lat_p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000
        ) FILTER (WHERE finished_at IS NOT NULL)                      AS lat_p95,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY (last_llm_call->>'prompt_tokens')::int
        ) FILTER (WHERE (last_llm_call->>'prompt_tokens') IS NOT NULL) AS tok_in_p95,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY (last_llm_call->>'output_tokens')::int
        ) FILTER (WHERE (last_llm_call->>'output_tokens') IS NOT NULL) AS tok_out_p95,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY (last_llm_call->>'duration_ms')::int
        ) FILTER (WHERE (last_llm_call->>'duration_ms') IS NOT NULL) AS llm_dur_p95,
        AVG(confidence) FILTER (WHERE status IN ('done','needs_review'))::text AS avg_confidence
      FROM jobs j
      WHERE j.created_at >= now() - ($1 || ' hours')::interval
        ${whereExtra}
    `;
    const totalsRes = await db.query<{
      total: string;
      pending: string;
      processing: string;
      done: string;
      needs_review: string;
      failed: string;
      validation_issues: string;
      llm_used: string;
      lat_p50: string | null;
      lat_p95: string | null;
      tok_in_p95: string | null;
      tok_out_p95: string | null;
      llm_dur_p95: string | null;
      avg_confidence: string | null;
    }>(totalsSql, params);
    const t = totalsRes.rows[0]!;
    const total = Number(t.total);

    // --- 2. Per-group breakdowns ---
    //
    // Три разреза с идентичным набором метрик, отличаются только
    // выражением группы. Чтобы не дублировать длинный SELECT, собираем
    // через groupBreakdown(). Все три используют тот же window+scope WHERE
    // (whereExtra) и тот же массив params ($1 = windowHours, scope-параметры
    // за ним) — фильтрация согласована с totals.
    //
    //  - by_type   GROUP BY document_type (NULL → '_unknown')
    //  - by_engine GROUP BY ocr_engine    (NULL/'' → '_none')
    //  - by_tier   LEFT JOIN document_types, GROUP BY tier (нет типа → '_untyped')
    // Все три ветки используют alias `j` для jobs, чтобы избежать ambiguity
    // при LEFT JOIN'е с document_types (обе таблицы имеют created_at,
    // organization_id, updated_at). Без квалификации Postgres валился с
    // "column reference "created_at" is ambiguous" на by_tier.
    // В jobs.document_type живут обе формы слага ('CMR' и 'cmr') — без
    // канонизации by_type раздваивает строки типа, а by_tier теряет tier у
    // outbound-форм (JOIN по слагу мимо строки каталога 'CMR'). CASE-выражение
    // генерируется из INBOUND_SLUG_ALIASES — второго рукописного списка нет.
    const canonType = `CASE j.document_type ${Object.entries(INBOUND_SLUG_ALIASES)
      .map(([outbound, historical]) => `WHEN '${outbound}' THEN '${historical}'`)
      .join(' ')} ELSE j.document_type END`;
    const byType = await this.groupBreakdown<'slug'>(
      'slug',
      `COALESCE(${canonType}, '_unknown')`,
      'jobs j',
      whereExtra,
      params,
    );
    const byEngine = await this.groupBreakdown<'engine'>(
      'engine',
      `COALESCE(NULLIF(j.ocr_engine, ''), '_none')`,
      'jobs j',
      whereExtra,
      params,
    );
    const byTier = await this.groupBreakdown<'tier'>(
      'tier',
      `COALESCE(dt.tier, '_untyped')`,
      `jobs j LEFT JOIN document_types dt ON ${canonType} = dt.slug`,
      whereExtra,
      params,
    );

    return {
      window_hours: windowHours,
      totals: {
        total,
        pending: Number(t.pending),
        processing: Number(t.processing),
        done: Number(t.done),
        needs_review: Number(t.needs_review),
        failed: Number(t.failed),
        validation_issues: Number(t.validation_issues),
        llm_used: Number(t.llm_used),
      },
      rates: {
        done_rate: total === 0 ? 0 : Number(t.done) / total,
        needs_review_rate: total === 0 ? 0 : Number(t.needs_review) / total,
        failed_rate: total === 0 ? 0 : Number(t.failed) / total,
        validation_issue_rate: total === 0 ? 0 : Number(t.validation_issues) / total,
        llm_fallback_rate: total === 0 ? 0 : Number(t.llm_used) / total,
      },
      latency: {
        p50_ms: t.lat_p50 === null ? null : Math.round(Number(t.lat_p50)),
        p95_ms: t.lat_p95 === null ? null : Math.round(Number(t.lat_p95)),
      },
      llm: {
        tokens_in_p95: t.tok_in_p95 === null ? null : Math.round(Number(t.tok_in_p95)),
        tokens_out_p95: t.tok_out_p95 === null ? null : Math.round(Number(t.tok_out_p95)),
        duration_p95_ms:
          t.llm_dur_p95 === null ? null : Math.round(Number(t.llm_dur_p95)),
      },
      avg_confidence: t.avg_confidence === null ? null : Number(t.avg_confidence),
      throughput_per_hour: total === 0 ? 0 : Math.round((total / windowHours) * 100) / 100,
      by_type: byType,
      by_engine: byEngine,
      by_tier: byTier,
    };
  }

  /**
   * Time-series для дашборд-графиков: сколько документов приходит по
   * времени внутри окна. Автоматически подбирает шаг сетки (bucket_minutes)
   * так, чтобы получилось ~24–30 бакетов — читаемо на десктопном экране.
   *
   * `date_bin(interval, ts, origin)` округляет timestamp к сетке. Origin
   * фиксирован (Unix epoch), чтобы бакеты не «плыли» при повторных
   * вызовах в разные секунды. Пустые бакеты доrisовываем через
   * generate_series — иначе gaps в баре, ось X «сжимается».
   *
   * scope: тот же фильтр что в getOperationalSummary.
   */
  async getTimeseries(
    windowHours: number,
    scope:
      | { kind: 'all' }
      | { kind: 'org'; orgId: string }
      | { kind: 'projects'; projectIds: Set<string> },
  ): Promise<TimeseriesResult> {
    // Пустой projects-scope → пустая сетка (24 нулей), чтобы UI показал
    // ровный график из «ничего», а не падал.
    const bucketMinutes = pickBucketMinutes(windowHours);
    if (scope.kind === 'projects' && scope.projectIds.size === 0) {
      return { window_hours: windowHours, bucket_minutes: bucketMinutes, buckets: [] };
    }

    // Сборка scope-фильтра. windowHours и bucketMinutes → params[0..1].
    const params: unknown[] = [String(windowHours), String(bucketMinutes)];
    const scopeWhere: string[] = [];
    if (scope.kind === 'org') {
      params.push(scope.orgId);
      scopeWhere.push(`organization_id = $${params.length}`);
    } else if (scope.kind === 'projects') {
      params.push(Array.from(scope.projectIds));
      scopeWhere.push(`project_id = ANY($${params.length}::uuid[])`);
    }
    const scopeExtra = scopeWhere.length ? `AND ${scopeWhere.join(' AND ')}` : '';

    // generate_series строит полную сетку бакетов от now()-window до now(),
    // затем LEFT JOIN на агрегаты по jobs. Пустые бакеты остаются с
    // total=0. `date_bin` требует Postgres 14+ (у нас 16).
    const sql = `
      WITH grid AS (
        SELECT gs AS bucket
        FROM generate_series(
          date_bin(($2 || ' minutes')::interval, now() - ($1 || ' hours')::interval, TIMESTAMP 'epoch'),
          date_bin(($2 || ' minutes')::interval, now(), TIMESTAMP 'epoch'),
          ($2 || ' minutes')::interval
        ) AS gs
      ),
      binned AS (
        SELECT
          date_bin(($2 || ' minutes')::interval, created_at, TIMESTAMP 'epoch') AS bucket,
          status,
          finished_at,
          created_at
        FROM jobs
        WHERE created_at > now() - ($1 || ' hours')::interval
        ${scopeExtra}
      ),
      agg AS (
        SELECT
          bucket,
          COUNT(*)::text                                                AS total,
          COUNT(*) FILTER (WHERE status = 'done')::text                 AS done,
          COUNT(*) FILTER (WHERE status = 'needs_review')::text         AS needs_review,
          COUNT(*) FILTER (WHERE status = 'failed')::text               AS failed,
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000
          ) FILTER (WHERE finished_at IS NOT NULL)                      AS lat_p95
        FROM binned
        GROUP BY bucket
      )
      SELECT
        grid.bucket AS ts,
        COALESCE(agg.total, '0')        AS total,
        COALESCE(agg.done, '0')         AS done,
        COALESCE(agg.needs_review, '0') AS needs_review,
        COALESCE(agg.failed, '0')       AS failed,
        agg.lat_p95                      AS lat_p95
      FROM grid
      LEFT JOIN agg ON agg.bucket = grid.bucket
      ORDER BY grid.bucket ASC;
    `;
    const { rows } = await db.query<{
      ts: string;
      total: string;
      done: string;
      needs_review: string;
      failed: string;
      lat_p95: string | null;
    }>(sql, params);

    const buckets: TimeseriesBucket[] = rows.map((r) => ({
      ts: new Date(r.ts).toISOString(),
      total: Number(r.total),
      done: Number(r.done),
      needs_review: Number(r.needs_review),
      failed: Number(r.failed),
      latency_p95_ms: r.lat_p95 === null ? null : Math.round(Number(r.lat_p95)),
    }));

    return { window_hours: windowHours, bucket_minutes: bucketMinutes, buckets };
  }

  /**
   * Один per-group breakdown для operational-сводки. Метрики идентичны
   * для всех разрезов (by_type / by_engine / by_tier) — отличается только
   * выражение группы (`groupExpr`) и FROM/JOIN (`from`). WHERE и params
   * приходят снаружи, чтобы window+scope-фильтр был тем же, что у totals.
   *
   * **Квалификация `j.*` обязательна только для by_tier** (LEFT JOIN
   * document_types, у которого есть overlap: created_at, organization_id,
   * updated_at). by_type/by_engine — без JOIN'а, ambiguity невозможна. Но
   * держим `j.*` во всех трёх для единообразия и чтобы при добавлении новых
   * JOIN'ов автор не наступил на тот же баг (был созревшим с UI-7, коммит
   * `b4e3ca3`).
   *
   * `groupExpr` и `from` — статические литералы из вызывающего кода (не
   * user-input), параметризуется только window/scope через `params`.
   */
  private async groupBreakdown<K extends string>(
    keyAlias: K,
    groupExpr: string,
    from: string,
    whereExtra: string,
    params: unknown[],
  ): Promise<OperationalGroupRow<K>[]> {
    const sql = `
      SELECT
        ${groupExpr}                                                  AS grp,
        COUNT(*)::text                                                AS total,
        COUNT(*) FILTER (WHERE j.status = 'done')::text               AS done,
        COUNT(*) FILTER (WHERE j.status = 'needs_review')::text       AS needs_review,
        COUNT(*) FILTER (WHERE j.status = 'failed')::text             AS failed,
        COUNT(*) FILTER (
          WHERE j.extracted ? '_issues'
            AND jsonb_array_length(COALESCE(j.extracted->'_issues','[]'::jsonb)) > 0
        )::text                                                       AS validation_issues,
        COUNT(*) FILTER (WHERE j.last_llm_call IS NOT NULL)::text     AS llm_used,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (j.finished_at - j.created_at)) * 1000
        ) FILTER (WHERE j.finished_at IS NOT NULL)                    AS lat_p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (j.finished_at - j.created_at)) * 1000
        ) FILTER (WHERE j.finished_at IS NOT NULL)                    AS lat_p95,
        AVG(j.confidence) FILTER (WHERE j.status IN ('done','needs_review'))::text AS avg_confidence
      FROM ${from}
      WHERE j.created_at >= now() - ($1 || ' hours')::interval
        ${whereExtra}
      GROUP BY 1
      ORDER BY COUNT(*) DESC, grp ASC
    `;
    const res = await db.query<{
      grp: string;
      total: string;
      done: string;
      needs_review: string;
      failed: string;
      validation_issues: string;
      llm_used: string;
      lat_p50: string | null;
      lat_p95: string | null;
      avg_confidence: string | null;
    }>(sql, params);

    return res.rows.map((r) => {
      const tot = Number(r.total);
      const row = {
        [keyAlias]: r.grp,
        total: tot,
        done: Number(r.done),
        needs_review: Number(r.needs_review),
        failed: Number(r.failed),
        validation_issues: Number(r.validation_issues),
        llm_used: Number(r.llm_used),
        latency_p50_ms: r.lat_p50 === null ? null : Math.round(Number(r.lat_p50)),
        latency_p95_ms: r.lat_p95 === null ? null : Math.round(Number(r.lat_p95)),
        avg_confidence: r.avg_confidence === null ? null : Number(r.avg_confidence),
        // Pre-computed rates — UI не пересчитывает.
        done_rate: tot === 0 ? 0 : Number(r.done) / tot,
        needs_review_rate: tot === 0 ? 0 : Number(r.needs_review) / tot,
        failed_rate: tot === 0 ? 0 : Number(r.failed) / tot,
        validation_issue_rate: tot === 0 ? 0 : Number(r.validation_issues) / tot,
        llm_fallback_rate: tot === 0 ? 0 : Number(r.llm_used) / tot,
      };
      return row as OperationalGroupRow<K>;
    });
  }

  /**
   * Собирает WHERE-условия и параметры для `list` / `count`. Возвращает
   * `{ where, params }`, где `params` ещё не содержит limit/offset.
   * Идентичные условия для обеих операций — общая правда о фильтрах.
   */
  private buildJobsFilter(filters: ListFilters): { where: string[]; params: unknown[] } {
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
    if (filters.document_types && filters.document_types.length > 0) {
      params.push(filters.document_types);
      where.push(`document_type = ANY($${params.length})`);
    }
    if (filters.format && filters.format.length > 0) {
      // Статические предикаты (пользовательский ввод в SQL не попадает —
      // значения прошли z.enum). Несколько форматов — OR.
      where.push(`(${filters.format.map((f) => FORMAT_PREDICATES[f]).join(' OR ')})`);
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
    if (filters.q && filters.q.trim().length >= 1) {
      // Quick-search: ILIKE по file_name + prefix-match по id (UUID
      // приводим к text, чтобы LIKE работал). Для INN — поиск в JSONB,
      // если q состоит только из цифр и достаточно длинный.
      const q = filters.q.trim();
      const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like);
      const likeIdx = params.length;
      params.push(`${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      const idPrefixIdx = params.length;
      const clauses: string[] = [
        `file_name ILIKE $${likeIdx}`,
        `id::text ILIKE $${idPrefixIdx}`,
      ];
      // Если q — цифры (≥6 символов): пробуем как INN в extracted.
      // Узкий список ключей — не сканируем весь JSONB.
      const isDigits = /^\d{6,}$/.test(q);
      if (isDigits) {
        params.push(q);
        const innIdx = params.length;
        clauses.push(`extracted->>'seller_inn' = $${innIdx}`);
        clauses.push(`extracted->>'buyer_inn' = $${innIdx}`);
        clauses.push(`extracted->>'inn' = $${innIdx}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    return { where, params };
  }

  async list(filters: ListFilters): Promise<JobRow[]> {
    const { where, params } = this.buildJobsFilter(filters);
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
   * Считает total для пагинации / UI-табов («Done 9», «Needs review 3»).
   * Использует те же фильтры что `list`, но без limit/offset.
   * Возвращает number (BIGINT → парсим вручную, pg по умолчанию
   * отдаёт строку для bigint, но count(*) у нас всегда влезает в int).
   */
  async count(filters: Omit<ListFilters, 'limit' | 'offset'>): Promise<number> {
    const { where, params } = this.buildJobsFilter({
      ...filters,
      // count не использует limit/offset, передаём фиктивные чтобы тип
      // ListFilters не ругался
      limit: 0,
      offset: 0,
    } as ListFilters);
    const sql = `SELECT COUNT(*)::bigint AS c FROM jobs
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const { rows } = await db.query<{ c: string }>(sql, params);
    return Number(rows[0]?.c ?? 0);
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
    // Phase A: нормализуем legacy positions/services → канонический items[]
    // для всех читателей API (UI, integrations, Resolution Engine).
    // Старые job'ы написанные до миграции получают унифицированную форму
    // без перезаписи в БД.
    const normalized = normalizeExtracted(extracted);
    const cost = computeJobCost(
      {
        llmUsage: row.llm_usage,
        ocrEngine: row.ocr_engine,
        ocrPages: row.ocr_pages,
        documentType: row.document_type,
      },
      config.cost,
      COST_TABLE_TYPES,
    );
    return {
      job_id: row.id,
      status: row.status,
      // 2026-05-18 (SLAI Issue #3): outbound-нормализация слагов.
      // Исторические TTN/UPD/CMR/AKT/factInvoice конвертируются в
      // lowercase snake_case (ttn/upd/cmr/services_act/tax_invoice).
      // Внутри БД и pipeline'а слаги остаются как были — это только
      // фасад наружу. См. types/slug-normalize.ts header.
      document_type: normalizeSlugForApi(row.document_type),
      document_hint: normalizeSlugForApi(row.document_hint),
      confidence: row.confidence === null ? null : Number(row.confidence),
      ocr_engine: row.ocr_engine,
      raw_text: row.raw_text,
      extracted: normalized,
      // Кол-во бизнес-полей верхнего уровня в extracted (без служебных `_*`).
      // UI-таблица показывает как быстрый индикатор глубины разбора —
      // помогает отличить «модель уверена но заполнено 0» от «уверена И
      // с полями». Считается на границе toApi чтобы не хранить дубль в БД.
      extracted_fields_count: normalized ? countBusinessFields(normalized) : 0,
      // Оценка стоимости разбора ₽ (owner-запрос 2026-07-13). Считается на
      // границе toApi из фактического расхода (llm_usage + ocr_pages) × ставки
      // config.cost. cost_estimate=true → неполно, UI показывает «≥».
      cost_rub: cost.rub,
      cost_estimate: cost.estimate,
      validation_issues: issues,
      // EXT-B: вычищаем reserved-ключ _inline_llm_creds (encrypted BYO-envelope)
      // из любого outbound-представления job'а — он не должен светиться в API.
      metadata: stripInlineCredentials(row.metadata),
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size: Number(row.file_size),
      error: row.error,
      last_llm_call: row.last_llm_call,
      pipeline_steps: row.pipeline_steps ?? [],
      // Production LLM classifier: трасса «почему этот тип» для UI. null для
      // legacy jobs до внедрения (миграция 20260701000002).
      classification: row.classification ?? null,
      organization_id: row.organization_id,
      project_id: row.project_id,
      created_by_user_id: row.created_by_user_id,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    };
  }

  /**
   * A4 sweeper: jobs у которых webhook не доставлен и последняя попытка
   * была достаточно давно. Sweeper вызывает deliverWebhook() без сброса
   * счётчика — попытки накапливаются до hardLimit (жёсткого потолка).
   *
   * Условия выборки:
   *   - webhook_url задан (иначе нечего доставлять)
   *   - webhook_delivered_at IS NULL (ещё не доставлен)
   *   - webhook_last_error IS NOT NULL (реально пробовали и упало)
   *   - webhook_attempts < hardLimit (не превысили суммарный лимит)
   *   - status IN ('done', 'needs_review') — только терминальные
   *   - updated_at старше graceMinutes — grace period для backoff-цикла
   */
  async listStaleWebhooks(params: {
    graceMinutes: number;
    hardLimit: number;
    limit?: number;
  }): Promise<JobRow[]> {
    const { rows } = await db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE webhook_url IS NOT NULL
         AND webhook_delivered_at IS NULL
         AND webhook_last_error IS NOT NULL
         AND webhook_attempts < $1
         AND status IN ('done', 'needs_review')
         AND updated_at < now() - make_interval(mins => $2)
       ORDER BY updated_at ASC
       LIMIT $3`,
      [params.hardLimit, params.graceMinutes, params.limit ?? 50],
    );
    return rows;
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
