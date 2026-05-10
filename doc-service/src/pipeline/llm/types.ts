import type { DocumentType } from '../../types/documents.js';

export type LlmClassifyResult = {
  type: DocumentType | null;
  confidence: number;
};

export type LlmExtractResult = {
  extracted: Record<string, unknown>;
  confidence: number;
  issues: string[];
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
    hint?: DocumentType;
  }): Promise<LlmExtractResult>;
  visionOcr(input: { imagePath: string; prompt?: string }): Promise<LlmVisionResult>;
  verify(input: {
    extracted: Record<string, unknown>;
    rawText: string;
  }): Promise<LlmVerifyResult>;
}
