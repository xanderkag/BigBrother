import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult, ParserOverride } from './types.js';

/**
 * CMR — международная накладная, мультиязычная (RU + EN/DE/PL и т.д.) и
 * привязана к нумерованным ячейкам бланка. Делегируется в LLM /extract.
 *
 * `ParserOverride` подменяет схему/expected_fields когда админ настроил
 * их в Document Type Registry; без override — builtin defaults.
 */
export class CmrParser implements DocumentParser {
  readonly type = 'CMR' as const;

  constructor(private readonly llm: LlmClient) {}

  parse(rawText: string, override?: ParserOverride): Promise<ParseResult> {
    return llmExtract(
      this.llm,
      rawText,
      override?.llmSchema ?? DOCUMENT_JSON_SCHEMAS.CMR,
      'CMR',
      override?.expectedFields ?? EXPECTED_FIELDS.CMR,
      override?.llmPrompt,
      override?.imagePath,
    );
  }
}
