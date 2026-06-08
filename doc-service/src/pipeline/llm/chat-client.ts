import { request } from 'undici';
import { llmCallDurationSeconds, llmCallsTotal } from '../../metrics.js';

/**
 * EXT-LLM-GATEWAY (local): тонкий generic-chat клиент для роли doc-service
 * как локального OpenAI-совместимого LLM-шлюза.
 *
 * Зачем отдельный клиент, а не HttpLlmClient: тот заточен под inference-service
 * (доменные /v1/classify, /v1/extract, snake_case-контракт и domain-shaped
 * результаты). Шлюзу нужен честный passthrough OpenAI chat/embeddings —
 * запрос/ответ проходят 1:1, мы лишь подменяем `model` (alias→ollama-tag) и
 * снимаем лёгкий usage. Backend — GPU Ollama (OpenAI-compat), облако запрещено.
 *
 * Клиент НЕ бросает на upstream-ошибках: возвращает структурный
 * GatewayUpstreamResult, чтобы роут мог и залогировать usage (включая
 * status/error_code), и отдать клиенту корректный OpenAI-error. Бросает только
 * на собственных багах (нечего ловить).
 */

export type GatewayChatClientOptions = {
  /** Endpoint GPU Ollama, OpenAI-compat, ВКЛЮЧАЯ /v1 (напр. http://10.10.33.10:11434/v1). */
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
};

export type GatewayUpstreamResult = {
  /** True когда upstream вернул <400 и тело распарсилось. */
  ok: boolean;
  /** Upstream HTTP-статус; для network/timeout — синтетический 5xx. */
  status: number;
  /** Распарсенное JSON-тело (на успехе — OpenAI-shaped; на ошибке — OpenAI-error object). */
  body: unknown;
  /** Грубая классификация ошибки для usage-строки; undefined на успехе. */
  errorCode?: string;
};

/** Usage, который Ollama кладёт в chat.completion (может отсутствовать). */
export type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

/** Собрать OpenAI-совместимый error-object (для synthetic 5xx и не-JSON ошибок). */
export function openAiError(
  message: string,
  type: string,
  code: string,
): { error: { message: string; type: string; code: string } } {
  return { error: { message, type, code } };
}

export class GatewayChatClient {
  constructor(private readonly opts: GatewayChatClientOptions) {}

  isAvailable(): boolean {
    return !!this.opts.baseUrl;
  }

  /** POST {base}/chat/completions — passthrough. `body` уже с подменённым model. */
  chatCompletions(body: unknown): Promise<GatewayUpstreamResult> {
    return this.post('/chat/completions', 'gateway/chat', body);
  }

  /** POST {base}/embeddings — passthrough. `body` уже с подменённым model. */
  embeddings(body: unknown): Promise<GatewayUpstreamResult> {
    return this.post('/embeddings', 'gateway/embeddings', body);
  }

  /**
   * baseUrl уже содержит /v1, поэтому НЕ используем `new URL(path, base)`
   * (leading-slash path заменил бы весь путь и срезал /v1). Конкатенируем,
   * аккуратно убрав двойной слэш на стыке.
   */
  private resolveUrl(path: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private async post(
    path: string,
    endpointLabel: string,
    body: unknown,
  ): Promise<GatewayUpstreamResult> {
    const url = this.resolveUrl(path);
    const startedAt = Date.now();

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

      const status = res.statusCode;
      const raw = await res.body.text();
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        // Upstream вернул не-JSON (редко: прокси-страница, plaintext-ошибка).
        // Заворачиваем в OpenAI-error, чтобы клиент всегда получал валидный JSON.
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        return {
          ok: false,
          status: status >= 400 ? status : 502,
          body: openAiError(
            `Upstream returned non-JSON response (${status})`,
            'upstream_error',
            'upstream_bad_response',
          ),
          errorCode: 'upstream_bad_response',
        };
      }

      if (status >= 400) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        return {
          ok: false,
          status,
          // Если upstream уже отдал OpenAI-error — пробрасываем как есть.
          body: parsed,
          errorCode: 'upstream_error',
        };
      }

      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'success' });
      return { ok: true, status, body: parsed };
    } catch (err) {
      const elapsed = (Date.now() - startedAt) / 1000;
      llmCallDurationSeconds.observe({ endpoint: endpointLabel }, elapsed);
      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });

      // Различаем timeout от прочих сетевых сбоев для usage/диагностики.
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
          isTimeout
            ? 'Upstream model timed out'
            : 'Could not reach the upstream model backend',
          'upstream_error',
          errorCode,
        ),
        errorCode,
      };
    }
  }
}

/** Извлечь usage из OpenAI chat.completion / embeddings ответа (best-effort). */
export function extractUsage(body: unknown): OpenAiUsage {
  if (body && typeof body === 'object' && 'usage' in body) {
    const u = (body as { usage?: unknown }).usage;
    if (u && typeof u === 'object') {
      const usage = u as Record<string, unknown>;
      return {
        prompt_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
        completion_tokens:
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
        total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
      };
    }
  }
  return {};
}
