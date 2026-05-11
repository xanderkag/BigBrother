import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult, ParserOverride } from './types.js';

/**
 * АКТ оказанных услуг / выполненных работ. Структура сильно варьируется
 * (ИП на УСН без НДС, ОООшки с НДС, разные шаблоны таблицы услуг) — потому
 * полностью через LLM /extract.
 *
 * `ParserOverride` подменяет схему/expected_fields когда админ настроил
 * их в Document Type Registry.
 */
export class AktParser implements DocumentParser {
  readonly type = 'AKT' as const;

  constructor(private readonly llm: LlmClient) {}

  parse(rawText: string, override?: ParserOverride): Promise<ParseResult> {
    return llmExtract(
      this.llm,
      rawText,
      override?.llmSchema ?? DOCUMENT_JSON_SCHEMAS.AKT,
      'AKT',
      override?.expectedFields ?? EXPECTED_FIELDS.AKT,
      override?.llmPrompt,
    );
  }
}
