import type { Logger } from 'pino';
import { config } from '../config.js';
import { docQueue } from '../queue.js';
import { jobsRepo as defaultJobsRepo, type JobRow } from '../storage/jobs.js';

/**
 * Background sweeper that re-enqueues "stuck" pending jobs.
 *
 * Why this exists: `POST /api/v1/jobs` writes the row to Postgres first
 * (so the caller gets a `job_id` and a 202), then enqueues to BullMQ. If
 * Redis is unavailable between those two operations — or BullMQ silently
 * loses the job for any reason — the row sits in Postgres forever with
 * status='pending'.
 *
 * The sweep is cheap: a single SELECT bounded by `graceSeconds` (rows are
 * ignored until they've had time to land naturally) and one `queue.add`
 * per stuck row. BullMQ deduplicates by `jobId`, so if the original
 * enqueue actually succeeded and we missed it, this no-ops.
 *
 * Dependencies are injectable so tests can run without a real DB or
 * Redis. In production the defaults wire to the live singletons.
 */
export type PendingJobSweeperDeps = {
  log: Logger;
  /** Override the jobs repository (e.g., in tests). */
  jobsRepo?: { findStalePending: (graceSeconds: number, limit?: number) => Promise<JobRow[]> };
  /** Override the BullMQ enqueue function (e.g., in tests). */
  enqueue?: (payload: { jobId: string; requestId?: string }, bullId: string) => Promise<void>;
  intervalMs?: number;
  graceSeconds?: number;
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

  let running = false;

  // Returns count of re-enqueued rows so callers (and tests) can assert.
  const runOnce = async (): Promise<number> => {
    if (running) return 0; // overlap guard — long sweep won't pile up
    running = true;
    try {
      const stale = await repo.findStalePending(graceSeconds);
      if (stale.length === 0) return 0;
      log.warn(
        { count: stale.length, age_seconds_min: graceSeconds },
        'found stale pending jobs, re-enqueueing',
      );
      for (const row of stale) {
        try {
          await enqueue({ jobId: row.id, requestId: undefined }, row.id);
          log.info({ job_id: row.id }, 're-enqueued stale pending job');
        } catch (err) {
          log.error({ job_id: row.id, err }, 'failed to re-enqueue stale pending job');
        }
      }
      return stale.length;
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

  log.info({ intervalMs, graceSeconds }, 'pending-job sweeper started');

  return {
    stop: () => clearInterval(handle),
    runOnce,
  };
}
