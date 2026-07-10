/**
 * Zod schemas for the public HTTP API.
 *
 * These are wired into Fastify routes via `fastify-type-provider-zod`,
 * so a single declaration covers three things at once:
 *   - Runtime validation of incoming params/query/body.
 *   - TypeScript types for the route handler (req.params/req.query/req.body
 *     are inferred from the schema).
 *   - OpenAPI schema generation for the Swagger UI.
 *
 * For multipart/form-data uploads (POST /jobs), zod can't model streamed
 * file fields — that route uses a hand-written JSON Schema in its options.
 */

import { z } from 'zod';
import { JOB_STATUSES, OCR_ENGINES } from './documents.js';

/**
 * document_type / document_hint раньше были z.enum из шести builtin'ов.
 * После того, как платформа стала принимать произвольные пользовательские
 * типы (Document Type Registry в БД), API принимает любой непустой
 * slug-string. Формат проверяется тем же regex'ом, что и в роуте jobs.ts
 * для входящих хинтов.
 */
const DocumentTypeSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

// --- Shared building blocks ---

export const JobIdParam = z.object({
  id: z.string().uuid().describe('Идентификатор задачи (UUID)'),
});

export const ErrorResponse = z
  .object({
    error: z.union([z.string(), z.record(z.unknown())]).describe('Описание ошибки'),
    error_code: z
      .string()
      .optional()
      .describe('Машиночитаемый код ошибки (например BYO_LLM_DISABLED, PASSWORD_REQUIRED)'),
  })
  .describe('Стандартная форма ошибки');

// --- Job representation in API responses ---

