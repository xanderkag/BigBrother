/**
 * Prometheus metrics for doc-service.
 *
 * Exposes a `/metrics` endpoint (registered in server.ts) that Prometheus
 * scrapes on a schedule. Default Node.js process metrics (heap, event-loop
 * lag, gc) come for free from prom-client; on top we add domain-specific
 * counters and histograms.
 *
 * Naming follows the Prometheus convention `<service>_<noun>_<unit>` and
 * standard unit suffixes (`_seconds`, `_total`, `_bytes`). Labels stay
 * low-cardinality — `status` is one of five values, `document_type` one
 * of six. No per-request labels like `job_id`.
 */

import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'doc-service' });

// Node.js runtime metrics: heap usage, event-loop lag, GC pauses, etc.
collectDefaultMetrics({ register: registry });

// --- Job lifecycle ---

export const jobsTotal = new Counter({
  name: 'docservice_jobs_total',
  help: 'Total jobs finalized by the worker, split by terminal status and detected document type.',
  labelNames: ['status', 'document_type'] as const,
  registers: [registry],
});

export const jobsDurationSeconds = new Histogram({
  name: 'docservice_jobs_duration_seconds',
  help: 'End-to-end processing time from queue pickup to terminal status.',
  labelNames: ['document_type', 'outcome'] as const,
  // Document processing typically falls in 1s..2min range; buckets chosen
  // to cover that span without too many empty bins.
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [registry],
});

// --- OCR pipeline ---

export const ocrEngineDurationSeconds = new Histogram({
  name: 'docservice_ocr_engine_duration_seconds',
  help: 'Per-engine OCR call duration. `outcome` is one of: accepted | rejected | error.',
  labelNames: ['engine', 'outcome'] as const,
  // pdf-parse is millisecond-fast on text PDFs; tesseract & vision-llm can
  // take tens of seconds on big scans. Same span as jobs.
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
  registers: [registry],
});

// --- LLM client ---

export const llmCallsTotal = new Counter({
  name: 'docservice_llm_calls_total',
  help: 'Calls made to the inference-service from doc-service, split by endpoint and outcome.',
  labelNames: ['endpoint', 'outcome'] as const, // outcome: success | error
  registers: [registry],
});

export const llmCallDurationSeconds = new Histogram({
  name: 'docservice_llm_call_duration_seconds',
  help: 'Round-trip duration of LLM HTTP calls.',
  labelNames: ['endpoint'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

// --- Webhook delivery ---

export const webhookAttemptsTotal = new Counter({
  name: 'docservice_webhook_attempts_total',
  help: 'Webhook delivery attempts, including retries. `outcome` is success | client_error | server_error | network_error.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
