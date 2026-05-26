import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import {
  ACCEPTED_DOCUMENT_MIMES,
  detectFileType,
  fileStorage,
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
import { runDocumentPipeline } from '../pipeline/orchestrator.js';
import { combineConfidence } from '../pipeline/quality.js';
import { projectsRepo } from '../storage/projects.js';
import { sanitizeMetadata } from '../storage/metadata-sanitizer.js';
import { SYSTEM_DEFAULT_ORG_ID, SYSTEM_DEFAULT_PROJECT_ID } from '../auth.js';
import { deliverWebhook } from '../webhooks/deliver.js';
import { normalizeSlugForApi } from '../types/slug-normalize.js';
import {
  getEffectiveScope,
  requireProjectAccess,
  requireProjectWrite,
} from '../authz.js';
import {
  readInlineCredHeaders,
  encryptInlineCredentials,
  stripInlineCredentials,
  INLINE_CREDS_METADATA_KEY,
} from '../pipeline/llm/inline-credentials.js';

/**
 * SHA-256 stream-hash файла. Используется для idempotent-кэша:
 * если этот же файл уже обрабатывался в той же организации за
 * последние N часов — возвращаем кэшированный job_id без новой
 * пайплайн-обработки.
 *
 * Stream через node:stream.pipeline — не загружаем весь файл в
 * память (важно для PDF на сотни MB).
 */
async function computeFileSha256(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(absolutePath), hash);
  return hash.digest('hex');
}

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

      let savedFile: Awaited<ReturnType<typeof fileStorage.saveStream>> | null = null;
      let webhookUrl: string | undefined;
      let documentHint: string | undefined;
      let metadata: unknown;
      // Tenant scope от клиента — опциональные multipart-поля. Если не заданы,
      // ниже падёт в default project текущего пользователя.
      let projectId: string | undefined;
      let organizationId: string | undefined;
      // F4: PII redaction может прийти как query-param (?redact_pii=true) или
      // как поле multipart (`redact_pii`). Любая truthy-строка включает.
      // Результат запоминаем в metadata.redact_pii — orchestrator его читает
      // при отправке webhook'а и редактирует extracted/metadata перед уходом
      // наружу. БД остаётся не редактированной (для аудита).
      const queryRedact = (req.query as Record<string, unknown> | undefined)?.redact_pii;
      let redactPiiFlag =
        queryRedact === 'true' || queryRedact === '1' || queryRedact === true;

      for await (const part of req.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          savedFile = await fileStorage.saveStream({
            filename: part.filename,
            mimeType: part.mimetype,
            stream: part.file,
          });
        } else if (part.type === 'field') {
          const value = typeof part.value === 'string' ? part.value : '';
          if (part.fieldname === 'webhook_url') webhookUrl = value;
          else if (part.fieldname === 'document_hint') documentHint = value;
          else if (part.fieldname === 'project_id') projectId = value;
          else if (part.fieldname === 'organization_id') organizationId = value;
          else if (part.fieldname === 'redact_pii') {
            redactPiiFlag = value === 'true' || value === '1';
          }
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

      // --- Резолвим tenant scope ---
      // Если клиент явно указал project_id — используем его (валидируя
      // что проект существует). Иначе берём default из user-контекста
      // (SYSTEM_DEFAULT_PROJECT_ID для super_admin'а).
      let scopeOrgId: string;
      let scopeProjectId: string;
      if (projectId) {
        const project = await projectsRepo.findById(projectId);
        if (!project) {
          await unlink(savedFile.absolutePath).catch(() => undefined);
          reply.code(400);
          return { error: `project ${projectId} not found` };
        }
        scopeOrgId = organizationId ?? project.organization_id;
        scopeProjectId = project.id;
      } else {
        scopeOrgId = organizationId ?? SYSTEM_DEFAULT_ORG_ID;
        scopeProjectId = req.user?.default_project_id ?? SYSTEM_DEFAULT_PROJECT_ID;
      }

      // --- Authz: проверяем что у пользователя есть write-доступ к проекту ---
      if (!(await requireProjectWrite(req, reply, scopeProjectId))) {
        await unlink(savedFile.absolutePath).catch(() => undefined);
        return reply;
      }

      // Sanitize client-supplied metadata: редактируем значения, похожие
      // на секреты (по имени ключа: password/token/api_key/...; по
      // префиксу значения: sk-ant-/sk-/AKIA/...). Без этого клиент по
      // ошибке мог бы положить в metadata свой токен — и тот попал бы
      // в БД и webhook'и третьим лицам.
      let sanitizedMetadata: unknown = null;
      if (metadata !== undefined && metadata !== null) {
        const result = sanitizeMetadata(metadata);
        sanitizedMetadata = result.sanitized;
        if (result.redactionsCount > 0) {
          req.log.warn(
            { redactions: result.redactionsCount },
            'metadata contained values that look like secrets; redacted before storage',
          );
        }
      }

      // F4: проставить флаг redact_pii в metadata если он пришёл через query
      // или multipart field. Это позволяет orchestrator'у на финальной стадии
      // решить редактировать ли extracted перед webhook'ом.
      if (redactPiiFlag) {
        sanitizedMetadata = { ...(sanitizedMetadata ?? {}), redact_pii: true };
      }

      // ─── EXT-B (Q11): BYO LLM credentials через X-LLM-* заголовки ──────────
      // Если consumer (SLAI) передал свой LLM-провайдер/ключ — используем их
      // для THIS job вместо default provider_settings. Гейтится флагом
      // BYO_LLM_ENABLED (fail-closed). api_key шифруется secrets-envelope'ом
      // ПЕРЕД постановкой в очередь — в БД/Redis ложится только непрозрачный
      // envelope, plaintext-ключ никуда не пишется. Worker расшифровывает в
      // hot-path (orchestrator.processJob).
      let byoUsed = false;
      const inlineCreds = readInlineCredHeaders(req.headers as Record<string, unknown>);
      if (inlineCreds.present) {
        if (!config.byoLlmEnabled) {
          // Явный сигнал клиенту, а не молчаливое игнорирование: SLAI должен
          // знать, что фича выключена, а не недоумевать почему его ключ не
          // применился. error_code в общем union'е API.
          await unlink(savedFile.absolutePath).catch(() => undefined);
          reply.code(400);
          return {
            error: 'BYO LLM credentials are not enabled on this deployment',
            error_code: 'BYO_LLM_DISABLED',
          };
        }
        if (!inlineCreds.creds) {
          // Заголовки есть, но без X-LLM-Api-Key / X-LLM-Provider — неполный набор.
          await unlink(savedFile.absolutePath).catch(() => undefined);
          reply.code(400);
          return {
            error: 'X-LLM-Api-Key and X-LLM-Provider are required when supplying BYO LLM credentials',
            error_code: 'BYO_LLM_INCOMPLETE',
          };
        }
        // НЕ логируем сам ключ. Лог только факт + provider (низкая кардинальность).
        req.log.info(
          { byo_provider: inlineCreds.creds.provider },
          'BYO LLM credentials supplied for this job',
        );
        const envelope = encryptInlineCredentials(inlineCreds.creds);
        sanitizedMetadata = {
          ...(sanitizedMetadata ?? {}),
          [INLINE_CREDS_METADATA_KEY]: envelope,
        };
        byoUsed = true;
      }

      // ─── Optimization #4: SHA-256 cache lookup ─────────────────────────
      // Считаем hash файла. Если в БД есть finished job с тем же hash в
      // этой же организации за последние 24h — возвращаем cached job_id
      // без новой обработки. Экономит LLM cost при ретраях / повторных
      // загрузках того же файла.
      //
      // Skip cache когда:
      //   - клиент задал metadata._skip_cache=true (для тестов)
      //   - есть idempotency-key (он уже сделал свой dedupe выше)
      //   - принудительно через `?force_reprocess=true` (для админских реrun'ов)
      const skipCache =
        (sanitizedMetadata && typeof sanitizedMetadata === 'object' &&
          (sanitizedMetadata as Record<string, unknown>)._skip_cache === true) ||
        (req.query as Record<string, unknown> | undefined)?.force_reprocess === 'true' ||
        // EXT-B: BYO-job всегда обрабатывается заново — иначе вернули бы
        // кэшированный результат, посчитанный на default-провайдере, и
        // consumer'ские creds не применились бы.
        byoUsed;

      const fileSha256 = skipCache
        ? null
        : await computeFileSha256(savedFile.absolutePath);

      if (fileSha256 && !skipCache) {
        const cached = await jobsRepo.findCachedBySha256(
          fileSha256,
          scopeOrgId,
          24, // 24 часа TTL
        );
        if (cached) {
          // Hit! Удаляем только что сохранённый файл (он redundant)
          await unlink(savedFile.absolutePath).catch(() => undefined);
          req.log.info(
            { sha256: fileSha256.slice(0, 12), cached_job_id: cached.id, age_hours: 24 },
            'SHA-256 cache hit — returning existing job',
          );
          reply.code(200);
          reply.header('x-parsdocs-cached', '1');
          reply.header('x-parsdocs-cached-job-id', cached.id);
          return { job_id: cached.id, status: cached.status };
        }
        req.log.debug({ sha256: fileSha256.slice(0, 12) }, 'SHA-256 cache miss');
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
          metadata: sanitizedMetadata,
          idempotencyKey,
          fileSha256,
          organizationId: scopeOrgId,
          projectId: scopeProjectId,
          createdByUserId: req.user?.id ?? null,
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

      // Первое событие пайплайна — upload завершён. Используется UI для
      // показа "✓ загружен" сразу после POST /jobs. Best-effort: исключения
      // не должны валить создание job'а.
      await jobsRepo
        .appendPipelineStep(job.id, {
          step: 'upload',
          status: 'done',
          at: new Date().toISOString(),
          details: {
            file_size: savedFile.size,
            mime_type: savedFile.mimeType,
            document_hint: documentHint ?? null,
          },
        })
        .catch((err) => req.log.warn({ jobId: job.id, err }, 'failed to record upload step'));

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
      if (!(await requireProjectAccess(req, reply, job.project_id))) return reply;
      return jobsRepo.toApi(job);
    },
  );

  // F21: GET /jobs/:id/raw-text — отдаёт сохранённый OCR-текст.
  // Используется SLAI / другими интеграторами для отладки когда
  // status=needs_review (чтобы оператор увидел что именно распознал
  // Tesseract до LLM-структурирования). Также пригоден для повторного
  // запуска extract'а через POST /jobs/:id/reprocess.
  // Намеренно без response Zod-schema — возвращаем text/plain.
  r.get(
    '/jobs/:id/raw-text',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Получить сырой OCR-текст распознанного документа',
        description:
          'Возвращает `raw_text` job\'а — текст, который OCR-движок ' +
          '(Tesseract / pdf-text / vision-llm / yandex) извлёк из документа ' +
          'ДО LLM-структурирования. Подходит для debug и retry. Если у job ' +
          'нет raw_text (OCR провалился / job ещё в очереди) — возвращает 404.',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
      },
    },
    async (req, reply) => {
      const job = await jobsRepo.findById(req.params.id);
      if (!job) {
        reply.code(404);
        return { error: 'job not found' };
      }
      if (!(await requireProjectAccess(req, reply, job.project_id))) return reply;
      if (!job.raw_text) {
        reply.code(404);
        return { error: 'job has no raw_text (OCR did not complete or job was failed before extraction)' };
      }
      reply.type('text/plain; charset=utf-8');
      reply.send(job.raw_text);
      return reply;
    },
  );

  // GET /jobs/:id/file — отдаёт исходный загруженный документ.
  // Используется UI для preview оригинала рядом с extracted JSON.
  // После retention-чистки (jobs.file_path NULLed) возвращает 410.
  r.get(
    '/jobs/:id/file',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Скачать оригинал документа',
        description:
          'Стримит исходный файл с диска. Content-Type = job.mime_type. ' +
          'Inline disposition — браузер показывает PDF/картинку прямо в окне. ' +
          'После окончания retention-периода возвращает 410 Gone (jobs.file_path занулён ' +
          'sweeper\'ом, файл удалён с диска, восстановить нельзя).',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
        response: {
          // Note: response body — binary stream, не JSON; зод-схема не описывает.
          // Указываем только error responses.
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          410: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const job = await jobsRepo.findById(req.params.id);
      if (!job) {
        reply.code(404);
        return { error: 'job not found' };
      }
      if (!(await requireProjectAccess(req, reply, job.project_id))) return reply;
      if (!job.file_path) {
        reply.code(410);
        return { error: 'file no longer available (retention period elapsed)' };
      }
      // A2: материализуем через storage abstraction. Для local backend — это
      // stat-check на оригинале (cleanup=no-op). Для S3 — fast-path по локальному
      // кэшу, иначе stream-download в tmp с cleanup на close.
      let materialized: Awaited<ReturnType<typeof fileStorage.materialize>>;
      try {
        materialized = await fileStorage.materialize(job.file_path);
      } catch {
        reply.code(410);
        return { error: 'file missing on disk' };
      }
      let size: number;
      try {
        const stats = await stat(materialized.absolutePath);
        size = stats.size;
      } catch {
        await materialized.cleanup().catch(() => undefined);
        reply.code(410);
        return { error: 'file missing on disk' };
      }
      reply.header('Content-Type', job.mime_type);
      reply.header('Content-Length', size);
      // RFC 6266 — для русских имён нужен filename* (RFC 5987 percent-encoding).
      const fnAscii = job.file_name.replace(/[^\x20-\x7E]/g, '_');
      reply.header(
        'Content-Disposition',
        `inline; filename="${fnAscii}"; filename*=UTF-8''${encodeURIComponent(job.file_name)}`,
      );
      // Привязываем cleanup к жизненному циклу response — снимаем tmp-файл
      // когда клиент закрыл соединение / поток отдан.
      reply.raw.on('close', () => {
        void materialized.cleanup().catch(() => undefined);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (reply as any).send(createReadStream(materialized.absolutePath));
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
      if (!(await requireProjectWrite(req, reply, job.project_id))) return reply;

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

  // POST /jobs/:id/approve — CP6: одобрить needs_review без изменения extracted.
  // Оператор проверил данные визуально и убедился, что всё верно.
  // Идемпотентен: если job уже 'done' — возвращает его без ошибки.
  r.post(
    '/jobs/:id/approve',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Одобрить job (needs_review → done)',
        description:
          'Переводит статус `needs_review` → `done` без изменения `extracted`. ' +
          'Используется оператором в Review Queue после визуальной проверки. ' +
          'Идемпотентен — если статус уже `done`, возвращает актуальную строку. ' +
          'Если job в статусе `pending`/`processing`/`failed` — 409.',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
        response: {
          200: Job,
          401: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const job = await jobsRepo.findById(req.params.id);
      if (!job) {
        reply.code(404);
        return { error: 'job not found' };
      }
      if (!(await requireProjectWrite(req, reply, job.project_id))) return reply;
      if (job.status === 'pending' || job.status === 'processing' || job.status === 'failed') {
        reply.code(409);
        return { error: `cannot approve job in status "${job.status}"` };
      }
      const updated = await jobsRepo.approve(req.params.id);
      if (!updated) {
        reply.code(404);
        return { error: 'job not found' };
      }
      return jobsRepo.toApi(updated);
    },
  );

  // POST /jobs/:id/redeliver-webhook — сбросить счётчик попыток и повторить доставку вебхука.
  // Use-case: доставка упала (недоступный endpoint получателя); оператор починил endpoint,
  // жмёт кнопку — вебхук летит снова. Метод идемпотентен по смыслу: если webhook_url
  // не задан или job ещё in-flight — возвращаем ошибку с понятным сообщением.
  r.post(
    '/jobs/:id/redeliver-webhook',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Повторить доставку вебхука',
        description:
          'Сбрасывает `webhook_attempts` и `webhook_delivered_at`, после чего немедленно ' +
          'повторяет доставку вебхука в фоне (с полным backoff-циклом). ' +
          'Требует, чтобы у job был `webhook_url` и job находился в терминальном статусе. ' +
          'Возвращает 202 Accepted — доставка асинхронная. ' +
          'Если webhook уже доставлен (`webhook_delivered_at != null`) — отказ 409 без `?force=true`.',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
        querystring: z.object({ force: z.coerce.boolean().default(false) }),
        response: {
          202: Job,
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const job = await jobsRepo.findById(req.params.id);
      if (!job) {
        reply.code(404);
        return { error: 'job not found' };
      }
      if (!(await requireProjectWrite(req, reply, job.project_id))) return reply;
      if (!job.webhook_url) {
        reply.code(400);
        return { error: 'job has no webhook_url configured' };
      }
      if (job.status === 'pending' || job.status === 'processing') {
        reply.code(409);
        return {
          error: `cannot redeliver webhook for job in status "${job.status}", wait for terminal state`,
        };
      }
      // Защита от случайного redeliver уже-доставленных вебхуков — клиент мог
      // не понять что доставка успешна и нажать ещё раз. Через ?force=true можно
      // принудительно перепослать (например для replay в QA).
      if (job.webhook_delivered_at && !req.query.force) {
        reply.code(409);
        return {
          error: 'webhook already delivered; use ?force=true to redeliver anyway',
        };
      }
      // Сбрасываем счётчик и временну́ю метку перед запуском,
      // чтобы deliverWebhook начинал с попытки №1.
      await jobsRepo.resetWebhookAttempts(req.params.id);
      const payload = {
        // SLAI Issue #4: обязательный version field в контракте v1.
        version: 'v1' as const,
        job_id: job.id,
        status: job.status,
        // SLAI Issue #3: outbound slug normalize (TTN→ttn, etc.).
        document_type: normalizeSlugForApi(job.document_type ?? null),
        confidence: job.confidence !== null ? Number(job.confidence) : null,
        ocr_engine: job.ocr_engine ?? null,
        extracted: (job.extracted as Record<string, unknown> | null) ?? null,
        metadata: stripInlineCredentials((job.metadata as Record<string, unknown> | null) ?? null),
        error: job.error ?? null,
      };
      // Fire-and-forget: доставка идёт в фоне, ответ клиенту не ждёт.
      void deliverWebhook(req.params.id, job.webhook_url, payload, req.log as never);
      reply.code(202);
      // Возвращаем актуальный снимок job'а (счётчик уже сброшен).
      const refreshed = await jobsRepo.findById(req.params.id);
      return jobsRepo.toApi(refreshed!);
    },
  );

  // POST /jobs/:id/reprocess — перепрогнать уже-распознанный текст
  // через АКТУАЛЬНУЮ конфигурацию типа (новый prompt / схема / валидаторы).
  // Главный use-case: цикл тюнинга prompt'а — поменяли инструкцию в админ-UI,
  // нажали reprocess на job'е, через 5-15 секунд увидели результат.
  // OCR не повторяется (берём raw_text из БД), это экономит главную часть времени.
  r.post(
    '/jobs/:id/reprocess',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Перепрогнать job под текущую конфигурацию типа',
        description:
          'Берёт сохранённый `raw_text`, прогоняет через classify+parse+validate с актуальной ' +
          'конфигурацией из document_types (новый prompt/схема/валидаторы — то, что админ только ' +
          'что отредактировал в UI). OCR заново не делается — только пост-обработка. Перезаписывает ' +
          'extracted, confidence, validation_issues. Не работает на jobs без raw_text (например, ' +
          'если OCR упала или job ещё in-flight).',
        security: [{ bearerAuth: [] }],
        params: JobIdParam,
        response: {
          200: Job,
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const job = await jobsRepo.findById(req.params.id);
      if (!job) {
        reply.code(404);
        return { error: 'job not found' };
      }
      if (!(await requireProjectWrite(req, reply, job.project_id))) return reply;
      // Нельзя перепрогонять in-flight — параллельный воркер может писать
      // в те же поля. Возвращаем 409 чтобы пользователь подождал.
      if (job.status === 'pending' || job.status === 'processing') {
        reply.code(409);
        return { error: `cannot reprocess job in status "${job.status}", wait for terminal state` };
      }
      if (!job.raw_text) {
        reply.code(400);
        return {
          error:
            'job has no raw_text (OCR did not complete or job was failed before extraction). ' +
            'Re-upload the document instead.',
        };
      }

      // Прогоняем тот же pipeline что и в воркере, но без OCR-фазы.
      // hint — текущий documentType (или document_hint, если type ещё не определён).
      const hint = job.document_type ?? job.document_hint ?? undefined;
      // F20: per-job prompt_override из metadata. Используется для повторного
      // прогона с другим LLM-промптом без правки document_type.llm_prompt.
      const meta = (job.metadata as Record<string, unknown> | null) ?? {};
      const promptOverride =
        typeof meta.prompt_override === 'string' && meta.prompt_override.length > 0
          ? (meta.prompt_override as string)
          : undefined;
      const post = await runDocumentPipeline(
        job.raw_text,
        { hint, promptOverride },
        req.log as never,
        {
          jobId: job.id,
          reprocess: true,
        },
      );

      // OCR confidence сохраняем как было — он не менялся. Парсер-сторону пересчитываем.
      const previousOcrConfidence =
        job.confidence === null ? 0 : Number(job.confidence);
      const overall = combineConfidence(previousOcrConfidence, post.parserConfidence);

      const confidenceThreshold =
        post.typeConfig?.confidenceThreshold ?? config.thresholds.needsReview;
      const hasIssues = post.validationIssues.length > 0;
      const lowConfidence = overall < confidenceThreshold;
      const status: 'done' | 'needs_review' =
        lowConfidence || hasIssues ? 'needs_review' : 'done';

      const { _issues: _ignore, ...extractedClean } = post.extracted as {
        _issues?: unknown;
      } & Record<string, unknown>;
      const extractedToStore: Record<string, unknown> = { ...extractedClean };
      if (post.validationIssues.length > 0) {
        extractedToStore._issues = post.validationIssues;
      }

      const updated = await jobsRepo.finalize(req.params.id, {
        status,
        documentType: post.documentType,
        extracted: extractedToStore,
        confidence: overall,
        error: null,
        // Если парсер ходил в LLM — обновляем трассу. Если нет (regex
        // справился без fallback'а) — передаём null, чтобы старый
        // trace, который мог сбить с толку, очистился.
        llmCall: post.llmCall ?? null,
      });
      if (!updated) {
        reply.code(404);
        return { error: 'job vanished during reprocess' };
      }
      req.log.info(
        { jobId: req.params.id, status, parser_conf: post.parserConfidence, overall },
        'job reprocessed',
      );
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
      // Автоматический tenant-скоуп: super_admin видит всё (или то, что
      // явно зафильтровано client'ом), org_admin — только своя орг,
      // manager/viewer — только свои проекты. Клиентский фильтр (если
      // задан query-параметром) пересекается со scope'ом юзера —
      // нельзя «попросить чужой проект» в обход authz.
      const scope = await getEffectiveScope(req);
      const filters = { ...req.query };
      if (scope.kind === 'org') {
        filters.organization_id = filters.organization_id ?? scope.orgId;
        // Защита от попытки спросить другую организацию.
        if (filters.organization_id !== scope.orgId) {
          return { items: [], limit: req.query.limit, offset: req.query.offset, total: 0 };
        }
      } else if (scope.kind === 'projects') {
        if (scope.projectIds.size === 0) {
          return { items: [], limit: req.query.limit, offset: req.query.offset, total: 0 };
        }
        // Если клиент уточнил project_id — проверяем что он в whitelist'е.
        if (filters.project_id && !scope.projectIds.has(filters.project_id)) {
          return { items: [], limit: req.query.limit, offset: req.query.offset, total: 0 };
        }
        // Если без уточнения — берём первый из доступных (компромисс:
        // на manager'е без явного project_id показываем «один проект»;
        // workspace switcher на UI выберет нужный).
        if (!filters.project_id) {
          filters.project_id = scope.projectIds.values().next().value as string;
        }
      }
      // list + count в параллель — Postgres сам параллелит, JS-уровень
      // тоже не блокируется. Count нужен UI-у для tab-счётчиков и
      // pagination footer'а («15 of 1284 rows»).
      const [items, total] = await Promise.all([
        jobsRepo.list(filters),
        jobsRepo.count(filters),
      ]);
      return {
        items: items.map((j) => jobsRepo.toApi(j)),
        limit: req.query.limit,
        offset: req.query.offset,
        total,
      };
    },
  );
}
