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
import type { PageClassification, DocumentSegment } from './types.js';

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
}

const DEFAULT_MIN_CONF = 0.4;
const DEFAULT_MIN_TEXT = 100; // символов

export function splitPagesIntoSegments(
  pages: PageClassification[],
  pageTexts: string[],
  opts: SplitOptions = {},
): DocumentSegment[] {
  const minConf = opts.minConfidenceForNewSegment ?? DEFAULT_MIN_CONF;
  const minText = opts.minTextLengthForClassification ?? DEFAULT_MIN_TEXT;

  if (pages.length === 0) return [];
  // Sanity: pageTexts должен быть параллелен pages по индексам (0..N-1)
  if (pageTexts.length !== pages.length) {
    throw new Error(
      `splitPagesIntoSegments: pageTexts.length (${pageTexts.length}) != pages.length (${pages.length})`,
    );
  }

  const segments: DocumentSegment[] = [];
  let current: DocumentSegment | null = null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const text = pageTexts[i] ?? '';

    // Пустая страница (или почти пустая) — присоединяем к текущему сегменту
    const isEmpty = text.trim().length < minText;
    // Низкая уверенность — то же
    const isLowConf = page.confidence < minConf;
    // Отсутствие type → не можем открыть новый сегмент
    const noType = page.document_type === null;

    if (current === null) {
      // Первая страница — открываем сегмент даже если low-conf (нет
      // куда присоединить)
      current = {
        document_type: page.document_type,
        page_from: page.page,
        page_to: page.page,
        confidence: page.confidence,
        combined_text: text,
      };
      continue;
    }

    const shouldAttach =
      isEmpty ||
      isLowConf ||
      noType ||
      page.document_type === current.document_type;

    if (shouldAttach) {
      // Продлеваем текущий сегмент
      current.page_to = page.page;
      current.combined_text = current.combined_text + '\n\n' + text;
      // confidence: пересчёт как «running average» с весом каждой страницы
      const pageCount = page.page - current.page_from + 1;
      const prevAvg = current.confidence;
      current.confidence =
        (prevAvg * (pageCount - 1) + (isEmpty || isLowConf ? prevAvg : page.confidence)) /
        pageCount;
    } else {
      // Смена типа с высокой уверенностью → закрываем сегмент, открываем новый
      segments.push(current);
      current = {
        document_type: page.document_type,
        page_from: page.page,
        page_to: page.page,
        confidence: page.confidence,
        combined_text: text,
      };
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
 * Returns true если в результате splitting'а будет ≥ 2 сегментов с
 * разными типами и высоким confidence (т.е. реально multi-doc).
 */
export function isMultiDocument(segments: DocumentSegment[]): boolean {
  if (segments.length < 2) return false;
  // Сколько сегментов с разными типами и high-confidence
  const distinctTypes = new Set<string>();
  for (const s of segments) {
    if (s.document_type && s.confidence >= 0.6) {
      distinctTypes.add(s.document_type);
    }
  }
  return distinctTypes.size >= 2;
}
