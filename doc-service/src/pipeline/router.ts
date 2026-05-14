import type { OcrEngine, OcrInput } from './ocr/types.js';

/**
 * Slug'и документов, у которых традиционно есть PII (паспортные данные
 * водителя, номера телефонов, домашние адреса). Используется для глобального
 * YANDEX_DISABLE_FOR_PII — выключает облачный OCR для этих типов независимо
 * от per-job metadata.
 */
const PII_DOCUMENT_TYPES = new Set(['TTN', 'CMR']);

/**
 * Опции для построения OCR-цепочки. Передаются из orchestrator с per-job
 * контекстом — позволяют отключить отдельные движки для конкретного документа.
 */
export type ChainOptions = {
  /**
   * Per-job opt-out из внешних (cloud) OCR-движков. Берётся из job.metadata
   * через `metadata._disable_external_ocr === true`. Текущая реализация
   * выкидывает только Yandex; в будущем сюда же добавится cloud-vision-llm
   * когда LLM_INFERENCE_URL будет смотреть в облако.
   */
  disableExternalOcr?: boolean;
  /**
   * Глобальный флаг YANDEX_DISABLE_FOR_PII из env. Если true и document_type
   * в PII_DOCUMENT_TYPES — Yandex выкидывается. Не требует per-job настройки
   * от клиента.
   */
  disableYandexForPii?: boolean;
  /** Slug типа документа (из classifier или document_hint). */
  documentType?: string;
};

/**
 * Build the ordered list of OCR engines to try for a given input.
 *
 * Rules:
 *   - Skip engines that cannot handle the mime type (`supports`).
 *   - Skip engines that are not configured (`isAvailable`).
 *   - I8: skip Yandex if `disableExternalOcr` (per-job) или
 *     `disableYandexForPii && documentType is PII-document` (global env).
 *   - Order is fixed: pdf-text → tesseract → vision-llm → yandex.
 *     The orchestrator stops as soon as one engine clears its acceptance threshold.
 */
export function selectOcrChain(
  engines: readonly OcrEngine[],
  input: OcrInput,
  options: ChainOptions = {},
): OcrEngine[] {
  const isPiiDoc = options.documentType
    ? PII_DOCUMENT_TYPES.has(options.documentType)
    : false;
  return engines.filter((e) => {
    if (!e.isAvailable()) return false;
    if (!e.supports(input)) return false;
    // I8: PII opt-out для Yandex (per-job или глобальный для PII-типов)
    if (e.name === 'yandex' && options.disableExternalOcr) return false;
    if (e.name === 'yandex' && options.disableYandexForPii && isPiiDoc) return false;
    return true;
  });
}
