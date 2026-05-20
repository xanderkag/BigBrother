/**
 * Text sanitization for OCR output before it flows downstream (classifier, LLM
 * extract, DB write).
 *
 * Why this exists — P0 crash 2026-05-20: некоторые PDF (экспортированные из
 * определённых генераторов) дают текстовый слой с NUL-байтами (U+0000).
 * `pdftotext` пробрасывает их в строку как есть. PostgreSQL `text`/`jsonb`
 * не принимает 0x00 ("invalid byte sequence for encoding UTF8: 0x00") — и
 * `JobsRepo.finalize` падает с DatabaseError, роняя весь job на retry-loop.
 *
 * NUL не несёт смысла в распознанном тексте — это артефакт. Убираем его, а
 * заодно прочие управляющие C0-символы кроме \t \n \r, которые тоже могут
 * мешать LLM и логам. Печатаемый текст и кириллица не трогаются.
 */

// NUL (\x00) через US (\x1F), но сохраняем \t (\x09), \n (\x0A), \r (\x0D).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/**
 * Удаляет NUL и прочие непечатаемые C0-control символы (кроме \t \n \r).
 * Идемпотентна; на null/undefined возвращает исходное значение.
 */
export function sanitizeText<T extends string | null | undefined>(text: T): T {
  if (text == null) return text;
  return text.replace(CONTROL_CHARS, '') as T;
}
