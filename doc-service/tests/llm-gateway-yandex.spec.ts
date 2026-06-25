/**
 * INTEGRATION_HUB yandex_maps — покрытие /v1/maps/geocode и /v1/maps/route.
 * Passthrough к Яндекс.Картам: native query-параметры → query (с apikey),
 * native ответ verbatim; auth Яндекса — `apikey` в query (НЕ Bearer);
 * ключ-fallback env→provider_settings(kind=yandex_maps). Проверяем fail-closed
 * (enabled=false / нет ключа), happy-path обоих эндпоинтов, apikey в query
 * (не Bearer к Яндексу), native body/response, auth-гейт PAT на входе, usage
 * (connector='yandex_maps', unit_kind=geocodes|routes, units=1), fail-soft
 * usage, проброс upstream-ошибки, валидацию тела.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const { cfg } = vi.hoisted(() => ({
  cfg: {
    apiKey: '',
    apiKeysJson: { 'slai-key': 'slai' } as Record<string, string>,
    allowNoAuth: false,
    llm: { url: undefined as string | undefined, apiKey: undefined, timeoutMs: 60000 },
    llmGateway: {
      enabled: true,
      backend: 'openai_compat' as 'openai_compat' | 'anthropic',
      apiKey: undefined as string | undefined,
      baseUrl: 'http://gpu:11434/v1' as string | undefined,
      defaultAlias: 'parsdocs-chat',
      models: { 'parsdocs-chat': 'mistral-small3.1' } as Record<string, string>,
      timeoutMs: 120000,
      embeddings: {
        enabled: false,
        provider: 'openai' as const,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: undefined as string | undefined,
        defaultAlias: 'parsdocs-embeddings',
        models: {} as Record<string, string>,
        timeoutMs: 60000,
      },
      dadata: {
        enabled: false,
        baseUrl: 'https://suggestions.dadata.ru',
        apiKey: undefined as string | undefined,
        timeoutMs: 15000,
      },
      yandexMaps: {
        enabled: false,
        geocoderBaseUrl: 'https://geocode-maps.yandex.ru',
        routerBaseUrl: 'https://api.routing.yandex.net',
        apiKey: undefined as string | undefined,
        timeoutMs: 15000,
      },
    },
  },
}));

vi.mock('../src/config.js', () => ({ config: cfg }));
vi.mock('../src/db.js', () => ({ db: { query: vi.fn() } }));

const providerMock = vi.hoisted(() => ({ findById: vi.fn(), findDefault: vi.fn() }));
vi.mock('../src/storage/provider-settings.js', () => ({ providerSettingsRepo: providerMock }));

const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...a: unknown[]) => requestMock(...a) }));

let llmGatewayRoutes: typeof import('../src/routes/llm-gateway.js').llmGatewayRoutes;
let db: { query: Mock };

function upstream(status: number, json: unknown) {
  return { statusCode: status, body: { text: async () => JSON.stringify(json) } };
}

/** Типовой Яндекс-геокодер ответ (усечённый native shape). */
function yandexGeocode() {
  return {
    response: {
      GeoObjectCollection: {
        featureMember: [
          {
            GeoObject: {
              name: 'Москва, Тверская улица, 1',
              Point: { pos: '37.611347 55.760241' },
            },
          },
        ],
      },
    },
  };
}

/** Типовой Distance Matrix ответ (усечённый native shape). */
function yandexRoute() {
  return {
    rows: [{ elements: [{ status: 'OK', distance: { value: 12345 }, duration: { value: 678 } }] }],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  cfg.llmGateway.yandexMaps.enabled = false;
  cfg.llmGateway.yandexMaps.apiKey = undefined;
  cfg.llmGateway.yandexMaps.geocoderBaseUrl = 'https://geocode-maps.yandex.ru';
  cfg.llmGateway.yandexMaps.routerBaseUrl = 'https://api.routing.yandex.net';
  providerMock.findById.mockReset();
  providerMock.findDefault.mockReset();
  ({ llmGatewayRoutes } = await import('../src/routes/llm-gateway.js'));
  ({ db } = (await import('../src/db.js')) as unknown as { db: { query: Mock } });
});

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(llmGatewayRoutes);
  await app.ready();
  return app;
}

const AUTH = { authorization: 'Bearer slai-key' };

function lastUpstream(): [string, { method: string; headers: Record<string, string> }] {
  return requestMock.mock.calls.at(-1) as [string, { method: string; headers: Record<string, string> }];
}

