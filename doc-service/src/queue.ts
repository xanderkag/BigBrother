import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';

export const QUEUE_NAME = 'doc-jobs';

// BullMQ requires connections that don't auto-reconnect with retry-after-error.
// One shared ioredis instance is reused by Queue, Worker, and QueueEvents.
export const redisConnection: ConnectionOptions = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export type DocJobPayload = {
  jobId: string;
  /**
   * Trace identifier propagated from the HTTP request that created this
   * job (or from a re-enqueue by the pending-job sweeper). The worker
   * binds it to its child logger so logs from the worker can be joined
   * back to the originating request in observability tools.
   */
  requestId?: string;
};

export const docQueue = new Queue<DocJobPayload>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

export async function closeQueue(): Promise<void> {
  await docQueue.close();
  // Cast through unknown — ConnectionOptions is a union; here it's an IORedis instance.
  await (redisConnection as unknown as IORedis).quit();
}
