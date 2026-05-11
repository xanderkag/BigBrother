import type { DocumentTypeSlug } from '../../types/documents.js';
import type { LlmClient } from '../llm/types.js';
import type { ParseResult } from './types.js';

/**
 * Shared helper used by Phase 2 parsers (TTN/CMR/AKT) and any future parser
 * that delegates to the LLM /extract endpoint.
 *
 * Behaviour:
 *   - If the LLM client is not configured (e.g., dev without inference-service),
 *     return an empty extraction with all expected fields listed as missing.
 *     This degrades gracefully to "needs_review" rather than throwing.
 *   - If the call fails (network, 5xx), propagate the error. The orchestrator
 *     marks the job as failed and BullMQ applies its retry policy.
 *   - If the LLM returns partial data, compute `missing` against the
 *     expected-field list passed in.
 */
export async function llmExtract(
  llm: LlmClient,
  rawText: string,
  schema: Record<string, unknown>,
  hint: DocumentTypeSlug,
  expectedFields: readonly string[],
  promptOverride?: string,
): Promise<ParseResult> {
  if (!llm.isAvailable()) {
    return {
      extracted: {},
      confidence: 0,
      missing: [...expectedFields],
    };
  }

  const result = await llm.extract({ text: rawText, schema, hint, promptOverride });
  const extracted = result.extracted ?? {};
  const present = new Set(Object.keys(extracted));
  const missing = expectedFields.filter((f) => {
    if (!present.has(f)) return true;
    const v = (extracted as Record<string, unknown>)[f];
    return v === undefined || v === null || v === '' || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
  });

  return {
    extracted,
    confidence: clamp01(result.confidence),
    missing,
  };
}

function clamp01(x: number | undefined | null): number {
  if (x === undefined || x === null || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
