/**
 * §P0-0 (CLASSIFIER-PACKET-V2): восстановление постраничности склеенного OCR.
 *
 * ПРОБЛЕМА: многостраничный скан иногда выходит одним blob'ом
 * (`ocr.pages.length <= 1`, напр. Yandex OCR склеил), и мультидок-путь
 * (`ocr.pages.length > 1`) не запускается — сегментация композита не работает.
 *
 * РЕШЕНИЕ (эвристика, гейтится SEGMENT_FORCE_PAGE_SPLIT, default off): разбить
 * `ocr.text` на псевдо-страницы по разделителям и, если получилось ≥2,
 * прогнать через мультидок. Настоящий per-page re-render (PDF→PNG) — отдельная
 * задача (нужен доступ к исходному файлу в pipeline); здесь дешёвый текстовый
 * фолбэк, который часто спасает (OCR-движки ставят form-feed между страницами).
 */

const FORM_FEED = '\f';

/** Маркеры начала страницы (мультиязычно), в начале строки. */
const PAGE_MARKER = /^[ \t]*(?:страница|стр\.?|page|seite|lapa|puslapis|lehekülg)[ \t]*[№#]?[ \t]*\d+\b/gim;

/**
 * Разбить склеенный OCR-текст на псевдо-страницы. Возвращает [] если уверенно
 * разбить не удалось (< 2 страниц) — тогда caller не трогает single-doc путь.
 */
export function splitCollapsedText(text: string): string[] {
  if (!text || !text.trim()) return [];

  // 1. Form-feed — самый надёжный постраничный разделитель.
  if (text.includes(FORM_FEED)) {
    const parts = text.split(FORM_FEED).map((s) => s.trim()).filter((s) => s.length > 0);
    if (parts.length >= 2) return parts;
  }

  // 2. Явные маркеры «Страница N / Page N / Seite N …» как границы страниц.
  PAGE_MARKER.lastIndex = 0;
  const idxs: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = PAGE_MARKER.exec(text)) !== null) {
    idxs.push(m.index);
    if (m.index === PAGE_MARKER.lastIndex) PAGE_MARKER.lastIndex++; // guard пустой матч
  }
  if (idxs.length >= 2) {
    const parts: string[] = [];
    const preamble = text.slice(0, idxs[0]!).trim();
    if (preamble.length > 0) parts.push(preamble);
    for (let i = 0; i < idxs.length; i++) {
      const from = idxs[i]!;
      const to = i + 1 < idxs.length ? idxs[i + 1]! : text.length;
      const chunk = text.slice(from, to).trim();
      if (chunk.length > 0) parts.push(chunk);
    }
    if (parts.length >= 2) return parts;
  }

  return [];
}
