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

// --- GET /jobs (list with filters) ---

export const ListJobsQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  document_type: DocumentTypeSlugSchema.optional(),
  organization_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  from: z.string().datetime().optional().describe('ISO 8601, нижняя граница created_at'),
  to: z.string().datetime().optional().describe('ISO 8601, верхняя граница created_at'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ListJobsResponse = z.object({
  items: z.array(Job),
  limit: z.number(),
  offset: z.number(),
});

// --- Health & readiness ---

export const HealthResponse = z.object({
  status: z.literal('ok'),
});

export const ReadyResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  error: z.string().optional(),
});
