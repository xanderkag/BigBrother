// Heuristic confidence scoring. Each engine produces its own raw "confidence",
// but pdf-parse has none — we derive one from the text shape. Keep this module
// pure: input → score, no I/O.

const RU_LETTERS = /[А-Яа-яЁё]/g;
const ANY_LETTER = /[\p{L}]/gu;

/**
 * Score the output of pdf-parse on a 0..1 scale. The intent is to detect
 * "scanned PDF with no embedded text" (very short or image-only) vs.
 * "real text PDF". Tuned for Russian documents.
 */
export function scorePdfText(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < 50) return 0;

  const totalLetters = (trimmed.match(ANY_LETTER) ?? []).length;
  const ruLetters = (trimmed.match(RU_LETTERS) ?? []).length;
  const letterDensity = totalLetters / trimmed.length;

  // A real text PDF typically has high letter density and at least some Russian content.
  // Image-extracted text from pdf-parse usually comes out garbled or empty.
  let score = 0;
  if (totalLetters > 200) score += 0.5;
  else if (totalLetters > 50) score += 0.3;

  if (letterDensity > 0.5) score += 0.3;
  else if (letterDensity > 0.3) score += 0.15;

  if (ruLetters > 30) score += 0.15;

  // Strong signal: presence of structural keywords typical for accounting/transport docs.
  const hasStructure = /(ИНН|СЧЁТ|СЧЕТ|УПД|АКТ|НАКЛАДНАЯ|CMR|КПП|Итого|НДС)/i.test(trimmed);
  if (hasStructure) score += 0.1;

  return Math.min(1, score);
}

/**
 * Tesseract reports per-word confidence in 0..100; we average and rescale.
 * The wrapper here just clamps and normalizes whatever is passed in.
 */
export function normalizeTesseractConfidence(rawAvgConfidence: number): number {
  if (!Number.isFinite(rawAvgConfidence)) return 0;
  const v = rawAvgConfidence > 1 ? rawAvgConfidence / 100 : rawAvgConfidence;
  return Math.max(0, Math.min(1, v));
}

/**
 * Combine OCR confidence with parser-side confidence (how many expected fields were extracted).
 *
 * I3 fix: geometric mean is only applied when parser actually ran and returned
 * a meaningful score. parser=0 means "LLM unavailable / stub / timed out" —
 * in that case we preserve the OCR signal with a small penalty instead of
 * zeroing the result (sqrt(0.9 * 0) = 0 is misleading when OCR was perfect).
 *
 * Decision table:
 *   parser undefined  → OCR-only pipeline, return ocr as-is
 *   parser > 0        → geometric mean (penalizes weak extraction)
 *   parser === 0      → LLM unavailable; ocr * 0.85 (mild penalty, keeps needs_review logic honest)
 */
export function combineConfidence(ocr: number, parser: number | undefined): number {
  if (parser === undefined) return ocr;
  if (parser <= 0) return Math.max(0, ocr) * 0.85;
  return Math.sqrt(Math.max(0, ocr) * parser);
}
