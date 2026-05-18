import type { Logger } from 'pino';
import { config } from '../config.js';
import { docQueue } from '../queue.js';
import { jobsRepo as defaultJobsRepo, type JobRow } from '../storage/jobs.js';

/**
 * Background sweeper that re-enqueues "stuck" jobs.
 *
 * **Pending** stuck: `POST /api/v1/jobs` writes the row to Postgres first
 * (so the caller gets a `job_id` and a 202), then enqueues to BullMQ. If
 * Redis is unavailable between those two operations — or BullMQ silently
 * loses the job for any reason — the row sits in Postgres forever with
 * status='pending'.
 *
 * **Processing** stuck (2026-05-18): worker рестартован/убит middle of job —
 * BullMQ active queue потерял consumer, row застрял в status='processing'
 * с `updated_at` старше processGraceSeconds. processJobInner идемпотентен
 * (повторное finalize OK), так что re-enqueue безопасен.
 *
 * The sweep is cheap: один SELECT для pending + один для processing,
 * каждый с `graceSeconds` window. BullMQ deduplicates by `jobId`, так что
 * если worker реально работает — no-op.
 */
export type PendingJobSweeperDeps = {
  log: Logger;
  /** Override the jobs repository (e.g., in tests). */
  jobsRepo?: {
    findStalePending: (graceSeconds: number, limit?: number) => Promise<JobRow[]>;
    findStuckProcessing: (graceSeconds: number, limit?: number) => Promise<JobRow[]>;
  };
  /** Override the BullMQ enqueue function (e.g., in tests). */
  enqueue?: (payload: { jobId: string; requestId?: string }, bullId: string) => Promise<void>;
  intervalMs?: number;
  graceSeconds?: number;
  /**
   * Grace для stuck-processing — default 15 минут (типичное время на
   * LLM-extract длинного scan'а через multipass + reasonable buffer).
   * Меньше — false-positive'ы (подберём реально работающий job).
   */
  processGraceSeconds?: number;
};

const defaultEnqueue = async (
  payload: { jobId: string; requestId?: string },
  bullId: string,
): Promise<void> => {
  await docQueue.add('process', payload, { jobId: bullId });
};

export function startPendingJobSweeper(
  deps: PendingJobSweeperDeps,
): { stop: () => void; runOnce: () => Promise<number> } {
  const log = deps.log.child({ sweeper: 'pending-jobs' });
  const repo = deps.jobsRepo ?? defaultJobsRepo;
  const enqueue = deps.enqueue ?? defaultEnqueue;
  const intervalMs = deps.intervalMs ?? config.sweepers.pendingIntervalMs;
  const graceSeconds = deps.graceSeconds ?? config.sweepers.pendingGraceSeconds;
  // 15 minutes default — typical multipass LLM extract + buffer.
  const processGraceSeconds = deps.processGraceSeconds ?? 900;

  let running = false;

  // Returns count of re-enqueued rows so callers (and tests) can assert.
  const runOnce = async (): Promise<number> => {
    if (running) return 0; // overlap guard — long sweep won't pile up
    running = true;
    try {
      // 1. Stale pending — never picked up by worker (enqueue lost / Redis hiccup)
      const stalePending = await repo.findStalePending(graceSeconds);
      if (stalePending.length > 0) {
        log.warn(
          { count: stalePending.length, age_seconds_min: graceSeconds },
          'found stale pending jobs, re-enqueueing',
        );
        for (const row of stalePending) {
          try {
            await enqueue({ jobId: row.id, requestId: undefined }, row.id);
            log.info({ job_id: row.id }, 're-enqueued stale pending job');
          } catch (err) {
            log.error({ job_id: row.id, err }, 'failed to re-enqueue stale pending job');
          }
        }
      }

      // 2. Stuck processing — worker died/restarted, job orphaned in active queue
      const stuckProcessing = await repo.findStuckProcessing(processGraceSeconds);
      if (stuckProcessing.length > 0) {
        log.warn(
          { count: stuckProcessing.length, age_seconds_min: processGraceSeconds },
          'found stuck processing jobs (worker died?), re-enqueueing',
        );
        for (const row of stuckProcessing) {
          try {
            await enqueue({ jobId: row.id, requestId: undefined }, row.id);
            log.info({ job_id: row.id, age_seconds: processGraceSeconds }, 're-enqueued stuck processing job');
          } catch (err) {
            log.error({ job_id: row.id, err }, 'failed to re-enqueue stuck processing job');
          }
        }
      }

      return stalePending.length + stuckProcessing.length;
    } catch (err) {
      log.error({ err }, 'pending-job sweeper iteration failed');
      return 0;
    } finally {
      running = false;
    }
  };

  // .unref() so the timer doesn't keep the process alive on shutdown.
  const handle = setInterval(() => void runOnce(), intervalMs);
  handle.unref?.();

  log.info({ intervalMs, graceSeconds, processGraceSeconds }, 'pending-job sweeper started');

  return {
    stop: () => clearInterval(handle),
    runOnce,
  };
}
