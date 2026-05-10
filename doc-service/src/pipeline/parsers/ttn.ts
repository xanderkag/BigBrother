import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult } from './types.js';

/**
 * ТТН (Транспортная накладная) — табличный документ с большим количеством
 * полей. Регулярные выражения здесь дают плохое качество, поэтому парсер
 * полностью делегирует извлечение в LLM /extract по схеме TTN.
 *
 * Если LLM-клиент не настроен — возвращается пустой результат, и
 * оркестратор переводит задачу в `needs_review`.
 */
export class TtnParser implements DocumentParser {
  readonly type = 'TTN' as const;

  constructor(private readonly llm: LlmClient) {}

  parse(rawText: string): Promise<ParseResult> {
    return llmExtract(
      this.llm,
      rawText,
      DOCUMENT_JSON_SCHEMAS.TTN,
      'TTN',
      EXPECTED_FIELDS.TTN,
    );
  }
}
