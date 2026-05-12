import { Worker, UnrecoverableError } from 'bullmq';
import pino from 'pino';
import { config } from './config.js';
import { QUEUE_NAME, redisConnection, type DocJobPayload, closeQueue } from './queue.js';
import { closeDb } from './db.js';
import { processJob } from './pipeline/orchestrator.js';
import { startPendingJobSweeper } from './workers/pending-job-sweeper.js';
import { startFileCleanupSweeper } from './workers/file-cleanup.js';
import { startAuditLogSweeper } from './workers/audit-log-sweeper.js';

// pino directly: matches the Fastify-bound logger format on the API side so
// log aggregation tools see a single shape. The base bindings (name=worker)
// are inherited by every child logger we make for individual jobs.
const log = pino({ level: config.logLevel, name: 'worker' });

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
      throw new UnrecoverableError(
        `job exceeded max age (${Math.round(jobAgeMs / 60_000)} min > ${config.jobMaxAgeSeconds / 60} min)`,
      );
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

    await processJob(job.data.jobId, jobLog, { attempt });
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
const pendingSweeper = startPendingJobSweeper({ log });
const fileSweeper = startFileCleanupSweeper({ log });
const auditLogSweeper = startAuditLogSweeper({ log });

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down worker');
  pendingSweeper.stop();
  fileSweeper.stop();
  auditLogSweeper.stop();
  await worker.close();
  await closeQueue();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info({ queue: QUEUE_NAME }, 'worker started');
