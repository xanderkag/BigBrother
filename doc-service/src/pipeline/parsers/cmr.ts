import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult } from './types.js';

/**
 * CMR — международная накладная, мультиязычная (RU + EN/DE/PL и т.д.) и
 * привязана к нумерованным ячейкам бланка. Делегируется в LLM /extract.
 */
export class CmrParser implements DocumentParser {
  readonly type = 'CMR' as const;

  constructor(private readonly llm: LlmClient) {}

  parse(rawText: string): Promise<ParseResult> {
    return llmExtract(
      this.llm,
      rawText,
      DOCUMENT_JSON_SCHEMAS.CMR,
      'CMR',
      EXPECTED_FIELDS.CMR,
    );
  }
}
