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
  imagePath?: string,
): Promise<ParseResult> {
  if (!llm.isAvailable()) {
    return {
      extracted: {},
      confidence: 0,
      missing: [...expectedFields],
    };
  }

  // Всегда просим debug — это включается доспро на стороне inference только
  // если бэкенд готов. Размер трассы — десятки KB на крупный prompt, что
  // приемлемо для платформы с job'ами по гигабайтам метаданных.
  const result = await llm.extract({ text: rawText, schema, hint, promptOverride, includeDebug: true, imagePath });
  const extracted = unwrapSchemaEcho(result.extracted ?? {});
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
    llmCall: result.debug,
  };
}

function clamp01(x: number | undefined | null): number {
  if (x === undefined || x === null || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Defensive unwrap для частого LLM-глюка: модель «эхом» возвращает саму
 * JSON-схему, а не данные — `{ "type": "object", "properties": { ...values } }`.
 * При этом значения уже подставлены ВНУТРЬ properties (number: "INV-...",
 * items: [...]). Наблюдалось на Qwen2.5-VL для фрахт-счетов (2026-05-20):
 * extracted приходил пустым на верхнем уровне, а реальные поля — под
 * `.properties`. Если видим эту сигнатуру — разворачиваем в плоский объект.
 *
 * Срабатывает только при чётком признаке schema-echo (есть `properties`-объект
 * + либо `type:'object'`, либо на верхнем уровне больше ничего полезного), так
 * что нормальный extracted с легитимным полем «properties» не пострадает.
 */
function unwrapSchemaEcho(extracted: Record<string, unknown>): Record<string, unknown> {
  const props = extracted['properties'];
  const looksLikeSchema =
    props !== null &&
    typeof props === 'object' &&
    !Array.isArray(props) &&
    Object.keys(props as object).length > 0 &&
    (extracted['type'] === 'object' ||
      Object.keys(extracted).every((k) => k === 'type' || k === 'properties'));
  return looksLikeSchema ? (props as Record<string, unknown>) : extracted;
}
