import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult, ParserOverride } from './types.js';
import {
  findDocNumber,
  findDate,
  findInn,
  findMoney,
  findVatRate,
  scoreCompleteness,
} from './common.js';

const DEFAULT_REGEX_EXPECTED_FIELDS: readonly string[] = ['number', 'date', 'total'];

/**
 * Phase 1 invoice parser. Strategy:
 *
 *  1. Run regex extraction (free, fast, deterministic) over the OCR text.
 *  2. If regex confidence ≥ `fallbackThreshold` — return regex result.
 *  3. Otherwise, if LLM is available, also run LLM /extract and return
 *     whichever result has higher confidence.
 *  4. If LLM is unavailable or fails, return the regex result regardless;
 *     the orchestrator will trip needs_review on low overall confidence.
 *
 * Bills only on the documents that actually need help: well-formed text
 * PDFs with the standard "Счёт № X от Y / Итого / НДС" pattern stay on
 * the regex path and never call the LLM.
 *
 * Parameters from `ParserOverride` (passed by the orchestrator from the
 * resolved Document Type Registry) take precedence over constructor
 * defaults. Without an override, behaviour is identical to pre-CP1.
 */
export class InvoiceParser implements DocumentParser {
  readonly type = 'invoice' as const;

  constructor(
    private readonly llm: LlmClient,
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
        override?.llmSchema ?? DOCUMENT_JSON_SCHEMAS.invoice,
        'invoice',
        override?.expectedFields ?? EXPECTED_FIELDS.invoice,
        override?.llmPrompt,
      );
    } catch {
      // LLM glitch — silently fall back to regex. The orchestrator will
      // see low confidence and route to needs_review.
      return regex;
    }

    return llm.confidence > regex.confidence ? llm : regex;
  }

  private parseWithRegex(rawText: string, expectedFields: readonly string[]): ParseResult {
    const number = findDocNumber(rawText, 'счёт|счет');
    const date = findDate(rawText);
    const total = findMoney(rawText, 'Итого\\s+к\\s+оплате', 'Всего\\s+к\\s+оплате', 'Итого');
    const vat = findMoney(rawText, 'НДС');
    const vat_rate = findVatRate(rawText);

    // Seller/buyer INN — best-effort: take first two INN occurrences.
    const innMatches = rawText.match(/ИНН[\s:№]*?(\d{10}|\d{12})/gi) ?? [];
    const sellerInn = innMatches[0]?.match(/(\d{10}|\d{12})/)?.[1];
    const buyerInn = innMatches[1]?.match(/(\d{10}|\d{12})/)?.[1];

    const fallbackInn = findInn(rawText);

    const extracted = {
      number,
      date,
      seller: sellerInn || fallbackInn ? { inn: sellerInn ?? fallbackInn } : undefined,
      buyer: buyerInn ? { inn: buyerInn } : undefined,
      total,
      vat,
      vat_rate,
      // positions[] на regex не извлечь — ждём LLM-fallback.
    };

    const { confidence, missing } = scoreCompleteness(
      extracted as Record<string, unknown>,
      expectedFields,
    );

    return { extracted, confidence, missing };
  }
}
