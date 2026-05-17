import { createHmac } from 'node:crypto';
import { request } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.js';
import { jobsRepo } from '../storage/jobs.js';
import { webhookAttemptsTotal } from '../metrics.js';
import type { Logger } from 'pino';

export type WebhookPayload = {
  job_id: string;
  status: string;
  document_type: string | null;
  confidence: number | null;
  ocr_engine: string | null;
  extracted: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
  // F2 (2026-05-17): per-field confidence map (поле_path → 0..1).
  // SLAI matcher использует для weighted scoring. Заполняется
  // через processFieldConfidence() в orchestrator. См.
  // pipeline/normalize/field-confidence.ts.
  _field_confidence?: Record<string, number>;
};

/**
 * Deliver a webhook with HMAC-SHA256 signature and exponential backoff.
 * Each attempt is recorded in the jobs row; on permanent failure the job
 * keeps its terminal status — caller can re-fetch via GET /jobs/:id.
 */
export async function deliverWebhook(
  jobId: string,
  url: string,
  payload: WebhookPayload,
  log: Logger,
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = sign(body, config.webhook.hmacSecret);

  const maxAttempts = config.webhook.maxAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-docservice-signature': `sha256=${signature}`,
          'x-docservice-job-id': jobId,
          'x-docservice-attempt': String(attempt),
        },
        body,
        headersTimeout: config.webhook.timeoutMs,
        bodyTimeout: config.webhook.timeoutMs,
      });

      if (res.statusCode >= 200 && res.statusCode < 300) {
        await jobsRepo.recordWebhookAttempt(jobId, true, null);
        webhookAttemptsTotal.inc({ outcome: 'success' });
        log.info({ jobId, attempt, status: res.statusCode }, 'webhook delivered');
        // Drain body to free the socket.
        await res.body.dump();
        return;
      }

      const errText = (await res.body.text()).slice(0, 500);
      const errMsg = `HTTP ${res.statusCode}: ${errText}`;
      await jobsRepo.recordWebhookAttempt(jobId, false, errMsg);
      // 4xx (excluding 408/429) = client_error; 5xx and 408/429 = server_error.
      // Lets dashboards separate "their bug" from "their downtime".
      const isClientError =
        res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 408 && res.statusCode !== 429;
      webhookAttemptsTotal.inc({ outcome: isClientError ? 'client_error' : 'server_error' });
      log.warn({ jobId, attempt, status: res.statusCode }, 'webhook non-2xx');

      if (isClientError) return;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await jobsRepo.recordWebhookAttempt(jobId, false, errMsg);
      webhookAttemptsTotal.inc({ outcome: 'network_error' });
      log.warn({ jobId, attempt, err: errMsg }, 'webhook attempt failed');
    }

    if (attempt < maxAttempts) {
      const backoffMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
      await delay(backoffMs);
    }
  }
  log.error({ jobId, attempts: maxAttempts }, 'webhook delivery exhausted');
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