export const Job = z
  .object({
    job_id: z.string().uuid(),
    status: z.enum(JOB_STATUSES),
    document_type: DocumentTypeSlugSchema.nullable(),
    document_hint: DocumentTypeSlugSchema.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    ocr_engine: z.enum(OCR_ENGINES).nullable(),
    raw_text: z.string().nullable().describe('Распознанный текст; null до завершения OCR'),
    extracted: z
      .record(z.unknown())
      .nullable()
      .describe('Структурированные данные по схеме типа документа'),
    extracted_fields_count: z
      .number()
      .int()
      .min(0)
      .describe(
        'Число заполненных бизнес-полей верхнего уровня в extracted (без служебных `_*`). ' +
        'Помогает UI-таблице отличить «уверенно 0 полей» (extract-фейл) от «низкая уверенность но 20 полей».',
      ),
    validation_issues: z
      .array(z.string())
      .describe(
        'Доменные проблемы, найденные в extracted: невалидный ИНН/КПП, нестыковка НДС, неправдоподобная дата, неверный госномер и т.п. Пустой массив = всё ок.',
      ),
    metadata: z
      .record(z.unknown())
      .nullable()
      .describe('Произвольный JSON, переданный клиентом при создании задачи'),
    last_llm_call: z
      .object({
        prompt: z.string(),
        raw_response: z.string(),
        model: z.string(),
        backend: z.string(),
        duration_ms: z.number().optional(),
        prompt_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .nullable()
      .describe(
        'Дебаг-трасса последнего LLM-вызова при обработке этого job: финальный prompt и сырой ответ модели до парсинга. Заполнено только если парсер реально ходил в LLM.',
      ),
    pipeline_steps: z
      .array(
        z.object({
          step: z.string(),
          status: z.enum(['started', 'done', 'failed', 'skipped']),
          at: z.string(),
          duration_ms: z.number().optional(),
          details: z.record(z.unknown()).optional(),
        }),
      )
      .default([])
      .describe(
        'Хронологический след этапов обработки: upload, classify, ocr.<engine>, parse.<kind>, validate, resolve, finalize. ' +
        'Используется UI для живого прогресса и пост-мортема при ошибках.',
      ),
    classification: z
      .object({
        type: DocumentTypeSlugSchema.nullable(),
        confidence: z.number().min(0).max(1),
        method: z.enum(['llm', 'keyword', 'filename', 'fallback', 'hint']),
        duration_ms: z.number().int().nonnegative().nullable(),
        llm_said: z.string().nullable(),
        keyword_said: z
          .object({ type: DocumentTypeSlugSchema, score: z.number() })
          .nullable(),
        candidates: z.array(z.object({ type: DocumentTypeSlugSchema, score: z.number() })),
        unknown: z.boolean(),
      })
      .nullable()
      .describe(
        'Трасса LLM-классификатора: как выбран тип (method), что сказал keyword-prior (keyword_said) и LLM (llm_said), ' +
        'кандидаты, время classify-вызова, флаг «не опознан» (unknown). null для legacy jobs до внедрения.',
      ),
    organization_id: z.string().uuid(),
    project_id: z.string().uuid(),
    created_by_user_id: z.string().uuid().nullable(),
    file_name: z.string(),
    mime_type: z.string(),
    file_size: z.number().int().nonnegative().describe('Размер исходного файла в байтах'),
    error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .describe('Задача обработки документа');
export type ApiJob = z.infer<typeof Job>;

// --- POST /jobs (response only — body is multipart) ---

export const CreateJobResponse = z.object({
  job_id: z.string().uuid(),
  status: z.enum(JOB_STATUSES),
});

// --- PATCH /jobs/:id/extracted ---

export const ExtractedPatchBody = z
  .record(z.unknown())
  .describe('Произвольные поля, перезаписывающие текущее extracted целиком');

// --- POST/GET /jobs/:id/feedback (внешний фидбек о качестве извлечения) ---

/**
 * Вердикт потребителя о качестве извлечения. Старт простой — уровень
 * документа; field-level детализация идёт в опциональном `fields[]`.
 */
export const FeedbackVerdictSchema = z.enum(['correct', 'partial', 'incorrect']);

export const CreateFeedbackBody = z
  .object({
    verdict: FeedbackVerdictSchema.describe('Оценка извлечения: correct | partial | incorrect'),
    comment: z
      .string()
      .max(2000)
      .optional()
      .describe('Свободный комментарий потребителя (до 2000 символов)'),
    // Намеренно loose (passthrough) — задел под field-level детализацию.
    // Не переусложняем схему сейчас; форму нормализуем при анализе.
    fields: z
      .array(z.object({ path: z.string() }).passthrough())
      .optional()
      .describe('Опц. детализация по полям: [{ path, note?, correct_value? }]'),
    rated_by: z
      .string()
      .max(200)
      .optional()
      .describe('Опц. идентификатор конечного пользователя на стороне внешней системы'),
  })
  .describe('Внешний фидбек о качестве извлечения по job');

export const Feedback = z
  .object({
    id: z.string(),
    job_id: z.string().uuid(),
    source_system: z.string().describe('Кто прислал оценку (из авторизованного ключа, не из тела)'),
    verdict: FeedbackVerdictSchema,
    comment: z.string().nullable(),
    fields: z.array(z.record(z.unknown())).nullable(),
    rated_by: z.string().nullable(),
    created_at: z.string(),
  })
  .describe('Запись внешнего фидбека');

export const ListFeedbackResponse = z.object({
  items: z.array(Feedback),
});

/**
 * Запись внутреннего леджера ручных правок операторов
 * (extraction_corrections). Каждое изменённое поле — before→after по
 * dot-path. Сырьё для петли улучшения; на сам job не влияет.
 */
export const ExtractionCorrection = z
  .object({
    id: z.string(),
    job_id: z.string().uuid(),
    document_type: z.string().nullable(),
    field_path: z.string(),
    value_before: z.string().nullable(),
    value_after: z.string().nullable(),
    source_system: z.string().nullable(),
    corrected_by: z.string().nullable(),
    created_at: z.string(),
  })
  .describe('Запись ручной правки оператора (before→after по полю)');

export const ListCorrectionsResponse = z.object({
  items: z.array(ExtractionCorrection),
});

// --- GET /jobs (list with filters) ---

/**
 * Формат исходного файла — фильтр «Формат» в журнале. Маппится на
 * mime-предикаты в storage/jobs.ts (buildJobsFilter). `x-cfb` (OLE-контейнер,
 * общий для legacy .xls и .doc) разводится по расширению file_name — та же
 * логика, что у роутинга OCR-движков.
 */
export const FILE_FORMATS = ['pdf', 'excel', 'word', 'image', 'xml', 'other'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export const ListJobsQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  document_type: DocumentTypeSlugSchema.optional(),
  /**
   * Несколько типов сразу (OR), через запятую: `invoice,factInvoice,UPD`.
   * Дополняет одиночный document_type (back-compat); если клиент задал оба —
   * применяются оба предиката (AND), делать так не стоит.
   */
  document_types: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .transform((s) => s.split(',').map((t) => t.trim()).filter((t) => t.length > 0))
    .pipe(z.array(DocumentTypeSlugSchema).min(1).max(60))
    .optional()
    .describe('Список slug-типов через запятую (OR)'),
  /** Формат(ы) исходного файла, через запятую (OR): `excel,word`. */
  format: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .transform((s) => s.split(',').map((t) => t.trim()).filter((t) => t.length > 0))
    .pipe(z.array(z.enum(FILE_FORMATS)).min(1).max(FILE_FORMATS.length))
    .optional()
    .describe('Формат(ы) исходного файла через запятую (OR)'),
  organization_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  from: z.string().datetime().optional().describe('ISO 8601, нижняя граница created_at'),
  to: z.string().datetime().optional().describe('ISO 8601, верхняя граница created_at'),
  /**
   * Quick-search free-text. Ищем по:
   *   - file_name (ILIKE %q%)
   *   - id (префикс — для shortId-копипасты типа `a8f3c2…`)
   *   - extracted.{seller_inn, buyer_inn, contract_number, ...} —
   *     только когда q выглядит как INN (≥6 цифр) или как номер договора.
   *
   * Минимум 2 символа, иначе фильтр игнорируется (защита от случайного
   * полного скана при пустом инпуте).
   */
  q: z.string().trim().min(1).max(120).optional().describe('Free-text quick search'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /jobs/:id/sheets — превью листов Excel (грид ячеек по листам).
export const SheetsResponse = z.object({
  file_name: z.string(),
  sheets: z.array(
    z.object({
      name: z.string(),
      rows: z.array(z.array(z.string())),
      totalRows: z.number(),
      totalCols: z.number(),
      truncated: z.boolean(),
    }),
  ),
});

export const ListJobsResponse = z.object({
  items: z.array(Job),
  limit: z.number(),
  offset: z.number(),
  /**
   * Полное число записей подходящих под фильтр (без учёта limit/offset).
   * Нужен UI-у для отображения «15 of 1284 rows» и tab-счётчиков по
   * статусам. Optional для backward-compat: старые клиенты не сломаются
   * от появления нового поля, новые — fallback'аются на items.length
   * если total отсутствует.
   */
  total: z.number().int().nonnegative().optional(),
});

// --- Health & readiness ---

export const HealthResponse = z.object({
  status: z.literal('ok'),
});

export const ReadyResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  error: z.string().optional(),
});
