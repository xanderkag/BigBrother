import { readFile } from 'node:fs/promises';
import { request } from 'undici';
import type {
  LlmClient,
  LlmClassifyResult,
  LlmExtractResult,
  LlmVerifyResult,
  LlmVisionResult,
} from './types.js';
import type { DocumentTypeSlug } from '../../types/documents.js';
import { llmCallDurationSeconds, llmCallsTotal } from '../../metrics.js';

export type HttpLlmClientOptions = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
};

export class HttpLlmClient implements LlmClient {
  constructor(private readonly opts: HttpLlmClientOptions) {}

  isAvailable(): boolean {
    return !!this.opts.baseUrl;
  }

  async classify(text: string): Promise<LlmClassifyResult> {
    return this.post<LlmClassifyResult>('/v1/classify', { text });
  }

  async extract(input: {
    text: string;
    schema: Record<string, unknown>;
    hint?: DocumentTypeSlug;
    promptOverride?: string;
  }): Promise<LlmExtractResult> {
    // Inference-service ожидает snake_case `prompt_override` (Python convention).
    // Перекладываем camelCase → snake_case на сетевой границе, чтобы остальной
    // TS-код жил в своих идиомах.
    const { promptOverride, ...rest } = input;
    return this.post<LlmExtractResult>('/v1/extract', {
      ...rest,
      ...(promptOverride ? { prompt_override: promptOverride } : {}),
    });
  }

  async visionOcr(input: { imagePath: string; prompt?: string }): Promise<LlmVisionResult> {
    const buf = await readFile(input.imagePath);
    return this.post<LlmVisionResult>('/v1/vision-ocr', {
      image_base64: buf.toString('base64'),
      prompt: input.prompt,
    });
  }

  async verify(input: {
    extracted: Record<string, unknown>;
    rawText: string;
  }): Promise<LlmVerifyResult> {
    return this.post<LlmVerifyResult>('/v1/verify', {
      extracted: input.extracted,
      raw_text: input.rawText,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.opts.baseUrl).toString();
    const startedAt = Date.now();
    // `path` carries the leading slash; strip it for cleaner Prometheus labels.
    const endpointLabel = path.replace(/^\/+/, '');

    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        headersTimeout: this.opts.timeoutMs,
        bodyTimeout: this.opts.timeoutMs,
      });

      const elapsed = (Date.now() - startedAt) / 1000;
      llmCallDurationSeconds.observe({ endpoint: endpointLabel }, elapsed);

      if (res.statusCode >= 400) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        const text = await res.body.text();
        throw new Error(`LLM ${path} ${res.statusCode}: ${text.slice(0, 500)}`);
      }
      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'success' });
      return (await res.body.json()) as T;
    } catch (err) {
      // Network / timeout — already counted above when the response came
      // back with a >=400 status. Here we only count the path where the
      // request threw before completing (e.g. ECONNREFUSED, timeout).
      // Use a distinct outcome to differentiate from HTTP-error path.
      if (!(err instanceof Error && err.message.startsWith('LLM '))) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
      }
      throw err;
    }
  }
}
