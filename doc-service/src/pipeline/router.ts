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
  /**
   * YANDEX_PREFER_FOR_SCANS. Когда true и Yandex остался в цепочке после
   * всех фильтров — двигаем его вперёд локальных scan-движков (tesseract,
   * vision-llm), оставляя нативные текстовые движки (pdf-text/xlsx/docx)
   * впереди. PII-фильтр выше: если Yandex выкинут, переупорядочивать нечего.
   */
  preferYandexForScans?: boolean;
};

/**
 * Движки, работающие по растру (скан/картинка). Только их обгоняет Yandex
 * при preferYandexForScans — нативные текстовые движки (pdf-text/xlsx/docx)
 * остаются впереди (Yandex не нужен на чистом текстовом слое).
 */
const LOCAL_SCAN_ENGINES = new Set(['tesseract', 'vision-llm']);

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
  const chain = engines.filter((e) => {
    if (!e.isAvailable()) return false;
    if (!e.supports(input)) return false;
    // I8: PII opt-out для Yandex (per-job или глобальный для PII-типов)
    if (e.name === 'yandex' && options.disableExternalOcr) return false;
    if (e.name === 'yandex' && options.disableYandexForPii && isPiiDoc) return false;
    return true;
  });

  // YANDEX_PREFER_FOR_SCANS: если Yandex остался в цепочке, ставим его перед
  // первым локальным scan-движком. Нативные текстовые движки (pdf-text и пр.)
  // остаются впереди — переставляем только относительно tesseract/vision-llm.
  if (options.preferYandexForScans) {
    const yandexIdx = chain.findIndex((e) => e.name === 'yandex');
    if (yandexIdx >= 0) {
      const firstScanIdx = chain.findIndex((e) => LOCAL_SCAN_ENGINES.has(e.name));
      if (firstScanIdx >= 0 && firstScanIdx < yandexIdx) {
        const [yandex] = chain.splice(yandexIdx, 1);
        chain.splice(firstScanIdx, 0, yandex!);
      }
    }
  }

  return chain;
}
