/**
 * EXT-LLM-GATEWAY-DADATA: тонкий клиент для DaData Suggestions API.
 *
 * Зачем отдельный клиент: DaData — российский сервис, geo-доступен с
 * Asha (никакого outbound-прокси). Используется SLAI для обогащения
 * контрагента по ИНН (findById/party) и опц. typeahead-подсказки
 * (suggest/party). Passthrough — body и response DaData-native verbatim.
 *
 * Auth у DaData: `Authorization: Token <API_KEY>` (без префикса Bearer).
 *
 * Используется в llm-gateway route на endpoints /v1/dadata/*.
 */

import { request } from 'undici';
import { llmCallsTotal, llmCallDurationSeconds } from '../../metrics.js';
import { openAiError, type GatewayUpstreamResult } from './chat-client.js';

export type DaDataClientOptions = {
  /** Базовый URL, например https://suggestions.dadata.ru. */
  baseUrl: string;
  /** Обычный DaData API ключ (не секретный — для findById/suggest хватает). */
  apiKey: string;
  timeoutMs: number;
};

const FIND_BY_ID_PATH = '/suggestions/api/4_1/rs/findById/party';
const SUGGEST_PATH = '/suggestions/api/4_1/rs/suggest/party';

export class DaDataClient {
  constructor(private readonly opts: DaDataClientOptions) {}

  isAvailable(): boolean {
    return !!(this.opts.baseUrl && this.opts.apiKey);
  }

  findByIdParty(body: unknown): Promise<GatewayUpstreamResult> {
    return this.post(FIND_BY_ID_PATH, 'gateway/dadata-findById', body);
  }

  suggestParty(body: unknown): Promise<GatewayUpstreamResult> {
    return this.post(SUGGEST_PATH, 'gateway/dadata-suggest', body);
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
          accept: 'application/json',
          // DaData использует `Token <key>`, НЕ `Bearer <key>`.
          authorization: `Token ${this.opts.apiKey}`,
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
            `DaData returned non-JSON (${status})`,
            'upstream_error',
            'upstream_bad_response',
          ),
          errorCode: 'upstream_bad_response',
        };
      }

      if (status >= 400) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        // DaData ошибки — обычно {message: "..."}. Заворачиваем в OpenAI shape
        // для единообразия с другими /v1/* роутами шлюза.
        const msg =
          parsed && typeof parsed === 'object' && 'message' in parsed
            ? String((parsed as { message?: unknown }).message)
            : `DaData error (${status})`;
        return {
          ok: false,
          status,
          body: openAiError(msg, 'upstream_error', 'upstream_error'),
          errorCode: 'upstream_error',
        };
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
          isTimeout ? 'DaData timed out' : 'Could not reach DaData',
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
