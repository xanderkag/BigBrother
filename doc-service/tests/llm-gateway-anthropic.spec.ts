/**
 * EXT-LLM-GATEWAY-ANTHROPIC — chat при backend='anthropic'.
 *
 * /v1/chat/completions транслируется в Anthropic native /v1/messages и
 * обратно в OpenAI chat.completion shape. Проверяем: выбор backend, ключ
 * env → provider_settings id='gateway-anthropic' (выделенный ключ канала,
 * вносится из UI) → findDefault('llm') (legacy), URL /v1/messages, заголовки
 * x-api-key + anthropic-version (не Authorization), трансляцию запроса
 * (system top-level, max_tokens default), трансляцию ответа (content[]→
 * choices[].message, usage input/output→prompt/completion), эхо алиаса,
 * usage-лог, fail-soft usage, проброс Anthropic-ошибки в OpenAI shape,
 * 503 без ключа.
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
      backend: 'anthropic' as 'openai_compat' | 'anthropic',
      apiKey: undefined as string | undefined,
      baseUrl: undefined as string | undefined,
      defaultAlias: 'parsdocs-chat',
      models: { 'parsdocs-chat': 'claude-3-5-sonnet-20241022' } as Record<string, string>,
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

/** Типовой Anthropic /v1/messages ответ. */
function anthropicMessage(model: string) {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'привет' }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 5 },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  cfg.llmGateway.backend = 'anthropic';
  cfg.llmGateway.apiKey = 'sk-ant-env';
  cfg.llmGateway.baseUrl = undefined;
  cfg.llmGateway.defaultAlias = 'parsdocs-chat';
  cfg.llmGateway.models = { 'parsdocs-chat': 'claude-3-5-sonnet-20241022' };
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

describe('anthropic backend — happy path', () => {
  it('бьёт в /v1/messages с x-api-key + anthropic-version (не Authorization)', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'привет' }] },
    });
    expect(r.statusCode).toBe(200);
    const [url, opts] = lastUpstream();
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('sk-ant-env');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    expect(opts.headers).not.toHaveProperty('authorization');
  });

  it('запрос транслируется: system top-level, backend-model, max_tokens default', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: {
        messages: [
          { role: 'system', content: 'Ты ассистент' },
          { role: 'user', content: 'привет' },
        ],
      },
    });
    const sent = JSON.parse(lastUpstream()[1].body);
    expect(sent.model).toBe('claude-3-5-sonnet-20241022');
    expect(sent.system).toBe('Ты ассистент');
    expect(sent.max_tokens).toBe(4096);
    expect(sent.messages).toEqual([{ role: 'user', content: 'привет' }]);
  });

  it('max_tokens из запроса пробрасывается в Anthropic', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 256, temperature: 0.2 },
    });
    const sent = JSON.parse(lastUpstream()[1].body);
    expect(sent.max_tokens).toBe(256);
    expect(sent.temperature).toBe(0.2);
  });

  it('ответ транслируется обратно в OpenAI shape, эхо алиаса, usage маппится', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'привет' }] },
    });
    const out = r.json();
    expect(out.object).toBe('chat.completion');
    expect(out.model).toBe('parsdocs-chat'); // эхо алиаса, не backend-tag
    expect(out.choices[0].message.role).toBe('assistant');
    expect(out.choices[0].message.content).toBe('привет');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage.prompt_tokens).toBe(12);
    expect(out.usage.completion_tokens).toBe(5);
    expect(out.usage.total_tokens).toBe(17);
  });
});

describe('anthropic backend — key resolution', () => {
  it('env пуст → выделенный ключ канала (id="gateway-anthropic") побеждает, findDefault не зовётся', async () => {
    cfg.llmGateway.apiKey = undefined;
    providerMock.findById.mockResolvedValueOnce({ api_key: 'sk-ant-channel', is_active: true });
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(providerMock.findById).toHaveBeenCalledWith('gateway-anthropic');
    expect(providerMock.findDefault).not.toHaveBeenCalled();
    expect(lastUpstream()[1].headers['x-api-key']).toBe('sk-ant-channel');
  });

  it('env пуст, выделенная строка неактивна → legacy-fallback findDefault("llm")', async () => {
    cfg.llmGateway.apiKey = undefined;
    providerMock.findById.mockResolvedValueOnce({ api_key: 'sk-ant-channel', is_active: false });
    providerMock.findDefault.mockResolvedValueOnce({ api_key: 'sk-ant-ui' });
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(providerMock.findDefault).toHaveBeenCalledWith('llm');
    expect(lastUpstream()[1].headers['x-api-key']).toBe('sk-ant-ui');
  });

  it('env пуст, выделенной строки нет → legacy-fallback findDefault("llm")', async () => {
    cfg.llmGateway.apiKey = undefined;
    providerMock.findById.mockResolvedValueOnce(null);
    providerMock.findDefault.mockResolvedValueOnce({ api_key: 'sk-ant-ui' });
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(providerMock.findDefault).toHaveBeenCalledWith('llm');
    expect(lastUpstream()[1].headers['x-api-key']).toBe('sk-ant-ui');
  });

  it('env задан → БД вообще не трогаем (env побеждает)', async () => {
    cfg.llmGateway.apiKey = 'sk-ant-env';
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(providerMock.findById).not.toHaveBeenCalled();
    expect(providerMock.findDefault).not.toHaveBeenCalled();
    expect(lastUpstream()[1].headers['x-api-key']).toBe('sk-ant-env');
  });

  it('env пуст и provider не найден → 503 gateway_unconfigured', async () => {
    cfg.llmGateway.apiKey = undefined;
    providerMock.findById.mockResolvedValueOnce(null);
    providerMock.findDefault.mockResolvedValueOnce(null);
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('gateway_unconfigured');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('БД недоступна (findById бросил) → fail-soft → 503', async () => {
    cfg.llmGateway.apiKey = undefined;
    providerMock.findById.mockRejectedValueOnce(new Error('db down'));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('gateway_unconfigured');
  });
});

describe('anthropic backend — usage + errors', () => {
  it('usage-строка: alias/backend-model/токены/status=success', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('slai');
    expect(params[1]).toBe('parsdocs-chat');
    expect(params[2]).toBe('claude-3-5-sonnet-20241022');
    expect(params[3]).toBe(12);
    expect(params[4]).toBe(5);
    expect(params[6]).toBe('success');
  });

  it('ответ не падает если usage-insert бросил', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, anthropicMessage('claude-3-5-sonnet-20241022')));
    db.query.mockRejectedValueOnce(new Error('db down'));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().model).toBe('parsdocs-chat');
  });

  it('Anthropic 400 error → проброс статуса + OpenAI-shape, usage status=error', async () => {
    requestMock.mockResolvedValueOnce(
      upstream(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } }),
    );
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('max_tokens too large');
    expect(r.json().error.type).toBe('invalid_request_error');
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBe('error');
    expect(params[7]).toBe('upstream_error');
  });

  it('Anthropic вернул не-JSON → 502 upstream_bad_response', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: { text: async () => 'overloaded' },
    });
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('upstream_bad_response');
  });
});
