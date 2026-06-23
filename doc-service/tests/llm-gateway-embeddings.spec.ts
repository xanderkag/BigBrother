/**
 * EXT-LLM-GATEWAY-EMBEDDINGS — покрытие /v1/embeddings.
 *
 * Тот же harness, что и llm-gateway.spec.ts: config/db/undici замоканы,
 * дополнительно мокаем provider-settings repo (key-fallback env→UI).
 * Проверяем: fail-closed при enabled=false (503), happy-path с резолвом
 * embeddings-алиаса и Bearer-ключом, ключ-fallback на provider_settings,
 * auth-гейт, slim-usage (completion_tokens=null), fail-soft usage-insert,
 * проброс upstream-ошибки, 500 при пустой карте алиасов.
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
        models: { 'parsdocs-embeddings': 'text-embedding-3-small' } as Record<string, string>,
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

function embeddingResponse(model: string) {
  return {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
    model,
    usage: { prompt_tokens: 9, total_tokens: 9 },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  cfg.llmGateway.embeddings.enabled = false;
  cfg.llmGateway.embeddings.apiKey = undefined;
  cfg.llmGateway.embeddings.baseUrl = 'https://api.openai.com/v1';
  cfg.llmGateway.embeddings.defaultAlias = 'parsdocs-embeddings';
  cfg.llmGateway.embeddings.models = { 'parsdocs-embeddings': 'text-embedding-3-small' };
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

describe('POST /v1/embeddings — fail-closed', () => {
  it('enabled=false → 503 embeddings_unconfigured, upstream не дёргается', async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'привет' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('embeddings_unconfigured');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('enabled=true но ключа нет (env пуст, provider не найден) → 503', async () => {
    cfg.llmGateway.embeddings.enabled = true;
    providerMock.findById.mockResolvedValueOnce(null);
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'hi' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('embeddings_unconfigured');
  });
});

describe('POST /v1/embeddings — auth', () => {
  it('без Bearer → 401', async () => {
    cfg.llmGateway.embeddings.enabled = true;
    cfg.llmGateway.embeddings.apiKey = 'sk-emb';
    const app = await makeApp();
    const r = await app.inject({ method: 'POST', url: '/v1/embeddings', payload: { input: 'hi' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('POST /v1/embeddings — happy path (env key)', () => {
  beforeEach(() => {
    cfg.llmGateway.embeddings.enabled = true;
    cfg.llmGateway.embeddings.apiKey = 'sk-emb-env';
  });

  it('резолв дефолтного алиаса, Bearer-ключ в upstream, эхо алиаса', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, embeddingResponse('text-embedding-3-small')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'привет' },
    });
    expect(r.statusCode).toBe(200);
    const [url, opts] = lastUpstream();
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(opts.headers.authorization).toBe('Bearer sk-emb-env');
    expect(JSON.parse(opts.body).model).toBe('text-embedding-3-small');
    expect(r.json().model).toBe('parsdocs-embeddings');
  });

  it('известный алиас резолвится в backend-tag', async () => {
    cfg.llmGateway.embeddings.models = {
      'parsdocs-embeddings': 'text-embedding-3-small',
      'parsdocs-embeddings-large': 'text-embedding-3-large',
    };
    requestMock.mockResolvedValueOnce(upstream(200, embeddingResponse('text-embedding-3-large')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { model: 'parsdocs-embeddings-large', input: 'hi' },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(lastUpstream()[1].body).model).toBe('text-embedding-3-large');
    expect(r.json().model).toBe('parsdocs-embeddings-large');
  });

  it('пустая карта алиасов → 500 no_model_configured', async () => {
    cfg.llmGateway.embeddings.models = {};
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'hi' },
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().error.code).toBe('no_model_configured');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('POST /v1/embeddings — key fallback на provider_settings', () => {
  it('env пуст → берём provider findById("openai") если is_active', async () => {
    cfg.llmGateway.embeddings.enabled = true;
    cfg.llmGateway.embeddings.apiKey = undefined;
    providerMock.findById.mockResolvedValueOnce({ api_key: 'sk-from-ui', is_active: true });
    requestMock.mockResolvedValueOnce(upstream(200, embeddingResponse('text-embedding-3-small')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'hi' },
    });
    expect(r.statusCode).toBe(200);
    expect(providerMock.findById).toHaveBeenCalledWith('openai');
    expect(lastUpstream()[1].headers.authorization).toBe('Bearer sk-from-ui');
  });

  it('provider найден но is_active=false → 503 (ключ не берём)', async () => {
    cfg.llmGateway.embeddings.enabled = true;
    cfg.llmGateway.embeddings.apiKey = undefined;
    providerMock.findById.mockResolvedValueOnce({ api_key: 'sk-inactive', is_active: false });
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'hi' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('embeddings_unconfigured');
  });
});

describe('POST /v1/embeddings — usage', () => {
  beforeEach(() => {
    cfg.llmGateway.embeddings.enabled = true;
    cfg.llmGateway.embeddings.apiKey = 'sk-emb-env';
  });

  it('slim-строка: caller/alias/model/prompt_tokens, completion_tokens=null, status=success', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, embeddingResponse('text-embedding-3-small')));
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'hi' },
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO llm_gateway_usage/);
    expect(params[0]).toBe('slai');
    expect(params[1]).toBe('parsdocs-embeddings');
    expect(params[2]).toBe('text-embedding-3-small');
    expect(params[3]).toBe(9);
    expect(params[4]).toBeNull();
    expect(params[6]).toBe('success');
  });

  it('ответ клиенту не падает если usage-insert бросил', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, embeddingResponse('text-embedding-3-small')));
    db.query.mockRejectedValueOnce(new Error('db down'));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'hi' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().model).toBe('parsdocs-embeddings');
  });
});

describe('POST /v1/embeddings — error passthrough', () => {
  beforeEach(() => {
    cfg.llmGateway.embeddings.enabled = true;
    cfg.llmGateway.embeddings.apiKey = 'sk-emb-env';
  });

  it('upstream 429 → проброс статуса/тела, usage status=error errorCode=upstream_error', async () => {
    requestMock.mockResolvedValueOnce(
      upstream(429, { error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate' } }),
    );
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'hi' },
    });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toBe('rate limited');
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBe('error');
    expect(params[7]).toBe('upstream_error');
  });

  it('upstream вернул не-JSON → 502 upstream_bad_response', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: { text: async () => '<html>proxy error</html>' },
    });
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: AUTH,
      payload: { input: 'hi' },
    });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('upstream_bad_response');
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBe('error');
  });
});
