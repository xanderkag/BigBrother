/**
 * §8.1 (CLASSIFIER-PACKET-V2, ПДн-блокер): маскирование `raw_text` перед
 * персистом, чтобы паспортный текст (MRZ/ФИО/номер) не сохранялся в
 * `jobs.raw_text` и не отдавался наружу (`GET /jobs/:id/raw_text`, reprocess).
 *
 * Две линии защиты:
 *   1. Постраничная — если сегментация выделила паспорт/ID-сегмент, страницы
 *      этого диапазона заменяются плейсхолдером (точная вырезка).
 *   2. Скраб паттернов — поверх результата прогоняем `scrubPassportPatterns`
 *      (MRZ + иностранный паспорт), ловит паспортную страницу, если
 *      сегментация её не выделила. Применяется ТОЛЬКО когда есть признак ID
 *      в документе (не трогаем raw_text обычных доков — он нужен для аудита).
 */
import { ID_DOC_SLUGS } from './id-allowlist.js';
import { scrubPassportPatterns } from './pii-redact.js';

export const ID_PAGE_PLACEHOLDER = '[REDACTED: ID DOCUMENT PAGE]';

/** Разобрать page_range "5" / "8-11" → [from,to] (1-indexed, inclusive). */
function parseRange(s: string): [number, number] | null {
  const m = s.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) return null;
  return [from, to];
}

/**
 * Замаскировать паспортное/ID-содержимое в raw_text.
 *
 * @param rawText     полный OCR-текст (ocr.text).
 * @param pages       постраничный текст (ocr.pages) — 0-indexed массив; page N = pages[N-1].
 * @param primaryType тип документа job'а (для одиночного паспорта без мультидока).
 * @param segments    мультидок-сегменты (page_range + document_type).
 * @returns масированный raw_text (или исходный, если ID-содержимого нет).
 */
export function maskIdContentInRawText(
  rawText: string,
  pages: ReadonlyArray<{ text: string }> | undefined,
  primaryType: string | null,
  segments: ReadonlyArray<{ page_range: string; document_type: string | null }> | null | undefined,
): string {
  // ID-диапазоны страниц из сегментов.
  const idRanges: Array<[number, number]> = [];
  if (segments) {
    for (const seg of segments) {
      if (seg.document_type && ID_DOC_SLUGS.has(seg.document_type)) {
        const r = parseRange(seg.page_range);
        if (r) idRanges.push(r);
      }
    }
  }
  const wholeIsId = primaryType != null && ID_DOC_SLUGS.has(primaryType);

  // Нет никакого признака ID → raw_text не трогаем (аудит).
  if (idRanges.length === 0 && !wholeIsId) return rawText;

  // Одиночный ID-документ (паспорт-фото без мультидока) — вырезаем всё.
  if (wholeIsId && idRanges.length === 0) return ID_PAGE_PLACEHOLDER;

  // Постраничная вырезка ID-диапазонов + скраб паттернов на остатке.
  if (pages && pages.length > 0) {
    const isIdPage = (n: number) => idRanges.some(([a, b]) => n >= a && n <= b);
    const masked = pages
      .map((p, i) => (isIdPage(i + 1) ? ID_PAGE_PLACEHOLDER : p.text))
      .join('\n\n');
    return scrubPassportPatterns(masked);
  }

  // Есть ID-сегмент, но постраничного текста нет — скрабим весь raw_text.
  return scrubPassportPatterns(rawText);
}
