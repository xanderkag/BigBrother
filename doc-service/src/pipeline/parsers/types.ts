import type { DocumentType } from '../../types/documents.js';

export type ParseResult = {
  extracted: Record<string, unknown>;
  /**
   * Parser-side confidence: how many expected fields the parser actually
   * managed to extract. Combined with OCR confidence by the orchestrator.
   */
  confidence: number;
  /** Field names that the parser tried to find and could not. */
  missing: string[];
};

/**
 * Per-job overrides supplied by the orchestrator from the resolved
 * `ResolvedTypeConfig`. All fields are optional — parsers fall back to
 * the values baked in at construction (and so existing tests that call
 * `parser.parse(text)` without a config stay valid).
 *
 *   expectedFields            — used by the `missing[]` accounting.
 *                               When supplied, replaces the parser's
 *                               default field list.
 *   regexFallbackThreshold    — Phase 1 only. Below this regex
 *                               confidence the parser delegates to
 *                               the LLM extractor. 0 disables fallback.
 *   llmSchema                 — Phase 2 only. JSON Schema sent to
 *                               /v1/extract; overrides the builtin
 *                               per-type schema when present.
 */
export type ParserOverride = {
  expectedFields?: readonly string[];
  regexFallbackThreshold?: number;
  llmSchema?: Record<string, unknown>;
};

export interface DocumentParser {
  readonly type: DocumentType;
  /**
   * Async to support LLM-backed parsers. Sync regex parsers wrap their
   * result in `Promise.resolve` (see Phase 1 parsers).
   *
   * Errors propagate: a network failure on the LLM call should let the
   * BullMQ retry kick in. Empty/partial extraction is a normal result and
   * is reported via low confidence + `missing`.
   *
   * `override` lets the orchestrator pass per-job config resolved from
   * the Document Type Registry. Omitted → parser uses its built-in
   * defaults (keeps tests + smoke runner happy).
   */
  parse(rawText: string, override?: ParserOverride): Promise<ParseResult>;
}
