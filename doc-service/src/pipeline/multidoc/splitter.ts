/**
 * F5: разбиение многостраничного PDF на сегменты по типам документов.
 *
 * Алгоритм (greedy consecutive grouping):
 *   1. Получаем page-by-page классификации (одна на страницу)
 *   2. Идём последовательно, склеиваем подряд идущие страницы с тем же
 *      document_type
 *   3. При смене типа — открываем новый сегмент
 *   4. Низкоуверенные страницы (confidence < threshold) присоединяются
 *      к предыдущему сегменту а не образуют свой — иначе шумовые
 *      «продолжения УПД» классифицировались бы как отдельный документ
 *
 * Edge cases:
 *   - Все страницы одного типа → один сегмент (фактически = single-doc
 *     поведение, backwards-compatible)
 *   - Перемешка типов («счёт, ТТН, счёт, ТТН» через 1 страницу) → не
 *     склеиваем непоследовательные, это явный multi-doc
 *   - Пустые страницы (text_preview короткий) → присоединяем к
 *     предыдущему сегменту
 */
import type { PageClassification, DocumentSegment, DocIdentity } from './types.js';
import type { DocumentTypeSlug } from '../../types/documents.js';
import {
  detectDocumentStart,
  extractPageIdentity,
  identityConflicts,
  type BoundaryHit,
} from './boundaries.js';

export interface SplitOptions {
  /**
   * Если confidence страницы ниже — не открываем новый сегмент, а
   * присоединяем к предыдущему. По умолчанию 0.4.
   */
  minConfidenceForNewSegment?: number;
  /**
   * Минимальная длина text_preview чтобы страница считалась «не пустой».
   * Пустые страницы (короткие) присоединяются к предыдущему сегменту.
   */
  minTextLengthForClassification?: number;
  /**
   * §P0-2: floor уверенности для сегмента, открытого hard-boundary
   * (перезапись low-conf классификатора). По умолчанию 0.6.
   */
  boundaryConfidenceFloor?: number;
  /**
   * §P0-3: kill-switch детектора границ (SEGMENT_HARD_BOUNDARY). false →
   * чистое keyword-поведение (как до v2). По умолчанию true.
   */
  useBoundaries?: boolean;
}

const DEFAULT_MIN_CONF = 0.4;
const DEFAULT_MIN_TEXT = 100; // символов
const DEFAULT_BOUNDARY_FLOOR = 0.6;

function isEmptyIdentity(id: DocIdentity | undefined): boolean {
  return !id || (!id.invoice_no && !id.mrn && !id.arc && !id.order_no);
}

