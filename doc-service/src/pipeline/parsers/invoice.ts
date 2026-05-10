import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult } from './types.js';
import {
  findDocNumber,
  findDate,
  findInn,
  findMoney,
  findVatRate,
  scoreCompleteness,
} from './common.js';

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
 */
export class InvoiceParser implements DocumentParser {
  readonly type = 'invoice' as const;

  constructor(
    private readonly llm: LlmClient,
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
        DOCUMENT_JSON_SCHEMAS.invoice,
        'invoice',
        EXPECTED_FIELDS.invoice,
      );
    } catch {
      // LLM glitch — silently fall back to regex. The orchestrator will
      // see low confidence and route to needs_review.
      return regex;
    }

    return llm.confidence > regex.confidence ? llm : regex;
  }

  private parseWithRegex(rawText: string): ParseResult {
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

    const { confidence, missing } = scoreCompleteness(extracted as Record<string, unknown>, [
      'number',
      'date',
      'total',
    ]);

    return { extracted, confidence, missing };
  }
}
