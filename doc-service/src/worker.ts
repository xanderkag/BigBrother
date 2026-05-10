import { Worker } from 'bullmq';
import pino from 'pino';
import { config } from './config.js';
import { QUEUE_NAME, redisConnection, type DocJobPayload, closeQueue } from './queue.js';
import { closeDb } from './db.js';
import { processJob } from './pipeline/orchestrator.js';

// pino is a transitive dep of fastify; use it directly here so the worker has matching log output.
const log = pino({ level: config.logLevel, name: 'worker' });

const worker = new Worker<DocJobPayload>(
  QUEUE_NAME,
  async (job) => {
    log.info({ bullId: job.id, jobId: job.data.jobId, attempt: job.attemptsMade + 1 }, 'job received');
    await processJob(job.data.jobId, log);
  },
  {
    connection: redisConnection,
    concurrency: config.workerConcurrency,
  },
);

worker.on('completed', (job) => log.info({ bullId: job.id, jobId: job.data.jobId }, 'job completed'));
worker.on('failed', (job, err) =>
  log.error({ bullId: job?.id, jobId: job?.data.jobId, err }, 'job failed'),
);

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down worker');
  await worker.close();
  await closeQueue();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info({ queue: QUEUE_NAME }, 'worker started');
