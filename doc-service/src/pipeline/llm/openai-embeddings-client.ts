/**
 * EXT-LLM-GATEWAY-EMBEDDINGS: тонкий клиент для OpenAI /v1/embeddings.
 *
 * Зачем отдельный клиент: OpenAI embeddings — уже OpenAI shape native
 * (мы её и публикуем), так что нужен просто passthrough с подменой
 * model (alias→backend) и добавлением Authorization Bearer. Аналог
 * существующего GatewayChatClient, но точечно под /v1/embeddings.
 *
 * Anthropic embeddings не делает — поэтому даже на Asha (chat backend
 * = anthropic) embeddings всё равно идут через OpenAI.
 *
 * Используется в llm-gateway route на endpoint /v1/embeddings.
 */

import { request } from 'undici';
import { llmCallsTotal, llmCallDurationSeconds } from '../../metrics.js';
import { openAiError, type GatewayUpstreamResult } from './chat-client.js';

export type OpenAiEmbeddingsClientOptions = {
  /** OpenAI base, например https://api.openai.com/v1 (с /v1). */
  baseUrl: string;
  /** OpenAI API key (sk-...). */
  apiKey: string;
  timeoutMs: number;
};

export class OpenAiEmbeddingsClient {
  constructor(private readonly opts: OpenAiEmbeddingsClientOptions) {}

  isAvailable(): boolean {
    return !!(this.opts.baseUrl && this.opts.apiKey);
  }

  /**
   * POST {base}/embeddings. Body уже с подменённым model (alias→openai-tag).
   * Response — OpenAI shape, прокидываем как есть.
   */
  async embeddings(body: unknown): Promise<GatewayUpstreamResult> {
    const endpointLabel = 'gateway/openai-embeddings';
    const startedAt = Date.now();
    const url = this.resolveUrl('/embeddings');

    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        headersTimeout: this.opts.timeoutMs,
        bodyTimeout: this.opts.timeoutMs,
      });

      const elapsed = (Date.now() - startedAt) / 1000;
      llmCallDurationSeconds.observe({ endpoint: endpointLabel }, elapsed);

      const status = res.statusCode;
      const raw = await res.body.text();
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        return {
          ok: false,
          status: status >= 400 ? status : 502,
          body: openAiError(
            `OpenAI returned non-JSON (${status})`,
            'upstream_error',
            'upstream_bad_response',
          ),
          errorCode: 'upstream_bad_response',
        };
      }

      if (status >= 400) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        // OpenAI errors уже в OpenAI shape — прокидываем как есть.
        return { ok: false, status, body: parsed, errorCode: 'upstream_error' };
      }

      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'success' });
      return { ok: true, status, body: parsed };
    } catch (err) {
      const elapsed = (Date.now() - startedAt) / 1000;
      llmCallDurationSeconds.observe({ endpoint: endpointLabel }, elapsed);
      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });

      const isTimeout =
        err instanceof Error &&
        (err.name === 'HeadersTimeoutError' ||
          err.name === 'BodyTimeoutError' ||
          /timeout/i.test(err.message));
      const errorCode = isTimeout ? 'timeout' : 'network_error';
      return {
        ok: false,
        status: isTimeout ? 504 : 502,
        body: openAiError(
          isTimeout ? 'OpenAI timed out' : 'Could not reach OpenAI',
          'upstream_error',
          errorCode,
        ),
        errorCode,
      };
    }
  }

  private resolveUrl(path: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }
}
