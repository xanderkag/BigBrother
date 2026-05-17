/**
 * F5 (SLAI ТЗ): типы для multi-document PDF.
 *
 * Сценарий: SLAI шлёт PDF где в одном файле собран пакет документов на
 * сделку — счёт (стр. 1), УПД (стр. 2-3), счёт-фактура (стр. 4). Сейчас
 * мы парсим всё как один документ и теряем 2-й и 3-й.
 *
 * После F5 webhook payload получает новое опциональное поле
 * `documents: Array<ExtractedDocumentEntry>`. Каждый entry — отдельный
 * найденный документ с его страничным диапазоном.
 *
 * **Backwards compatibility:**
 *   - Если PDF содержит ровно один документ — payload.extracted остаётся
 *     как обычно (v1 behaviour), `documents` не присылается
 *   - Если найдено > 1 — payload.extracted = первый/доминирующий,
 *     payload.documents = массив всех
 *   - Это compatible (v1) — старые receiver'ы продолжат читать `extracted`
 *
 * **Version bump до v2** — когда захотим заменить `extracted` целиком
 * на массив. Сейчас (v1) держим оба поля для плавной миграции.
 */
import type { DocumentTypeSlug } from '../../types/documents.js';

export interface ExtractedDocumentEntry {
  /**
   * Диапазон страниц где найден этот документ. 1-indexed для совместимости
   * с PDF-нумерацией. Формат: "1" / "2-4" / "5,7-9" — гибкий, но MVP
   * использует только "N" и "N-M".
   */
  page_range: string;

  /** Тип найденного документа (наш slug или SLAI alias) */
  document_type: DocumentTypeSlug | null;

  /**
   * Уверенность классификации страниц этого сегмента (от 0 до 1).
   * Усреднённая по страницам.
   */
  confidence: number;

  /** Полный extracted JSON по этому сегменту (как обычный jobs.extracted) */
  extracted: Record<string, unknown>;

  /** Per-field confidence (F2) для этого сегмента */
  field_confidence?: Record<string, number>;
}

/**
 * Результат page-by-page классификации перед split. Один entry на страницу.
 */
export interface PageClassification {
  /** 1-indexed page number */
  page: number;
  /** Slug классифицированного типа или null если не определилось */
  document_type: DocumentTypeSlug | null;
  /** Confidence классификатора 0..1 */
  confidence: number;
  /** Первые ~500 символов raw OCR (для debug) */
  text_preview: string;
}

/**
 * Сегмент — последовательность страниц одного типа.
 */
export interface DocumentSegment {
  /** Slug типа документа этого сегмента */
  document_type: DocumentTypeSlug | null;
  /** 1-indexed range, inclusive */
  page_from: number;
  page_to: number;
  /** Усреднённая confidence страниц сегмента */
  confidence: number;
  /** raw OCR-текст всех страниц сегмента (для extract) */
  combined_text: string;
}

/**
 * Сериализованный page_range из сегмента. "5" если одна страница, "2-4"
 * если несколько последовательных.
 */
export function formatPageRange(seg: { page_from: number; page_to: number }): string {
  if (seg.page_from === seg.page_to) return String(seg.page_from);
  return `${seg.page_from}-${seg.page_to}`;
}