export function splitPagesIntoSegments(
  pages: PageClassification[],
  pageTexts: string[],
  opts: SplitOptions = {},
): DocumentSegment[] {
  const minConf = opts.minConfidenceForNewSegment ?? DEFAULT_MIN_CONF;
  const minText = opts.minTextLengthForClassification ?? DEFAULT_MIN_TEXT;
  const boundaryFloor = opts.boundaryConfidenceFloor ?? DEFAULT_BOUNDARY_FLOOR;
  const useBoundaries = opts.useBoundaries ?? true;

  if (pages.length === 0) return [];
  // Sanity: pageTexts должен быть параллелен pages по индексам (0..N-1)
  if (pageTexts.length !== pages.length) {
    throw new Error(
      `splitPagesIntoSegments: pageTexts.length (${pageTexts.length}) != pages.length (${pages.length})`,
    );
  }

  const segments: DocumentSegment[] = [];
  let current: DocumentSegment | null = null;

  /** Открыть сегмент по hard-boundary (перезапись типа классификатора). */
  const openBoundary = (
    page: PageClassification,
    text: string,
    slug: DocumentSegment['document_type'],
    identity: DocIdentity,
  ): DocumentSegment => ({
    document_type: slug,
    page_from: page.page,
    page_to: page.page,
    confidence: Math.max(page.confidence, boundaryFloor),
    combined_text: text,
    boundary: slug,
    identity,
  });

  /** Открыть сегмент по классификатору (историческое поведение). */
  const openKeyword = (
    page: PageClassification,
    text: string,
    identity: DocIdentity,
  ): DocumentSegment => ({
    document_type: page.document_type,
    page_from: page.page,
    page_to: page.page,
    confidence: page.confidence,
    combined_text: text,
    boundary: null,
    identity,
  });

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const text = pageTexts[i] ?? '';

    // §P0-2: hard-boundary детектор поверх keyword-классификации.
    // useBoundaries=false (SEGMENT_HARD_BOUNDARY) → чистое keyword-поведение.
    const prevSummary: { slug: DocumentTypeSlug | null; identity: DocIdentity | undefined } | null =
      current ? { slug: current.document_type, identity: current.identity } : null;
    // §FIX-1: пред-установленная граница страницы (VLM по картинке, напр. СТС,
    // которую текст не поймал) — жёсткий приоритет над текстовым детектором.
    const boundary: BoundaryHit | null = page.boundary
      ? { slug: page.boundary, identity: page.identity ?? extractPageIdentity(text) }
      : useBoundaries
        ? detectDocumentStart(text, prevSummary)
        : null;
    const identity: DocIdentity =
      boundary?.identity ?? (useBoundaries ? extractPageIdentity(text) : {});

    // Пустая / низко-уверенная / без типа — кандидаты на присоединение
    const isEmpty = text.trim().length < minText;
    const isLowConf = page.confidence < minConf;
    const noType = page.document_type === null;

    if (current === null) {
      current = boundary
        ? openBoundary(page, text, boundary.slug, identity)
        : openKeyword(page, text, identity);
      continue;
    }

    // 1. Сработала hard-boundary → всегда новый сегмент (detectDocumentStart
    //    уже вернул null для continuation/back-reference того же документа).
    if (boundary) {
      segments.push(current);
      current = openBoundary(page, text, boundary.slug, identity);
      continue;
    }

    // 2. Inline retro-split: mid-страница несёт invoice_no/mrn, отличный от
    //    identity открытия сегмента → это новый документ, чей заголовок OCR
    //    не поймал якорем. Закрываем сегмент, открываем keyword-сегмент.
    if (identityConflicts(identity, current.identity)) {
      segments.push(current);
      current = openKeyword(page, text, identity);
      continue;
    }

    // 3. Continuation-rule: сегмент, открытый hard-boundary, поглощает
    //    последующие безъякорные страницы ДАЖЕ при смене типа классификатором
    //    (стр. 2-4 инвойса теряют «Invoice No» и выглядят как packing/spec).
    //    Для keyword-открытых сегментов (xlsx-листы) — историческое поведение.
    const attachByContinuation = current.boundary != null;

    const shouldAttach =
      isEmpty ||
      isLowConf ||
      noType ||
      page.document_type === current.document_type ||
      attachByContinuation;

    if (shouldAttach) {
      current.page_to = page.page;
      current.combined_text = current.combined_text + '\n\n' + text;
      const pageCount = page.page - current.page_from + 1;
      const prevAvg = current.confidence;
      current.confidence =
        (prevAvg * (pageCount - 1) + (isEmpty || isLowConf ? prevAvg : page.confidence)) /
        pageCount;
      // Накапливаем identity сегмента, если открытие было без неё.
      if (isEmptyIdentity(current.identity) && !isEmptyIdentity(identity)) {
        current.identity = identity;
      }
    } else {
      segments.push(current);
      current = openKeyword(page, text, identity);
    }
  }

  if (current !== null) segments.push(current);

  // Округление confidence до 3 знаков (косметика)
  for (const seg of segments) {
    seg.confidence = Math.round(seg.confidence * 1000) / 1000;
  }

  return segments;
}

/**
 * Heuristic: должны ли мы вообще включать multi-doc обработку для
 * этого результата классификации? Если все страницы одного типа —
 * нет смысла, single-doc pipeline быстрее и backwards-compatible.
 *
 * Логика (relaxed 2026-05-18):
 *   - ≥2 сегмента: обязательно
 *   - ≥2 сегмента с известным document_type (любым) и confidence ≥0.5
 *     OR ≥2 сегмента с разными document_type — это multi-doc
 *
 * Real-case ci-pl.xls: один sheet «Commercial Invoice», второй
 * «Packing List». Если classifier дал на оба confident type — multi-doc.
 * Если на один из них classifier неуверен (null) — оба сегмента всё
 * равно нужно extract'ить отдельно (через LLM per sheet), потому что
 * sheets физически разные документы. Поэтому даже 2 segment'а с одним
 * known типом и одним unknown считаем multi-doc если оба нужно
 * обработать через LLM.
 */
export function isMultiDocument(segments: DocumentSegment[], typedConf = 0.5): boolean {
  if (segments.length < 2) return false;
  // Триггерим multi-doc когда хотя бы один сегмент имеет confident type.
  // Остальные segments runner попробует extract'ить как unknown (через
  // LLM-classify в processDocumentPipeline). Если все попытки failed —
  // runner сам возвращает null → fall back to single-doc.
  //
  // Раньше требовали ≥2 distinct types с high conf — это бракoвало
  // valid CI+PL кейсы где classifier неуверен на одном из листов.
  //
  // §P0-2: сегмент, открытый hard-boundary, считается typed БЕЗУСЛОВНО
  // (граница = сильный сигнал реального документа), независимо от порога.
  let typedCount = 0;
  for (const s of segments) {
    if (s.boundary) {
      typedCount += 1;
      continue;
    }
    if (s.document_type && s.confidence >= typedConf) typedCount += 1;
  }
  // Multi-doc если ≥1 segment classified + ≥2 segments total. Runner
  // решит что делать с unclassified в своём loop'е.
  return typedCount >= 1;
}
