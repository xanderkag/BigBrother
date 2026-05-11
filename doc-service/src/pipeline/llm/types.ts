import type { DocumentTypeSlug } from '../../types/documents.js';

export type LlmClassifyResult = {
  type: DocumentTypeSlug | null;
  confidence: number;
};

export type LlmExtractDebug = {
  prompt: string;
  raw_response: string;
  model: string;
  backend: string;
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

  classify(text: string): Promise<LlmClassifyResult>;
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
  }): Promise<LlmExtractResult>;
  visionOcr(input: { imagePath: string; prompt?: string }): Promise<LlmVisionResult>;
  verify(input: {
    extracted: Record<string, unknown>;
    rawText: string;
  }): Promise<LlmVerifyResult>;
}