describe('POST /v1/maps/geocode — fail-closed', () => {
  it('enabled=false → 503 yandex_unconfigured, upstream не дёргается', async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      headers: AUTH,
      payload: { geocode: 'Москва, Тверская 1' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('yandex_unconfigured');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('enabled=true но ключа нет → 503', async () => {
    cfg.llmGateway.yandexMaps.enabled = true;
    providerMock.findDefault.mockResolvedValueOnce(null);
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      headers: AUTH,
      payload: { geocode: 'Москва' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('yandex_unconfigured');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('POST /v1/maps/geocode — auth', () => {
  it('без Bearer → 401', async () => {
    cfg.llmGateway.yandexMaps.enabled = true;
    cfg.llmGateway.yandexMaps.apiKey = 'ya-key';
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      payload: { geocode: 'Москва' },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('POST /v1/maps/geocode — happy path', () => {
  beforeEach(() => {
    cfg.llmGateway.yandexMaps.enabled = true;
    cfg.llmGateway.yandexMaps.apiKey = 'ya-env-key';
  });

  it('apikey в query (НЕ Bearer), GET, native params в query, native response verbatim', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, yandexGeocode()));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      headers: AUTH,
      payload: { geocode: 'Москва, Тверская 1', lang: 'ru_RU', results: 5 },
    });
    expect(r.statusCode).toBe(200);
    const [url, opts] = lastUpstream();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://geocode-maps.yandex.ru/1.x/');
    // apikey в query, НЕ в заголовке Authorization
    expect(u.searchParams.get('apikey')).toBe('ya-env-key');
    expect(u.searchParams.get('format')).toBe('json');
    expect(u.searchParams.get('geocode')).toBe('Москва, Тверская 1');
    expect(u.searchParams.get('lang')).toBe('ru_RU');
    expect(u.searchParams.get('results')).toBe('5');
    expect(opts.method).toBe('GET');
    expect(opts.headers.authorization).toBeUndefined();
    // response — Яндекс-native verbatim
    const out = r.json();
    expect(out.response.GeoObjectCollection.featureMember[0].GeoObject.Point.pos).toBe(
      '37.611347 55.760241',
    );
  });

  it('usage: alias=yandex_maps-geocode, model=yandex_maps, connector=yandex_maps, unit_kind=geocodes, units=1', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, yandexGeocode()));
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      headers: AUTH,
      payload: { geocode: 'Москва' },
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO llm_gateway_usage/);
    expect(params[0]).toBe('slai'); // caller
    expect(params[1]).toBe('yandex_maps-geocode'); // alias
    expect(params[2]).toBe('yandex_maps'); // model
    expect(params[3]).toBeNull(); // prompt_tokens
    expect(params[4]).toBeNull(); // completion_tokens
    expect(params[6]).toBe('success'); // status
    expect(params[8]).toBe('yandex_maps'); // connector
    expect(params[9]).toBe(1); // units
    expect(params[10]).toBe('geocodes'); // unit_kind
  });

  it('ответ клиенту не падает если usage-insert бросил', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, yandexGeocode()));
    db.query.mockRejectedValueOnce(new Error('db down'));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      headers: AUTH,
      payload: { geocode: 'Москва' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().response).toBeTruthy();
  });
});

describe('POST /v1/maps/geocode — key fallback', () => {
  it('env пуст → findDefault("yandex_maps"), apikey из UI', async () => {
    cfg.llmGateway.yandexMaps.enabled = true;
    cfg.llmGateway.yandexMaps.apiKey = undefined;
    providerMock.findDefault.mockResolvedValueOnce({ api_key: 'ya-from-ui' });
    requestMock.mockResolvedValueOnce(upstream(200, yandexGeocode()));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      headers: AUTH,
      payload: { geocode: 'Москва' },
    });
    expect(r.statusCode).toBe(200);
    expect(providerMock.findDefault).toHaveBeenCalledWith('yandex_maps');
    const u = new URL(lastUpstream()[0]);
    expect(u.searchParams.get('apikey')).toBe('ya-from-ui');
  });
});

describe('POST /v1/maps/geocode — error passthrough', () => {
  beforeEach(() => {
    cfg.llmGateway.yandexMaps.enabled = true;
    cfg.llmGateway.yandexMaps.apiKey = 'ya-env-key';
  });

  it('upstream 403 {message} → OpenAI-shape error, статус 403, usage status=error', async () => {
    requestMock.mockResolvedValueOnce(upstream(403, { message: 'Invalid API key' }));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      headers: AUTH,
      payload: { geocode: 'Москва' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe('Invalid API key');
    expect(r.json().error.type).toBe('upstream_error');
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBe('error');
    expect(params[7]).toBe('upstream_error');
    expect(params[8]).toBe('yandex_maps');
  });
});

describe('POST /v1/maps/route', () => {
  beforeEach(() => {
    cfg.llmGateway.yandexMaps.enabled = true;
    cfg.llmGateway.yandexMaps.apiKey = 'ya-env-key';
  });

  it('happy path: router base + path, apikey в query, native params, usage unit_kind=routes', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, yandexRoute()));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/route',
      headers: AUTH,
      payload: { origins: '55.75,37.61', destinations: '59.93,30.31', mode: 'driving' },
    });
    expect(r.statusCode).toBe(200);
    const [url, opts] = lastUpstream();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.routing.yandex.net/v2/distancematrix');
    expect(u.searchParams.get('apikey')).toBe('ya-env-key');
    expect(u.searchParams.get('origins')).toBe('55.75,37.61');
    expect(u.searchParams.get('destinations')).toBe('59.93,30.31');
    expect(u.searchParams.get('mode')).toBe('driving');
    expect(opts.method).toBe('GET');
    expect(opts.headers.authorization).toBeUndefined();
    expect(r.json().rows[0].elements[0].distance.value).toBe(12345);
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe('yandex_maps-route');
    expect(params[2]).toBe('yandex_maps');
    expect(params[8]).toBe('yandex_maps');
    expect(params[9]).toBe(1);
    expect(params[10]).toBe('routes');
  });

  it('enabled=false → 503', async () => {
    cfg.llmGateway.yandexMaps.enabled = false;
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/route',
      headers: AUTH,
      payload: { origins: '55.75,37.61', destinations: '59.93,30.31' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('yandex_unconfigured');
  });
});

describe('POST /v1/maps/* — валидация тела', () => {
  beforeEach(() => {
    cfg.llmGateway.yandexMaps.enabled = true;
    cfg.llmGateway.yandexMaps.apiKey = 'ya-env-key';
  });

  it('geocode: пустой geocode → 400 invalid_request_error, upstream не дёргается', async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/geocode',
      headers: AUTH,
      payload: { geocode: '' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.type).toBe('invalid_request_error');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('route: нет destinations → 400, upstream не дёргается', async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/maps/route',
      headers: AUTH,
      payload: { origins: '55.75,37.61' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.type).toBe('invalid_request_error');
    expect(requestMock).not.toHaveBeenCalled();
  });
});
