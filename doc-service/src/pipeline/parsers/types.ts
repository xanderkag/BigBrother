import type { DocumentTypeSlug } from '../../types/documents.js';
import type { LlmExtractDebug } from '../llm/types.js';

export type ParseResult = {
  extracted: Record<string, unknown>;
  /**
   * Parser-side confidence: how many expected fields the parser actually
   * managed to extract. Combined with OCR confidence by the orchestrator.
   */
  confidence: number;
  /** Field names that the parser tried to find and could not. */
  missing: string[];
  /**
   * Дебаг-след LLM-вызова, если парсер ходил в модель и был включён
   * `includeDebug`. Орxестратор сохраняет это в jobs.last_llm_call.
   * Для regex-парсеров без LLM-fallback это поле всегда undefined.
   */
  llmCall?: LlmExtractDebug;
};

/**
 * Per-job overrides supplied by the orchestrator from the resolved
 * `ResolvedTypeConfig`. All fields are optional — parsers fall back to
 * the values baked in at construction (and so existing tests that call
 * `parser.parse(text)` without a config stay valid).
 *
 *   expectedFields            — used by the `missing[]` accounting.
 *                               When supplied, replaces the parser's
 *                               default field list.
 *   regexFallbackThreshold    — Phase 1 only. Below this regex
 *                               confidence the parser delegates to
 *                               the LLM extractor. 0 disables fallback.
 *   llmSchema                 — Phase 2 only. JSON Schema sent to
 *                               /v1/extract; overrides the builtin
 *                               per-type schema when present.
 */
export type ParserOverride = {
  expectedFields?: readonly string[];
  regexFallbackThreshold?: number;
  llmSchema?: Record<string, unknown>;
  /**
   * Кастомная инструкция для LLM-агента, заданная админом в Document
   * Type Registry. Парсер пробрасывает её в `LlmClient.extract` как
   * `promptOverride`. Если не задано — inference-service использует
   * встроенный prompt для этого типа.
   */
  llmPrompt?: string;
  /**
   * extraction-from-image (item A): путь к PNG/JPEG первой страницы
   * документа. Оркестратор выставляет его только когда resolved LLM-
   * провайдер vision-capable (provider_settings.vision=true) или включён
   * metadata-override `_extract_from_image`. Парсер пробрасывает его в
   * `LlmClient.extract` как `imagePath`. Не задан → классический text-only
   * extract (поведение не меняется).
   */
  imagePath?: string;
};

export interface DocumentParser {
  /**
   * Slug этого парсера. Для builtin-парсеров — один из шести
   * (`'invoice'`, `'UPD'`, …). Для generic LLM-парсера — slug
   * пользовательского типа из БД (любая строка).
   */
  readonly type: DocumentTypeSlug;
  /**
   * Async to support LLM-backed parsers. Sync regex parsers wrap their
   * result in `Promise.resolve` (see Phase 1 parsers).
   *
   * Errors propagate: a network failure on the LLM call should let the
   * BullMQ retry kick in. Empty/partial extraction is a normal result and
   * is reported via low confidence + `missing`.
   *
   * `override` lets the orchestrator pass per-job config resolved from
   * the Document Type Registry. Omitted → parser uses its built-in
   * defaults (keeps tests + smoke runner happy).
   */
  parse(rawText: string, override?: ParserOverride): Promise<ParseResult>;
}
