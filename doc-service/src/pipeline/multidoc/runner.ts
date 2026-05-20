/**
 * Multi-document orchestrator helper.
 *
 * Реализует F5 MVP для **xlsx multi-sheet** кейса (CI+PL в одном xls).
 * Full PDF F5 (per-page classify) — отдельный sprint, нужен page-level
 * OCR pipeline.
 *
 * Сценарий xlsx:
 *   - XlsxEngine выдал OcrResult.pages = [Sheet1, Sheet2, Sheet3]
 *   - Каждая страница (=sheet) классифицируется отдельно через
 *     KeywordClassifier
 *   - Если minimum 2 sheet'а с разными типами и high confidence →
 *     multi-doc path: per-sheet extract в LLM
 *   - Если все одного типа или некоторые null → fallback на обычный
 *     single-doc (XlsxEngine.text как обычно)
 *
 * Output: массив ExtractedDocumentEntry для webhook payload.documents[].
 * Bull pipeline уже умеет это через WebhookPayload.documents (F5 type).
 */
import type { Logger } from 'pino';
import type { OcrResult } from '../ocr/types.js';
import type { Classifier } from '../classifier/types.js';
import type { DocumentTypeSlug } from '../../types/documents.js';
import type {
  ExtractedDocumentEntry,
  PageClassification,
} from './types.js';
import { splitPagesIntoSegments, isMultiDocument } from './splitter.js';

export interface MultiDocRunnerDeps {
  classifier: Classifier;
  /**
   * CP7: organization job'а — прокидывается в per-page classify чтобы
   * scope активного набора типов совпадал с single-doc путём. null/undefined
   * ⇒ globals-only.
   */
  organizationId?: string | null;
  /**
   * Запускает per-segment LLM extract. Возвращает extracted + per-field
   * confidence для сегмента. Принимает text сегмента + предсказанный тип.
   * Используется тот же `runDocumentPipeline` что и для single-doc, но
   * с фиксированным `hint` чтобы classifier повторно не выбирал тип.
   */
  extractSegment: (
    text: string,
    documentType: DocumentTypeSlug,
    log: Logger,
  ) => Promise<{
    extracted: Record<string, unknown>;
    fieldConfidence?: Record<string, number>;
  }>;
  log: Logger;
}

/**
 * Анализирует OCR pages и решает: multi-doc или single-doc.
 * Если multi-doc — запускает per-segment extract.
 *
 * Returns:
 *   - null — нет multi-doc, нужен обычный single-doc pipeline
 *   - documents[] — массив extracted entries (≥ 1)
 */
export async function tryMultiDoc(
  ocr: OcrResult,
  deps: MultiDocRunnerDeps,
): Promise<ExtractedDocumentEntry[] | null> {
  const { classifier, extractSegment, log, organizationId } = deps;

  // Pre-flight: нужны ≥ 2 pages
  if (!ocr.pages || ocr.pages.length < 2) return null;

  // Classify each page (sheet) отдельно
  const pageClassifications: PageClassification[] = [];
  for (let i = 0; i < ocr.pages.length; i += 1) {
    const page = ocr.pages[i]!;
    const cls = await classifier.classify(page.text, organizationId ?? null);
    pageClassifications.push({
      page: i + 1, // 1-indexed
      document_type: cls.type,
      confidence: cls.confidence,
      text_preview: page.text.slice(0, 500),
    });
  }

  // Splitter превращает page-by-page classify в segments
  const segments = splitPagesIntoSegments(
    pageClassifications,
    ocr.pages.map((p) => p.text),
  );

  // Heuristic: реально ли multi-doc или один тип на все страницы?
  if (!isMultiDocument(segments)) {
    log.info(
      { sheets: ocr.pages.length, distinctSegments: segments.length },
      'multi-doc not detected — falling back to single-doc',
    );
    return null;
  }

  log.info(
    {
      sheets: ocr.pages.length,
      segmentsCount: segments.length,
      types: segments.map((s) => s.document_type),
    },
    'multi-doc detected, running per-segment extract',
  );

  // Per-segment extract
  const documents: ExtractedDocumentEntry[] = [];
  for (const seg of segments) {
    if (!seg.document_type) {
      // Skip segments без type — classifier не уверен что это
      log.warn({ page_range: `${seg.page_from}-${seg.page_to}` }, 'segment without type, skipping');
      continue;
    }
    try {
      const { extracted, fieldConfidence } = await extractSegment(
        seg.combined_text,
        seg.document_type,
        log,
      );
      documents.push({
        page_range:
          seg.page_from === seg.page_to
            ? String(seg.page_from)
            : `${seg.page_from}-${seg.page_to}`,
        document_type: seg.document_type,
        confidence: seg.confidence,
        extracted,
        field_confidence: fieldConfidence,
      });
    } catch (err) {
      log.warn(
        { err, page_range: `${seg.page_from}-${seg.page_to}`, type: seg.document_type },
        'multi-doc segment extract failed, skipping',
      );
    }
  }

  // Если все сегменты failed — fall back to single-doc
  if (documents.length === 0) {
    log.warn('multi-doc: all segments failed extract, falling back');
    return null;
  }

  return documents;
}
