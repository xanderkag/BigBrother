import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult, ParserOverride } from './types.js';

/**
 * ТТН (Транспортная накладная) — табличный документ с большим количеством
 * полей. Регулярные выражения здесь дают плохое качество, поэтому парсер
 * полностью делегирует извлечение в LLM /extract по схеме TTN.
 *
 * Если LLM-клиент не настроен — возвращается пустой результат, и
 * оркестратор переводит задачу в `needs_review`.
 *
 * `ParserOverride` подменяет JSON-схему и список ожидаемых полей,
 * когда админ настроил их в Document Type Registry; без override
 * используются захардкоженные builtin-значения.
 */
export class TtnParser implements DocumentParser {
  readonly type = 'TTN' as const;

  constructor(private readonly llm: LlmClient) {}

  parse(rawText: string, override?: ParserOverride): Promise<ParseResult> {
    return llmExtract(
      this.llm,
      rawText,
      override?.llmSchema ?? DOCUMENT_JSON_SCHEMAS.TTN,
      'TTN',
      override?.expectedFields ?? EXPECTED_FIELDS.TTN,
      override?.llmPrompt,
    );
  }
}
