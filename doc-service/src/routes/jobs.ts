import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { unlink } from 'node:fs/promises';
import { config } from '../config.js';
import {
  ACCEPTED_DOCUMENT_MIMES,
  detectFileType,
  localFileStorage,
} from '../storage/files.js';
import { jobsRepo } from '../storage/jobs.js';
import { docQueue } from '../queue.js';
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
import { validateExtractedWithResolver } from '../pipeline/validation/index.js';

function isValidWebhookUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Pull the Idempotency-Key header from a request. Returns the validated key
 * or `null` when the header is absent. Throws a `{ status, message }`-shaped
 * object when the header IS present but malformed — gives the route handler
 * a clean error path.
 *
 * Validation rules:
 *   - 1..64 characters (longer = likely abuse or accidental UUID-with-prefix)
 *   - alphanumeric / dash / underscore / dot — covers UUIDs, ULIDs, base64-
 *     friendly randoms; rejects whitespace, control chars, weird unicode.
 */
export function readIdempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers['idempotency-key'];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw { status: 400, message: 'Idempotency-Key must be a single string header' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 64) {
    throw { status: 400, message: 'Idempotency-Key must be ≤ 64 characters' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw { status: 400, message: 'Idempotency-Key may contain only [A-Za-z0-9._-]' };
  }
  return trimmed;
}

/** PostgreSQL unique_violation SQLSTATE. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
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
          'Принимает PDF, JPG, PNG, BMP, TIFF, WebP. Возвращает идентификатор задачи.',
          'Обработка асинхронная — статус опрашивайте через GET /jobs/:id или подпишитесь webhook_url.',
          '',
          'Поля multipart/form-data:',
          '- **file** (binary, обязательно) — сам документ. Тип проверяется по magic-bytes.',
          '- **webhook_url** (string, опционально) — куда POST-нуть результат; тело подписывается HMAC-SHA256',
          '- **document_hint** (string, опционально) — invoice|factInvoice|UPD|TTN|CMR|AKT',
          '- **metadata** (string, опционально) — JSON-строка, echo обратно в ответе и webhook',
          '',
          'Заголовки:',
          '- **Idempotency-Key** (string, опционально, 1..64 символа, [A-Za-z0-9._-]) — если для этого ключа уже есть задача, ' +
            'возвращается её состояние с HTTP 200 и заголовком `Idempotency-Replayed: 1`. Защита от ретраев клиента.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        response: {
          200: CreateJobResponse,
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

      // --- 1. Idempotency-Key (header) ---
      // Read & validate FIRST, before we consume the multipart stream. If a
      // job already exists for this key, return 200 with the existing
      // ids and short-circuit — saves disk + queue cycles for client retries.
      let idempotencyKey: string | null;
      try {
        idempotencyKey = readIdempotencyKey(req.headers);
      } catch (e) {
        const { status, message } = e as { status: number; message: string };
        reply.code(status);
        return { error: message };
      }
      if (idempotencyKey) {
        const existing = await jobsRepo.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          // 200 (not 202) signals "you already have this".
          reply.code(200);
          reply.header('idempotency-replayed', '1');
          return { job_id: existing.id, status: existing.status };
        }
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

      // --- Magic-bytes content-type check ---
      // The multipart Content-Type is client-supplied; we don't trust it.
      // Inspect the file's leading bytes to confirm it's actually one of
      // the document formats we can OCR. Defence against:
      //   - innocent extension/MIME mismatch (.pdf with image/jpeg header)
      //   - active abuse (random binary, exe, encrypted blob)
      // Detected MIME wins over declared MIME — feeds the OCR router with
      // ground truth.
      const detected = await detectFileType(savedFile.absolutePath);
      if (!detected || !ACCEPTED_DOCUMENT_MIMES.has(detected.mime)) {
        await unlink(savedFile.absolutePath).catch(() => undefined);
        reply.code(400);
        return {
          error:
            `file content is not one of the accepted document types ` +
            `(PDF, JPEG, PNG, BMP, TIFF, WebP). Detected: ${detected?.mime ?? 'unknown'}`,
        };
      }
      if (detected.mime !== savedFile.mimeType) {
        req.log.info(
          { declared: savedFile.mimeType, detected: detected.mime, file_path: savedFile.absolutePath },
          'multipart mime mismatch; using detected as authoritative',
        );
        savedFile = { ...savedFile, mimeType: detected.mime };
      }

      if (webhookUrl && !isValidWebhookUrl(webhookUrl)) {
        reply.code(400);
        return { error: 'webhook_url must be http(s) URL' };
      }

      // Хинт от клиента может быть любым slug'ом — builtin (один из шести)
      // или пользовательский тип из Document Type Registry. Валидируем
      // только формат, наличие проверять в БД не делаем (это лишний
      // round-trip; если slug не найдётся, оркестратор спокойно
      // деградирует к классификации/generic-парсеру).
      if (documentHint && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(documentHint)) {
        reply.code(400);
        return {
          error: 'document_hint must be 1-64 chars, [A-Za-z0-9_-], starting with alphanumeric',
        };
      }

      let job;
      try {
        job = await jobsRepo.create({
          fileName: savedFile.fileName,
          filePath: savedFile.absolutePath,
          fileSize: savedFile.size,
          mimeType: savedFile.mimeType,
          documentHint: documentHint ?? null,
          webhookUrl: webhookUrl ?? null,
          metadata: metadata ?? null,
          idempotencyKey,
        });
      } catch (err) {
        // Idempotency-Key race: another request inserted the same key
        // between our `findByIdempotencyKey` check above and this INSERT.
        // The UNIQUE index makes that visible as a 23505 violation —
        // resolve by returning the row the other request created and
        // discarding the file we just saved (now redundant).
        if (idempotencyKey && isUniqueViolation(err)) {
          const existing = await jobsRepo.findByIdempotencyKey(idempotencyKey);
          if (existing) {
            await unlink(savedFile.absolutePath).catch(() => undefined);
            reply.code(200);
            reply.header('idempotency-replayed', '1');
            return { job_id: existing.id, status: existing.status };
          }
        }
        throw err;
      }

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
        const issues = await validateExtractedWithResolver(
          sanitizedBody,
          job.document_type,
          req.log,
        );
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
