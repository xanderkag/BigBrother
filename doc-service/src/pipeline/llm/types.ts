import type { DocumentTypeSlug } from '../../types/documents.js';

export type LlmClassifyResult = {
  type: DocumentTypeSlug | null;
  confidence: number;
};

/**
 * Ввод catalog-классификации (production LLM classifier). doc-service строит
 * динамический каталог `slug — description` из document_types и просит модель
 * выбрать РОВНО ОДИН slug либо `unknown`. См. pipeline/classifier/llm-classifier.ts.
 */
export type LlmCatalogClassifyInput = {
  text: string;
  catalog: string;
  fileName?: string | null;
  keywordHint?: string | null;
  maxTokens?: number;
};

/**
 * Результат catalog-классификации. `slug` — сырой ответ модели (может быть
 * `unknown`, невалидный slug, или null при пустом ответе). Валидацию по
 * каталогу делает caller (LlmDocClassifier).
 */
export type LlmCatalogClassifyResult = {
  slug: string | null;
  confidence: number;
};

export type LlmExtractDebug = {
  prompt: string;
  raw_response: string;
  model: string;
  backend: string;
  /** Время самого API-вызова к модели (без doc-service overhead'а). */
  duration_ms?: number;
  /** Usage от backend'а где доступно (Claude / OpenAI-compat). */
  prompt_tokens?: number;
  output_tokens?: number;
};

export type LlmExtractResult = {
  extracted: Record<string, unknown>;
  confidence: number;
  issues: string[];
  /** Заполнено если в запросе был промбит `includeDebug=true`. */
  debug?: LlmExtractDebug;
};

export type LlmVisionResult = {
  text: string;
  confidence: number;
};

export type LlmVerifyResult = {
  extracted: Record<string, unknown>;
  issues: string[];
};

/**
 * Domain-shaped client to an external inference-service. Keeps the chat-API
 * abstraction inside the inference-service: doc-service never sees prompts,
 * tokens, or model names. Swapping Qwen-VL for another VLM happens behind
 * this interface.
 */
export interface LlmClient {
  isAvailable(): boolean;

  /**
   * Vision-capability resolved-провайдера (item A). Async, потому что
   * DynamicLlmClient читает её из provider_settings (DB) с TTL-кэшем.
   * Оркестратор вызывает её, чтобы решить, слать ли изображение в extract.
   * Реализации без DB (Null/Http) возвращают зашитое значение.
   */
  supportsVision(): Promise<boolean>;

  classify(text: string): Promise<LlmClassifyResult>;
  /**
   * Catalog-классификация (production LLM classifier): динамический каталог
   * типов + имя файла + keyword-prior. Модель выбирает РОВНО ОДИН slug либо
   * `unknown`. Возвращает СЫРОЙ slug — валидация по каталогу на стороне caller'а.
   * Отдельно от classify(), чтобы не ломать 6-типовый контракт старых вызовов.
   */
  classifyWithCatalog(input: LlmCatalogClassifyInput): Promise<LlmCatalogClassifyResult>;
  extract(input: {
    text: string;
    schema: Record<string, unknown>;
    hint?: DocumentTypeSlug;
    /**
     * Кастомная инструкция для модели, заведённая админом в Document
     * Type Registry (`document_types.llm_prompt`). Если задана,
     * inference-service использует её вместо встроенного prompt'а
     * для этого типа документа. Оркестратор резолвит её из
     * `ResolvedTypeConfig.llmPrompt` и передаёт сюда.
     */
    promptOverride?: string;
    /**
     * Просить inference-service вернуть финальный prompt и сырой ответ
     * модели в `result.debug` — для job-debug-трассы в UI.
     */
    includeDebug?: boolean;
    /**
     * extraction-from-image (item A): путь к PNG/JPEG первой страницы
     * документа. Если задан И провайдер vision-capable — клиент base64-
     * кодирует файл и шлёт как `image_base64`, и модель извлекает поля
     * напрямую из картинки. Если не задан — классический text-only extract.
     * Оркестратор выставляет это поле только когда resolved-провайдер
     * `vision=true` (или включён metadata-override).
     */
    imagePath?: string;
  }): Promise<LlmExtractResult>;
  visionOcr(input: { imagePath: string; prompt?: string }): Promise<LlmVisionResult>;
  verify(input: {
    extracted: Record<string, unknown>;
    rawText: string;
  }): Promise<LlmVerifyResult>;
}
