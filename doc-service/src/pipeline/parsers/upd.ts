import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { DocumentType } from '../../types/documents.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult, ParserOverride } from './types.js';
import { findDate, findDocNumber, findMoney, findVatRate, scoreCompleteness } from './common.js';

const DEFAULT_REGEX_EXPECTED_FIELDS: readonly string[] = ['number', 'date', 'total'];

/**
 * УПД и счёт-фактура структурно похожи — один класс обслуживает оба типа,
 * различие — в значении `type` и в JSON-схеме, передаваемой в LLM.
 *
 * Тот же regex → LLM-fallback паттерн, что у InvoiceParser:
 *   1. Regex extracts core fields (number/date/total/INN/НДС).
 *   2. If regex confidence ≥ threshold — return.
 *   3. Otherwise call LLM /extract; take whichever result is better.
 *   4. On LLM failure, return regex result silently.
 *
 * `ParserOverride` (from the orchestrator's resolved Document Type
 * config) replaces the constructor defaults for the duration of a
 * single parse() call.
 */
export class UpdParser implements DocumentParser {
  constructor(
    private readonly llm: LlmClient,
    public readonly type: DocumentType = 'UPD',
    private readonly fallbackThreshold: number = 0.7,
  ) {}

  async parse(rawText: string, override?: ParserOverride): Promise<ParseResult> {
    const expectedFields = override?.expectedFields ?? DEFAULT_REGEX_EXPECTED_FIELDS;
    const fallbackThreshold = override?.regexFallbackThreshold ?? this.fallbackThreshold;

    const regex = this.parseWithRegex(rawText, expectedFields);

    if (regex.confidence >= fallbackThreshold || !this.llm.isAvailable()) {
      return regex;
    }

    let llm: ParseResult;
    try {
      llm = await llmExtract(
        this.llm,
        rawText,
        override?.llmSchema ?? DOCUMENT_JSON_SCHEMAS[this.type],
        this.type,
        override?.expectedFields ?? EXPECTED_FIELDS[this.type],
        override?.llmPrompt,
      );
    } catch {
      return regex;
    }

    return llm.confidence > regex.confidence ? llm : regex;
  }

  private parseWithRegex(rawText: string, expectedFields: readonly string[]): ParseResult {
    const number = findDocNumber(rawText, 'УПД|счёт-фактура|счет-фактура');
    const date = findDate(rawText);
    const total = findMoney(rawText, 'Всего\\s+к\\s+оплате', 'Итого', 'Всего');
    const vat = findMoney(rawText, 'НДС');
    const vat_rate = findVatRate(rawText);

    const innMatches = rawText.match(/ИНН[\s:№]*?(\d{10}|\d{12})/gi) ?? [];
    const sellerInn = innMatches[0]?.match(/(\d{10}|\d{12})/)?.[1];
    const buyerInn = innMatches[1]?.match(/(\d{10}|\d{12})/)?.[1];

    const extracted = {
      number,
      date,
      seller: sellerInn ? { inn: sellerInn } : undefined,
      buyer: buyerInn ? { inn: buyerInn } : undefined,
      total,
      vat,
      vat_rate,
    };

    const { confidence, missing } = scoreCompleteness(
      extracted as Record<string, unknown>,
      expectedFields,
    );

    return { extracted, confidence, missing };
  }
}
