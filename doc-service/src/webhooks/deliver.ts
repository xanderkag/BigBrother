import { createHmac } from 'node:crypto';
import { request } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.js';
import { jobsRepo } from '../storage/jobs.js';
import { webhookAttemptsTotal } from '../metrics.js';
import type { Logger } from 'pino';

/**
 * Версия СХЕМЫ полей (extracted field-set), отдельная от версии контракта
 * envelope'а (`version: 'v1'`). SLAI просил drift-маркер: envelope остаётся
 * v1, а этот маркер бампается когда меняется набор/семантика полей внутри
 * `extracted`. Конвенция — semver-строка "MAJOR.MINOR".
 * НЕ путать с `extracted._match_signals.schema_version` (тот скоупит
 * проекцию match-сигналов, не общий контракт).
 */
export const WEBHOOK_SCHEMA_VERSION = '1.0';

export type WebhookPayload = {
  /**
   * Версия контракта вебхука. Введена 2026-05-18 после SLAI EOD-отчёта
   * (Issue #4) — их валидатор ожидает `version` как обязательное поле,
   * без него возвращает HTTP 400 «Missing job_id or version».
   *
   * Текущее значение всегда 'v1'. Если контракт меняется ломающе —
   * бампаем до 'v2', SLAI-сторона решает что делать со старыми.
   */
  version: 'v1';
  /**
   * Drift-маркер набора полей `extracted`. См. WEBHOOK_SCHEMA_VERSION.
   * Top-level, sibling к `version` — SLAI читает его отдельно от envelope.
   */
  schema_version: string;
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
  // F5 (2026-05-17): multi-document PDF — массив найденных документов
  // с их страничными диапазонами. Заполняется ТОЛЬКО если в PDF
  // найдено > 1 типа документа (иначе backwards-compatible single-doc
  // через `extracted`). См. pipeline/multidoc/types.ts.
  documents?: Array<{
    page_range: string;
    document_type: string | null;
    confidence: number;
    extracted: Record<string, unknown>;
    field_confidence?: Record<string, number>;
  }>;
  /**
   * EXT-HINT-1 (SLAI 2026-06-03): подсказка к целевой сущности на стороне
   * SLAI matcher. Проставляется парсдоксом если в extracted найден хоть
   * один транспортный сигнал (order_ref / vehicle.plate / route_from+to /
   * permit_no). Иначе отсутствует. Текущее значение — 'Transportation'.
   * Расширяется по мере появления новых use-case'ов.
   */
  target_entity_hint?: 'Transportation';
};

/**
 * Вычислить target_entity_hint по содержимому extracted. Используется
 * webhook-delivery: если в счёте найден хоть один транспортный сигнал
 * (order_ref / vehicle.plate / route_from+route_to / permit_no) — это
 * перевозочный счёт, проставляем хинт. Иначе undefined.
 */
export function computeTargetEntityHint(
  extracted: Record<string, unknown> | null,
): 'Transportation' | undefined {
  if (!extracted) return undefined;
  if (extracted.order_ref) return 'Transportation';
  if (extracted.permit_no) return 'Transportation';
  const v = extracted.vehicle as Record<string, unknown> | undefined;
  if (v && typeof v.plate === 'string' && v.plate.length > 0) return 'Transportation';
  if (extracted.route_from && extracted.route_to) return 'Transportation';
  return undefined;
}

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
  /**
   * Опц. override HMAC-секрета для подписи. По умолчанию — глобальный
   * config.webhook.hmacSecret (today's behavior). Phase 3 (CP7): для
   * per-consumer webhook'а передаём расшифрованный per-org секрет, чтобы
   * каждый потребитель верифицировал своим ключом.
   */
  hmacSecret: string = config.webhook.hmacSecret,
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = sign(body, hmacSecret);

  const maxAttempts = config.webhook.maxAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 2026-06-03 (SLAI): обязательный header контракт-версии. Их новый
          // verify-guard на negabarit-стенде использует его для маршрутизации
          // на нужный contract-handler (v1 vs будущие v2). Без него guard
          // отбрасывает 401 «Invalid parsdocs signature» (misleading message —
          // на самом деле header missing). Значение совпадает с payload.version.
          'x-parsdocs-version': 'v1',
          // 2026-05-18 (SLAI Issue #5): дублируем подпись под их header'ом.
          // SLAI ищет `X-Parsdocs-Signature` (см. их HMAC verifier);
          // старый `x-docservice-signature` оставляем для backwards-compat
          // на случай если другие потребители завязались на него. Через
          // 1-2 месяца после миграции SLAI старый header можно убрать.
          //
          // EXT-A (2026-05-26): добавлен extractor-agnostic alias
          // `X-Extractor-Signature` — SLAI новый `ExtractorGateway` ищет
          // именно его (parsdocs — один из adapter'ов, имя в подписи не
          // должно его выдавать). Future consumer-микросервисы тоже могут
          // полагаться на этот общий header без знания что внутри parsdocs.
          'x-extractor-signature': `sha256=${signature}`,
          'x-extractor-job-id': jobId,
          'x-extractor-attempt': String(attempt),
          'x-parsdocs-signature': `sha256=${signature}`,
          'x-parsdocs-job-id': jobId,
          'x-parsdocs-attempt': String(attempt),
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
