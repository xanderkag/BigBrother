import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { unlink } from 'node:fs/promises';
import { config } from '../config.js';
import { localFileStorage } from '../storage/files.js';
import { jobsRepo } from '../storage/jobs.js';
import { docQueue } from '../queue.js';
import { DOCUMENT_TYPES } from '../types/documents.js';
import {
  CreateJobResponse,
  ErrorResponse,
  ExtractedPatchBody,
  Job,
  JobIdParam,
  ListJobsQuery,
  ListJobsResponse,
} from '../types/api-schemas.js';
import { bearerAuthHook } from '../auth.js';
import { validateExtracted } from '../pipeline/validation/index.js';
import type { DocumentType } from '../types/documents.js';

function isValidWebhookUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function jobsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Bearer auth for every /api/v1/* route registered in this plugin scope.
  // /health and /ready live in a sibling plugin and stay public.
  r.addHook('onRequest', bearerAuthHook);

  // POST /jobs — multipart upload + enqueue.
  //
  // No `body` schema attached: the zod validator/serializer compilers
  // can't process raw multipart streams, and raw JSON Schema bodies would
  // crash the zod validator at request time. The multipart description
  // for OpenAPI is injected post-hoc via `transformObject` in server.ts
  // — Swagger UI still shows the file-upload form correctly.
  r.post(
    '/jobs',
    {
      schema: {
        tags: ['jobs'],
        operationId: 'createJob',
        summary: 'Загрузить документ на обработку (multipart/form-data)',
        description: [
          'Принимает PDF, JPG, PNG, BMP или TIFF. Возвращает идентификатор задачи.',
          'Обработка асинхронная — статус опрашивайте через GET /jobs/:id или подпишитесь webhook_url.',
          '',
          'Поля multipart/form-data:',
          '- **file** (binary, обязательно) — сам документ',
          '- **webhook_url** (string, опционально) — куда POST-нуть результат; тело подписывается HMAC-SHA256',
          '- **document_hint** (string, опционально) — invoice|factInvoice|UPD|TTN|CMR|AKT',
          '- **metadata** (string, опционально) — JSON-строка, echo обратно в ответе и webhook',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        response: {
          202: CreateJobResponse,
          400: ErrorResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req: FastifyRequest, reply) => {
      if (!req.isMultipart()) {
        reply.code(400);
        return { error: 'multipart/form-data required' };
      }

      let savedFile: Awaited<ReturnType<typeof localFileStorage.saveStream>> | null = null;
      let webhookUrl: string | undefined;
      let documentHint: string | undefined;
      let metadata: unknown;

      for await (const part of req.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          savedFile = await localFileStorage.saveStream({
            filename: part.filename,
            mimeType: part.mimetype,
            stream: part.file,
          });
        } else if (part.type === 'field') {
          const value = typeof part.value === 'string' ? part.value : '';
          if (part.fieldname === 'webhook_url') webhookUrl = value;
          else if (part.fieldname === 'document_hint') documentHint = value;
          else if (part.fieldname === 'metadata') {
            // Pre-parse size cap — protects against pinning huge blobs to
            // every job row in JSONB. Check raw bytes since the parsed
            // representation might lose whitespace but still be unbounded.
            if (Buffer.byteLength(value, 'utf8') > config.maxMetadataBytes) {
              reply.code(400);
              return {
                error: `metadata exceeds ${config.maxMetadataBytes} bytes`,
              };
            }
            try {
              metadata = JSON.parse(value);
            } catch {
              reply.code(400);
              return { error: 'metadata must be valid JSON' };
            }
          }
        }
      }

      if (!savedFile) {
        reply.code(400);
        return { error: 'file field is required' };
      }

      // Empty file usually means a misconfigured client (curl forgot -F, browser
      // form sent empty input). Reject early so the worker doesn't waste time
      // OCR'ing nothing and the storage doesn't accumulate zero-byte stubs.
      if (savedFile.size === 0) {
        await unlink(savedFile.absolutePath).catch(() => undefined);
        reply.code(400);
        return { error: 'uploaded file is empty' };
      }

      if (webhookUrl && !isValidWebhookUrl(webhookUrl)) {
        reply.code(400);
        return { error: 'webhook_url must be http(s) URL' };
      }

      if (
        documentHint &&
        !DOCUMENT_TYPES.includes(documentHint as (typeof DOCUMENT_TYPES)[number])
      ) {
        reply.code(400);
        return { error: `document_hint must be one of ${DOCUMENT_TYPES.join(', ')}` };
      }

      const job = await jobsRepo.create({
        fileName: savedFile.fileName,
        filePath: savedFile.absolutePath,
        fileSize: savedFile.size,
        mimeType: savedFile.mimeType,
        documentHint: (documentHint as (typeof DOCUMENT_TYPES)[number]) ?? null,
        webhookUrl: webhookUrl ?? null,
        metadata: metadata ?? null,
      });

      // Propagate the HTTP request id into the BullMQ payload so the worker
      // can bind it to its child logger. The BullMQ jobId is the same as our
      // domain jobId — gives us idempotent enqueue (a retry of POST with the
      // same row inserted wouldn't create a duplicate Bull job).
      await docQueue.add(
        'process',
        { jobId: job.id, requestId: req.id },
        { jobId: job.id },
      );

      reply.code(202);
      return { job_id: job.id, status: job.status };
    },
  );

  // GET /jobs/:id
  r.get(
    '/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Получить статус и результат задачи',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
        response: {
          200: Job,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const job = await jobsRepo.findById(req.params.id);
      if (!job) {
        reply.code(404);
        return { error: 'job not found' };
      }
      return jobsRepo.toApi(job);
    },
  );

  // PATCH /jobs/:id/extracted — manual correction, transitions to "done"
  r.patch(
    '/jobs/:id/extracted',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Перезаписать поле extracted (ручная корректировка)',
        description:
          'Полностью заменяет текущий extracted; статус переходит в "done", фиксируется extracted_corrected_at.',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
        body: ExtractedPatchBody,
        response: {
          200: Job,
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      // Re-run domain validation on the corrected payload so validation_issues
      // reflect the human's edits (they may have fixed the very issues that
      // sent the job to needs_review). _issues is stripped from the user's
      // body — it's a server-managed field, not user input.
      const job = await jobsRepo.findById(req.params.id);
      if (!job) {
        reply.code(404);
        return { error: 'job not found' };
      }

      const sanitizedBody: Record<string, unknown> = { ...req.body };
      delete sanitizedBody._issues;

      if (job.document_type) {
        const issues = validateExtracted(sanitizedBody, job.document_type as DocumentType);
        if (issues.length > 0) sanitizedBody._issues = issues;
      }

      const updated = await jobsRepo.applyExtractedCorrection(req.params.id, sanitizedBody);
      if (!updated) {
        reply.code(404);
        return { error: 'job not found' };
      }
      return jobsRepo.toApi(updated);
    },
  );

  // GET /jobs — list with filters
  r.get(
    '/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Список задач с фильтрами и пагинацией',
        security: [{ bearerAuth: [] }],
        querystring: ListJobsQuery,
        response: {
          200: ListJobsResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req) => {
      const items = await jobsRepo.list(req.query);
      return {
        items: items.map((j) => jobsRepo.toApi(j)),
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );
}
