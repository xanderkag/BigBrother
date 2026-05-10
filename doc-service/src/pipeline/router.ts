import type { OcrEngine, OcrInput } from './ocr/types.js';

/**
 * Build the ordered list of OCR engines to try for a given input.
 *
 * Rules:
 *   - Skip engines that cannot handle the mime type (`supports`).
 *   - Skip engines that are not configured (`isAvailable`) — e.g., LLM URL not set.
 *   - Order is fixed: pdf-text → tesseract → vision-llm → yandex.
 *     The orchestrator stops as soon as one engine clears its acceptance threshold.
 */
export function selectOcrChain(engines: readonly OcrEngine[], input: OcrInput): OcrEngine[] {
  return engines.filter((e) => e.isAvailable() && e.supports(input));
}
