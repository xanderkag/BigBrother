/**
 * Финальная webhook-доставка для готового job'а.
 *
 * Вынесено из orchestrator.ts чтобы держать processJobInner на длине,
 * которая помещается на экран целиком. Здесь — единственное место,
 * где собираются три conditional-обработчика, специфичные для отдачи
 * клиенту:
 *
 *   1. F2 (per-field confidence) — извлечь `_field_confidence` из
 *      extracted в top-level webhook payload. Калибруется по
 *      checksum'ам ИНН и нормализации plate. См. normalize/field-confidence.ts.
 *
 *   2. F4 (PII redaction) — если клиент задал `metadata.redact_pii=true`,
 *      то extracted и metadata отправляются в редактированном виде.
 *      БД-хранилище остаётся **не**-редактированным (для аудита и
 *      ручной переотправки оператором). См. normalize/pii-redact.ts.
 *
 *   3. F27 (immediate delete after delivery) — если клиент задал
 *      `metadata.delete_after_processing=true`, файл-оригинал удаляется
 *      сразу после успешной доставки webhook'а. `jobs.file_path` NULL'ится
 *      для аудита (БД-row остаётся). Use case: документы с PII
 *      (паспорт водителя в ТТН) — клиент не хочет, чтобы оригинал
 *      лежал 30 дней default retention.
 *
 * Ошибки F27 ловим в try/catch и логгируем как warn — основной pipeline
 * не блокируется (sweeper подберёт через 30 дней).
 */
import type { Logger } from 'pino';
import { deliverWebhook, computeTargetEntityHint } from '../webhooks/deliver.js';
import { jobsRepo, type JobRow } from '../storage/jobs.js';
import { removeStoredFile } from '../storage/files.js';
import { redactPii } from './normalize/pii-redact.js';
import { processFieldConfidence } from './normalize/field-confidence.js';
import { normalizeSlugForApi } from '../types/slug-normalize.js';
import { stripInlineCredentials } from './llm/inline-credentials.js';

/**
 * Доставить webhook для финализированного job'а, применив F2/F4
 * трансформации и опц. F27 delete-after-processing.
 *
 * Вызывается только когда есть куда доставлять — выбор URL/секрета делает
 * caller (orchestrator.processJobInner) по precedence-правилам.
 *
 * Phase 3 (CP7): `override` позволяет caller'у направить доставку на
 * per-org profile webhook с per-org секретом. Если override не передан —
 * используется `updated.webhook_url` + глобальный секрет (today's behavior,
 * backwards compat для explicit per-job webhook_url).
 */
export async function deliverFinalizedJobWebhook(
  updated: JobRow,
  jobId: string,
  log: Logger,
  override?: { url?: string; hmacSecret?: string },
): Promise<void> {
  // F2: per-field confidence — извлекаем `_field_confidence` из extracted
  // в top-level webhook payload. Калибруем по checksum ИНН и нормализации
  // госномера. См. pipeline/normalize/field-confidence.ts.
  const fcResult = processFieldConfidence(
    updated.extracted as Record<string, unknown> | null,
  );
  const extractedAfterFc = fcResult.cleanedExtracted;
  const fieldConfidence = fcResult.fieldConfidence;

  // F5: multi-doc extraction. Если orchestrator положил
  // `_multidoc_documents` в extracted — это массив найденных документов
  // (для multi-sheet xlsx или multi-page PDF когда внутри один файл с
  // несколькими типами). Вытаскиваем для webhook payload.documents и
  // убираем из extracted (это служебное поле).
  const multidocRaw = extractedAfterFc?._multidoc_documents;
  const documents =
    Array.isArray(multidocRaw) && multidocRaw.length > 0
      ? (multidocRaw as Array<{
          page_range: string;
          document_type: string | null;
          confidence: number;
          extracted: Record<string, unknown>;
          field_confidence?: Record<string, number>;
        }>).map((d) => ({
          ...d,
          document_type: normalizeSlugForApi(d.document_type),
        }))
      : undefined;
  const extractedNoMultidoc: Record<string, unknown> | null = extractedAfterFc
    ? Object.fromEntries(
        Object.entries(extractedAfterFc).filter(([k]) => k !== '_multidoc_documents'),
      )
    : null;

  // F4: PII redaction перед отправкой webhook'а. Управляется флагом
  // `metadata.redact_pii: true` который клиент ставит при создании job'а
  // (через query-param `?redact_pii=true` или поле в metadata).
  // Если редактим — extracted и metadata пишутся в payload в редактированном
  // виде; БД-хранилище остаётся как было (для аудита и переотправки
  // оператором). См. routes/jobs.ts и pipeline/normalize/pii-redact.ts.
  // EXT-B: вычищаем reserved-ключ _inline_llm_creds (encrypted BYO-envelope)
  // до любых трансформаций — он не должен уходить в webhook третьему лицу.
  const meta = stripInlineCredentials(
    (updated.metadata ?? null) as Record<string, unknown> | null,
  );
  const shouldRedact = meta && (meta.redact_pii === true || meta.redact_pii === 'true');
  const extractedOut = shouldRedact ? redactPii(extractedNoMultidoc) : extractedNoMultidoc;
  const metadataOut = shouldRedact ? redactPii(meta) : meta;

  const targetUrl = override?.url ?? updated.webhook_url!;
  await deliverWebhook(
    jobId,
    targetUrl,
    {
      // 2026-05-18 (SLAI Issue #4): обязательное поле контракта v1.
      version: 'v1',
      job_id: updated.id,
      status: updated.status,
      // 2026-05-18 (SLAI Issue #3): нормализация slug → lowercase snake_case.
      document_type: normalizeSlugForApi(updated.document_type),
      confidence: updated.confidence === null ? null : Number(updated.confidence),
      ocr_engine: updated.ocr_engine,
      extracted: extractedOut,
      metadata: metadataOut,
      error: updated.error,
      _field_confidence: Object.keys(fieldConfidence).length > 0 ? fieldConfidence : undefined,
      // F5: массив найденных документов если xlsx/PDF был multi-doc.
      // При single-doc отсутствует (backwards compat).
      documents,
      // EXT-HINT-1: hint для SLAI matcher что счёт перевозочный (есть хоть
      // один транспортный сигнал: order_ref/permit_no/vehicle.plate/route).
      // На редактированном extractedOut, не на raw — чтобы PII-redact не
      // мог удалить сигнал и оставить hint висящим.
      target_entity_hint: computeTargetEntityHint(extractedOut),
    },
    log,
    override?.hmacSecret,
  );

  // F27 (SLAI ТЗ): immediate delete оригинала после webhook delivery
  // если клиент попросил через metadata.delete_after_processing.
  // Use case: документы с PII (паспорт водителя в ТТН) — клиент не
  // хочет чтобы оригинал лежал у нас 30 дней default retention.
  // jobs.file_path NULLed для аудита (БД-row остаётся).
  const wantsDelete =
    meta && (meta.delete_after_processing === true || meta.delete_after_processing === 'true');
  if (wantsDelete && updated.file_path) {
    try {
      await removeStoredFile(updated.file_path);
      await jobsRepo.markFileDeleted(updated.id);
      log.info({ jobId, file_path: updated.file_path }, 'file deleted after processing (F27)');
    } catch (err) {
      // Best-effort — не блокируем основной pipeline. Sweeper подберёт
      // через 30 дней если immediate delete не удался.
      log.warn({ err, jobId }, 'F27 immediate delete failed; sweeper will retry');
    }
  }
}
