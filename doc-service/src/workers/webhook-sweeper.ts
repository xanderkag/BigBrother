import type { Logger } from 'pino';
import { config } from '../config.js';
import { jobsRepo as defaultJobsRepo, type JobRow } from '../storage/jobs.js';
import {
  deliverWebhook,
  WEBHOOK_SCHEMA_VERSION,
  type WebhookPayload,
} from '../webhooks/deliver.js';
import { normalizeSlugForApi } from '../types/slug-normalize.js';

/**
 * Automatic webhook re-delivery sweeper (A4 remainder).
 *
 * Why this exists: `deliverWebhook()` makes `maxAttempts` tries with
 * exponential backoff. If the consumer endpoint was down the whole time,
 * all attempts fail and the job sits with `webhook_delivered_at = NULL`.
 * Operators can manually re-deliver via `POST /jobs/:id/redeliver-webhook`,
 * but that requires someone to notice. This sweeper automates the retry.
 *
 * Design decisions:
 *   - The sweeper does NOT reset `webhook_attempts`. Each sweeper invocation
 *     triggers one `deliverWebhook()` call which adds up to `maxAttempts`
 *     more tries. The counter grows monotonically: 5 → 10 → 15.
 *   - A `hardLimit` (default 15 = 3 × maxAttempts) prevents infinite retries.
 *     After `hardLimit` total attempts the sweeper stops — only manual
 *     redeliver can push past the hard limit.
 *   - `graceMinutes` prevents the sweeper from kicking in while the initial
 *     delivery backoff is still running (default 60 min).
 *
 * Dependencies are injectable so tests can run without a real DB or network.
 */
export type WebhookSweeperDeps = {
  log: Logger;
  jobsRepo?: {
    listStaleWebhooks: (params: {
      graceMinutes: number;
      hardLimit: number;
      limit?: number;
    }) => Promise<JobRow[]>;
  };
  deliver?: (jobId: string, url: string, payload: WebhookPayload, log: Logger) => Promise<void>;
  intervalMs?: number;
  graceMinutes?: number;
  hardLimit?: number;
};

export function startWebhookSweeper(
  deps: WebhookSweeperDeps,
): { stop: () => void; runOnce: () => Promise<number> } {
  const log = deps.log.child({ sweeper: 'webhook' });
  const repo = deps.jobsRepo ?? defaultJobsRepo;
  const deliver = deps.deliver ?? deliverWebhook;
  const intervalMs = deps.intervalMs ?? config.sweepers.webhookSweeperIntervalMs;
  const graceMinutes = deps.graceMinutes ?? config.sweepers.webhookSweeperGraceMinutes;
  const hardLimit = deps.hardLimit ?? config.sweepers.webhookSweeperHardLimit;

  let running = false;

  const runOnce = async (): Promise<number> => {
    if (running) return 0; // overlap guard — long sweep won't pile up
    running = true;
    try {
      const stale = await repo.listStaleWebhooks({ graceMinutes, hardLimit });
      if (stale.length === 0) return 0;

      log.warn(
        {
          count: stale.length,
          grace_minutes: graceMinutes,
          hard_limit: hardLimit,
        },
        'found stale undelivered webhooks, retrying',
      );

      // triggered — это число запущенных доставок, не реально дошедших до
      // получателя. Реальная доставка асинхронна (fire-and-forget) с собственным
      // retry-loop внутри deliverWebhook().
      let triggered = 0;
      for (const row of stale) {
        if (!row.webhook_url) continue; // should not happen given SQL filter
        const payload: WebhookPayload = {
          // SLAI Issue #4: обязательный version field.
          version: 'v1',
          schema_version: WEBHOOK_SCHEMA_VERSION,
          job_id: row.id,
          status: row.status,
          // SLAI Issue #3: outbound slug normalize.
          // schema_version 1.1 (SLAI confirmed 2026-07-01): неопознанный док
          // (classification.unknown) уходит как литерал "unknown", НЕ null;
          // отдельного флага нет. В БД document_type остаётся null.
          document_type:
            row.classification?.unknown === true
              ? 'unknown'
              : normalizeSlugForApi(row.document_type ?? null),
          confidence: row.confidence !== null ? Number(row.confidence) : null,
          ocr_engine: row.ocr_engine ?? null,
          extracted: (row.extracted as Record<string, unknown> | null) ?? null,
          metadata: (row.metadata as Record<string, unknown> | null) ?? null,
          error: row.error ?? null,
        };
        try {
          // Fire-and-forget per job — one broken endpoint doesn't block the
          // rest. deliverWebhook() has its own internal retry loop.
          void deliver(row.id, row.webhook_url, payload, log).catch((err) => {
            log.error({ job_id: row.id, err }, 'webhook sweeper delivery error');
          });
          triggered += 1;
          log.info({ job_id: row.id, attempts_so_far: row.webhook_attempts }, 'webhook re-delivery triggered');
        } catch (err) {
          log.error({ job_id: row.id, err }, 'webhook sweeper: failed to trigger delivery');
        }
      }
      return triggered;
    } catch (err) {
      log.error({ err }, 'webhook sweeper iteration failed');
      return 0;
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void runOnce(), intervalMs);
  handle.unref?.();

  log.info({ intervalMs, graceMinutes, hardLimit }, 'webhook sweeper started');

  return {
    stop: () => clearInterval(handle),
    runOnce,
  };
}
