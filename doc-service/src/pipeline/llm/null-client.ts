import type { LlmClient } from './types.js';

/**
 * Used when LLM_INFERENCE_URL is unset. All methods throw, but isAvailable()
 * returns false so callers (router, classifier composer) skip them entirely
 * without calling.
 */
export class NullLlmClient implements LlmClient {
  isAvailable(): boolean {
    return false;
  }

  async supportsVision(): Promise<boolean> {
    return false;
  }

  async classify(): Promise<never> {
    throw new Error('LLM client not configured');
  }
  async classifyWithCatalog(): Promise<never> {
    throw new Error('LLM client not configured');
  }
  async extract(): Promise<never> {
    throw new Error('LLM client not configured');
  }
  async visionOcr(): Promise<never> {
    throw new Error('LLM client not configured');
  }
  async verify(): Promise<never> {
    throw new Error('LLM client not configured');
  }
}
