import { Worker, UnrecoverableError } from 'bullmq';
import pino from 'pino';
import { config, assertRuntimeConfig } from './config.js';
import { QUEUE_NAME, redisConnection, type DocJobPayload, closeQueue } from './queue.js';
import { closeDb } from './db.js';
import { processJob, isDeterministicJobError } from './pipeline/orchestrator.js';
import { jobsRepo } from './storage/jobs.js';
import { startPendingJobSweeper } from './workers/pending-job-sweeper.js';
import { startFxRateRefresher } from './workers/fx-rate-refresher.js';
import { startFileCleanupSweeper } from './workers/file-cleanup.js';
import { startAuditLogSweeper } from './workers/audit-log-sweeper.js';
import { startWebhookSweeper } from './workers/webhook-sweeper.js';
import { stallDeferredTotal } from './metrics.js';

// pino directly: matches the Fastify-bound logger format on the API side so
// log aggregation tools see a single shape. The base bindings (name=worker)
// are inherited by every child logger we make for individual jobs.
const log = pino({ level: config.logLevel, name: 'worker' });

// H1: fail-closed на те же misconfigured external-call флаги, что и server.ts.
// Воркер исполняет ASR-транскрипцию и расшифровку inline BYO-creds в hot-path,
// поэтому эти combos должны падать на старте и здесь.
assertRuntimeConfig(config);

const worker = new Worker<DocJobPayload>(
  QUEUE_NAME,
  async (job) => {
    const attempt = job.attemptsMade + 1;
    const jobLog = log.child({
      request_id: job.data.requestId,
      job_id: job.data.jobId,
      bull_id: job.id,
      attempt,
    });

    // I2: Hard deadline — если job старше JOB_MAX_AGE_SECONDS, убиваем без
    // дальнейших ретраев. Типичная причина: LLM-сервис лежал несколько часов,
    // накопилась очередь устаревших задач; их незачем повторять.
    // UnrecoverableError говорит BullMQ «не ретраить», job помечается failed.
    const maxAgeMs = config.jobMaxAgeSeconds * 1000;
    const jobAgeMs = Date.now() - job.timestamp;
    if (jobAgeMs > maxAgeMs) {
      jobLog.warn(
        { job_age_min: Math.round(jobAgeMs / 60_000), max_age_min: config.jobMaxAgeSeconds / 60 },
        'job exceeded max age — dropping without retry',
      );
      const ageError = `job exceeded max age (${Math.round(jobAgeMs / 60_000)} min > ${config.jobMaxAgeSeconds / 60} min)`;
      // ОБЯЗАТЕЛЬНО финализировать строку в Postgres ДО throw: иначе она
      // остаётся в 'processing' навечно — BullMQ-джоба уходит в failed-set,
      // re-enqueue sweeper'а с тем же id молча дедупится об неё, и sweeper
      // спамит «re-enqueued stuck processing job» каждые 60с бесконечно
      // (зомби ТН_FESU5433115, 2026-07-21). best-effort: упавший UPDATE не
      // должен спрятать UnrecoverableError.
      await jobsRepo
        .finalize(job.data.jobId, { status: 'failed', error: ageError })
        .catch((err) =>
          jobLog.error({ err }, 'failed to finalize over-age job row — row may stay processing'),
        );
      throw new UnrecoverableError(ageError);
    }

    // Retry-событие — отдельным сообщением, чтобы log-агрегатор
    // мог построить отдельную метрику ретраев. attemptsMade=0 →
    // первая попытка, не retry.
    if (job.attemptsMade > 0) {
      jobLog.warn(
        {
          attempt,
          previous_error: job.failedReason ?? null,
        },
        'job retry',
      );
    } else {
      jobLog.info('job received');
    }

    try {
      await processJob(job.data.jobId, jobLog, { attempt });
    } catch (err) {
      // Детерминированные ошибки (OCR-refusal, неподдерживаемый тип файла) не
      // ретраим: тот же файл → тот же результат, 3 прогона OCR-цепочки впустую.
      // Job уже финализирован failed с текстом ошибки в orchestrator catch.
      if (isDeterministicJobError(err)) {
        jobLog.warn(
          { err_message: err instanceof Error ? err.message : String(err) },
          'deterministic failure — dropping without retry',
        );
        throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency: config.workerConcurrency,
  },
);

// BullMQ-level подтверждение — не дублирует rich-логи из orchestrator,
// помечено отдельным msg ('bullmq completed') чтобы парсер логов не
// путал с основным 'job completed'.
worker.on('completed', (job) =>
  log.info(
    { request_id: job.data.requestId, job_id: job.data.jobId, bull_id: job.id },
    'bullmq completed',
  ),
);
worker.on('failed', (job, err) =>
  log.error(
    { request_id: job?.data.requestId, job_id: job?.data.jobId, bull_id: job?.id, err },
    'bullmq failed',
  ),
);

// Background sweepers — both run as setInterval inside this same process. With
// a single worker process per deployment they need no distributed locking; if
// we ever go horizontal, swap setInterval for BullMQ repeatable jobs so only
// one instance executes each sweep.
const pendingSweeper = startPendingJobSweeper({
  log,
  onStallDeferred: () => stallDeferredTotal.inc(),
});
const fileSweeper = startFileCleanupSweeper({ log });
const auditLogSweeper = startAuditLogSweeper({ log });
const webhookSweeper = startWebhookSweeper({ log });
// FX-1: подтяжка курса ЦБ (cbr.ru) для конвертации валютных LLM-затрат в ₽.
// Гейт config.cost.fxCbrEnabled — можно выключить, если корп-сеть закроет egress.
const fxRefresher = config.cost.fxCbrEnabled
  ? startFxRateRefresher({ log, intervalMs: config.cost.fxRefreshHours * 60 * 60 * 1000 })
  : null;

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down worker');
  pendingSweeper.stop();
  fileSweeper.stop();
  auditLogSweeper.stop();
  webhookSweeper.stop();
  fxRefresher?.stop();
  await worker.close();
  await closeQueue();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info({ queue: QUEUE_NAME }, 'worker started');
