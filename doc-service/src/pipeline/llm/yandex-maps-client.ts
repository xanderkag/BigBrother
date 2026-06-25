/**
 * INTEGRATION_HUB yandex_maps: тонкий клиент для Яндекс.Карт —
 * геокодер + маршрут/расстояние (Distance Matrix / Router).
 *
 * Зачем отдельный клиент (по образцу DaDataClient): Яндекс geo-доступен
 * из РФ без outbound-прокси. Passthrough — параметры запроса и ответ
 * Яндекс-native verbatim (мы НЕ переводим в OpenAI shape).
 *
 * Auth у Яндекса: `apikey` в query-string (НЕ Bearer, НЕ Token).
 *   - Геокодер:  GET https://geocode-maps.yandex.ru/1.x/?apikey=<key>&format=json&geocode=<q>
 *     (https://yandex.ru/dev/geocode/doc/ru/)
 *   - Distance Matrix / Router: GET https://api.routing.yandex.net/v2/distancematrix
 *     ?apikey=<key>&origins=<lat,lon|...>&destinations=<lat,lon|...>&mode=driving
 *     (https://yandex.ru/dev/routing/doc/ru/) — точная схема параметров под
 *     уточнение при наличии ключа; здесь forward'им любые native-параметры как есть.
 *
 * Используется в llm-gateway route на endpoints /v1/maps/*.
 */

import { request } from 'undici';
import { llmCallsTotal, llmCallDurationSeconds } from '../../metrics.js';
import { openAiError, type GatewayUpstreamResult } from './chat-client.js';

export type YandexMapsClientOptions = {
  /** База геокодера, напр. https://geocode-maps.yandex.ru. */
  geocoderBaseUrl: string;
  /** База маршрутизатора / distance-matrix, напр. https://api.routing.yandex.net. */
  routerBaseUrl: string;
  /** Яндекс API ключ — уходит в query `apikey` (не Bearer). */
  apiKey: string;
  timeoutMs: number;
};

const GEOCODER_PATH = '/1.x/';
const ROUTER_PATH = '/v2/distancematrix';

export class YandexMapsClient {
  constructor(private readonly opts: YandexMapsClientOptions) {}

  isAvailable(): boolean {
    return !!(this.opts.geocoderBaseUrl && this.opts.routerBaseUrl && this.opts.apiKey);
  }

  /**
   * Геокодинг: прямой/обратный. `params` — native параметры Яндекс-геокодера
   * (минимум `geocode`; опц. `kind`, `results`, `lang`, `bbox`, ...).
   * `format=json` и `apikey` подставляем мы.
   */
  geocode(params: Record<string, string>): Promise<GatewayUpstreamResult> {
    return this.get(this.opts.geocoderBaseUrl, GEOCODER_PATH, 'gateway/yandex-geocode', {
      format: 'json',
      ...params,
    });
  }

  /**
   * Маршрут/расстояние: `params` — native параметры Distance Matrix / Router
   * (origins, destinations, mode, ...). `apikey` подставляем мы.
   */
  route(params: Record<string, string>): Promise<GatewayUpstreamResult> {
    return this.get(this.opts.routerBaseUrl, ROUTER_PATH, 'gateway/yandex-route', params);
  }

  private async get(
    baseUrl: string,
    path: string,
    endpointLabel: string,
    params: Record<string, string>,
  ): Promise<GatewayUpstreamResult> {
    const url = this.resolveUrl(baseUrl, path, params);
    const startedAt = Date.now();

    try {
      const res = await request(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
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
            `Yandex Maps returned non-JSON (${status})`,
            'upstream_error',
            'upstream_bad_response',
          ),
          errorCode: 'upstream_bad_response',
        };
      }

      if (status >= 400) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        // Яндекс ошибки — обычно {message: "..."} или {error: "..."}.
        // Заворачиваем в OpenAI shape для единообразия с другими /v1/* роутами.
        const msg = extractErrorMessage(parsed) ?? `Yandex Maps error (${status})`;
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
          isTimeout ? 'Yandex Maps timed out' : 'Could not reach Yandex Maps',
          'upstream_error',
          errorCode,
        ),
        errorCode,
      };
    }
  }

  /**
   * Собираем URL: base + path + query (apikey + native params). apikey
   * добавляем последним и всегда — клиент resolved только с ключом.
   */
  private resolveUrl(baseUrl: string, path: string, params: Record<string, string>): string {
    const base = baseUrl.replace(/\/+$/, '');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    qs.set('apikey', this.opts.apiKey);
    return `${base}${path}?${qs.toString()}`;
  }
}

function extractErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.error === 'string') return obj.error;
  if (obj.error && typeof obj.error === 'object') {
    const inner = obj.error as Record<string, unknown>;
    if (typeof inner.message === 'string') return inner.message;
  }
  return null;
}
