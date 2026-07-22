import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
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

/**
 * Поставить джобу в очередь по jobId, устойчиво к terminal-дубликату.
 *
 * BullMQ дедупит `add()` по jobId: если запись с этим id УЖЕ есть в очереди
 * — add молча no-op. Для reprocess это фатально: после первого прогона джоба
 * остаётся `completed` (removeOnComplete 24ч) или `failed` (7 дней), и любой
 * повторный запуск того же id (route reprocess ИЛИ pending-sweeper) тихо
 * проваливается — строка в БД навечно `pending`, sweeper вхолостую логирует
 * «re-enqueued» каждые 60с (баг Docs_PWR-FAB270, 2026-07-22; семейство
 * «строка БД ↔ BullMQ разъехались»).
 *
 * Фикс: перед add снимаем СУЩЕСТВУЮЩУЮ запись, если она в terminal-состоянии
 * (completed/failed) — тогда add реально пере-ставит. active/waiting/delayed
 * оставляем (реальный воркер или уже в очереди) — это законный no-op.
 * Возвращает 'enqueued' | 'skipped' (уже в работе/очереди).
 */
/** Минимальный контракт очереди, нужный enqueueDocJob (для тестов). */
export interface EnqueueableQueue {
  getJob(id: string): Promise<{
    getState(): Promise<string>;
    remove(): Promise<unknown>;
  } | null | undefined>;
  add(name: string, payload: DocJobPayload, opts: { jobId: string }): Promise<unknown>;
}

export async function enqueueDocJob(
  payload: DocJobPayload,
  jobId: string,
  queue: EnqueueableQueue = docQueue as unknown as EnqueueableQueue,
): Promise<'enqueued' | 'skipped'> {
  const existing = await queue.getJob(jobId);
  if (existing) {
    let state: string;
    try {
      state = await existing.getState();
    } catch {
      state = 'unknown';
    }
    if (state === 'completed' || state === 'failed') {
      await existing.remove().catch(() => {});
    } else if (state !== 'unknown') {
      // active / waiting / delayed / prioritized — уже в работе или в очереди.
      return 'skipped';
    }
  }
  await queue.add('process', payload, { jobId });
  return 'enqueued';
}

export async function closeQueue(): Promise<void> {
  await docQueue.close();
  // Cast through unknown — ConnectionOptions is a union; here it's an IORedis instance.
  await (redisConnection as unknown as IORedis).quit();
}
