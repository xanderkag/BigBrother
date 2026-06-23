/**
 * EXT-LLM-GATEWAY-DADATA — покрытие /v1/dadata/findById/party и
 * /v1/dadata/suggest/party. Passthrough к suggestions.dadata.ru:
 * DaData-native shape в обе стороны, auth `Token <key>` (НЕ Bearer),
 * ключ-fallback env→provider_settings(kind=dadata). Проверяем fail-closed,
 * happy-path обоих эндпоинтов, заголовок Token, native body/response,
 * auth-гейт, usage (alias=dadata-<op>, model=dadata), fail-soft usage,
 * проброс upstream-ошибки.
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

/** Типовой DaData findById/party ответ (native shape). */
function dadataParty() {
  return {
    suggestions: [
      {
        value: 'ООО "РОГА И КОПЫТА"',
        unrestricted_value: 'ООО "РОГА И КОПЫТА"',
        data: { inn: '7707083893', kpp: '770701001', ogrn: '1027700132195' },
      },
    ],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  cfg.llmGateway.dadata.enabled = false;
  cfg.llmGateway.dadata.apiKey = undefined;
  cfg.llmGateway.dadata.baseUrl = 'https://suggestions.dadata.ru';
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

function lastUpstream(): [string, { headers: Record<string, string>; body: string }] {
  return requestMock.mock.calls.at(-1) as [string, { headers: Record<string, string>; body: string }];
}

describe('POST /v1/dadata/findById/party — fail-closed', () => {
  it('enabled=false → 503 dadata_unconfigured, upstream не дёргается', async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      headers: AUTH,
      payload: { query: '7707083893' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('dadata_unconfigured');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('enabled=true но ключа нет → 503', async () => {
    cfg.llmGateway.dadata.enabled = true;
    providerMock.findDefault.mockResolvedValueOnce(null);
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      headers: AUTH,
      payload: { query: '7707083893' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('dadata_unconfigured');
  });
});

describe('POST /v1/dadata/findById/party — auth', () => {
  it('без Bearer → 401', async () => {
    cfg.llmGateway.dadata.enabled = true;
    cfg.llmGateway.dadata.apiKey = 'dd-key';
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      payload: { query: '7707083893' },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('POST /v1/dadata/findById/party — happy path', () => {
  beforeEach(() => {
    cfg.llmGateway.dadata.enabled = true;
    cfg.llmGateway.dadata.apiKey = 'dd-env-key';
  });

  it('Token-заголовок (не Bearer), native body, native response verbatim', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, dadataParty()));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      headers: AUTH,
      payload: { query: '7707083893', branch_type: 'MAIN' },
    });
    expect(r.statusCode).toBe(200);
    const [url, opts] = lastUpstream();
    expect(url).toBe('https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party');
    expect(opts.headers.authorization).toBe('Token dd-env-key');
    expect(opts.headers.authorization).not.toMatch(/Bearer/);
    // body — native DaData verbatim (не переведён в OpenAI shape)
    const sent = JSON.parse(opts.body);
    expect(sent.query).toBe('7707083893');
    expect(sent.branch_type).toBe('MAIN');
    // response — native DaData verbatim
    const out = r.json();
    expect(out.suggestions[0].data.inn).toBe('7707083893');
  });

  it('usage: alias=dadata-findById, model=dadata, токены=null, status=success', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, dadataParty()));
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      headers: AUTH,
      payload: { query: '7707083893' },
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO llm_gateway_usage/);
    expect(params[0]).toBe('slai');
    expect(params[1]).toBe('dadata-findById');
    expect(params[2]).toBe('dadata');
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
    expect(params[6]).toBe('success');
  });

  it('ответ клиенту не падает если usage-insert бросил', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, dadataParty()));
    db.query.mockRejectedValueOnce(new Error('db down'));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      headers: AUTH,
      payload: { query: '7707083893' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().suggestions[0].data.inn).toBe('7707083893');
  });
});

describe('POST /v1/dadata/findById/party — key fallback', () => {
  it('env пуст → findDefault("dadata")', async () => {
    cfg.llmGateway.dadata.enabled = true;
    cfg.llmGateway.dadata.apiKey = undefined;
    providerMock.findDefault.mockResolvedValueOnce({ api_key: 'dd-from-ui' });
    requestMock.mockResolvedValueOnce(upstream(200, dadataParty()));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      headers: AUTH,
      payload: { query: '7707083893' },
    });
    expect(r.statusCode).toBe(200);
    expect(providerMock.findDefault).toHaveBeenCalledWith('dadata');
    expect(lastUpstream()[1].headers.authorization).toBe('Token dd-from-ui');
  });
});

describe('POST /v1/dadata/findById/party — error passthrough', () => {
  beforeEach(() => {
    cfg.llmGateway.dadata.enabled = true;
    cfg.llmGateway.dadata.apiKey = 'dd-env-key';
  });

  it('upstream 403 {message} → OpenAI-shape error, статус 403, usage status=error', async () => {
    requestMock.mockResolvedValueOnce(upstream(403, { message: 'Invalid API key' }));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      headers: AUTH,
      payload: { query: '7707083893' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe('Invalid API key');
    expect(r.json().error.type).toBe('upstream_error');
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBe('error');
    expect(params[7]).toBe('upstream_error');
  });
});

describe('POST /v1/dadata/suggest/party', () => {
  beforeEach(() => {
    cfg.llmGateway.dadata.enabled = true;
    cfg.llmGateway.dadata.apiKey = 'dd-env-key';
  });

  it('happy path: правильный suggest-путь, Token-заголовок, usage alias=dadata-suggest', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, dadataParty()));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/suggest/party',
      headers: AUTH,
      payload: { query: 'рога', count: 5 },
    });
    expect(r.statusCode).toBe(200);
    const [url, opts] = lastUpstream();
    expect(url).toBe('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party');
    expect(opts.headers.authorization).toBe('Token dd-env-key');
    expect(r.json().suggestions[0].value).toBe('ООО "РОГА И КОПЫТА"');
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe('dadata-suggest');
    expect(params[2]).toBe('dadata');
  });

  it('enabled=false → 503', async () => {
    cfg.llmGateway.dadata.enabled = false;
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/suggest/party',
      headers: AUTH,
      payload: { query: 'рога' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('dadata_unconfigured');
  });
});

describe('POST /v1/dadata/* — валидация тела', () => {
  beforeEach(() => {
    cfg.llmGateway.dadata.enabled = true;
    cfg.llmGateway.dadata.apiKey = 'dd-env-key';
  });

  it('пустой query → 400 invalid_request_error, upstream не дёргается', async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/dadata/findById/party',
      headers: AUTH,
      payload: { query: '' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.type).toBe('invalid_request_error');
    expect(requestMock).not.toHaveBeenCalled();
  });
});
