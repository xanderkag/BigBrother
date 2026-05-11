import { Worker } from 'bullmq';
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
    // Per-job child logger binds the trace ids once; every subsequent log
    // inside processJob carries `request_id`, `job_id`, `bull_id`.
    const jobLog = log.child({
      request_id: job.data.requestId,
      job_id: job.data.jobId,
      bull_id: job.id,
      attempt: job.attemptsMade + 1,
    });
    jobLog.info('job received');
    await processJob(job.data.jobId, jobLog);
  },
  {
    connection: redisConnection,
    concurrency: config.workerConcurrency,
  },
);

worker.on('completed', (job) =>
  log.info(
    { request_id: job.data.requestId, job_id: job.data.jobId, bull_id: job.id },
    'job completed',
  ),
);
worker.on('failed', (job, err) =>
  log.error(
    { request_id: job?.data.requestId, job_id: job?.data.jobId, bull_id: job?.id, err },
    'job failed',
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
