import type { DocumentType } from '../../types/documents.js';
import type { LlmClient } from '../llm/types.js';
import type { DocumentParser } from './types.js';
import { InvoiceParser } from './invoice.js';
import { UpdParser } from './upd.js';
import { TtnParser } from './ttn.js';
import { CmrParser } from './cmr.js';
import { AktParser } from './akt.js';

export type ParsersOptions = {
  /**
   * Confidence threshold below which Phase 1 parsers fall back to the
   * LLM /extract endpoint. Phase 2 parsers always use the LLM directly,
   * so this option doesn't affect them.
   */
  regexFallbackThreshold?: number;
};

/**
 * Build the parser registry. Every parser receives the LlmClient — Phase 1
 * parsers use it as a fallback when their regex confidence is low; Phase 2
 * parsers delegate extraction to it entirely.
 */
export function buildParsers(
  llm: LlmClient,
  options: ParsersOptions = {},
): Record<DocumentType, DocumentParser> {
  const fallback = options.regexFallbackThreshold ?? 0.7;
  return {
    invoice: new InvoiceParser(llm, fallback),
    factInvoice: new UpdParser(llm, 'factInvoice', fallback),
    UPD: new UpdParser(llm, 'UPD', fallback),
    TTN: new TtnParser(llm),
    CMR: new CmrParser(llm),
    AKT: new AktParser(llm),
  };
}
