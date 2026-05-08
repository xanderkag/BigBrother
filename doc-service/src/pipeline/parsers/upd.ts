import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { DocumentType } from '../../types/documents.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult } from './types.js';
import { findDate, findDocNumber, findMoney, findVatRate, scoreCompleteness } from './common.js';

/**
 * УПД и счёт-фактура структурно похожи — один класс обслуживает оба типа,
 * различие — в значении `type` и в JSON-схеме, передаваемой в LLM.
 *
 * Тот же regex → LLM-fallback паттерн, что у InvoiceParser:
 *   1. Regex extracts core fields (number/date/total/INN/НДС).
 *   2. If regex confidence ≥ threshold — return.
 *   3. Otherwise call LLM /extract; take whichever result is better.
 *   4. On LLM failure, return regex result silently.
 */
export class UpdParser implements DocumentParser {
  constructor(
    private readonly llm: LlmClient,
    public readonly type: DocumentType = 'UPD',
    private readonly fallbackThreshold: number = 0.7,
  ) {}

  async parse(rawText: string): Promise<ParseResult> {
    const regex = this.parseWithRegex(rawText);

    if (regex.confidence >= this.fallbackThreshold || !this.llm.isAvailable()) {
      return regex;
    }

    let llm: ParseResult;
    try {
      llm = await llmExtract(
        this.llm,
        rawText,
        DOCUMENT_JSON_SCHEMAS[this.type],
        this.type,
        EXPECTED_FIELDS[this.type],
      );
    } catch {
      return regex;
    }

    return llm.confidence > regex.confidence ? llm : regex;
  }

  private parseWithRegex(rawText: string): ParseResult {
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

    const { confidence, missing } = scoreCompleteness(extracted as Record<string, unknown>, [
      'number',
      'date',
      'total',
    ]);

    return { extracted, confidence, missing };
  }
}
