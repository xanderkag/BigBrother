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

export interface DocumentParser {
  readonly type: DocumentType;
  /**
   * Async to support LLM-backed parsers. Sync regex parsers wrap their
   * result in `Promise.resolve` (see Phase 1 parsers).
   *
   * Errors propagate: a network failure on the LLM call should let the
   * BullMQ retry kick in. Empty/partial extraction is a normal result and
   * is reported via low confidence + `missing`.
   */
  parse(rawText: string): Promise<ParseResult>;
}
