/**
 * EXT-LLM-GATEWAY (local) — doc-service как OpenAI-совместимый LLM-шлюз.
 *
 * Harness: голый Fastify с zod-компиляторами + только llmGatewayRoutes.
 * config.js замокан (управляем картой алиасов / baseUrl / named-ключами),
 * db.js замокан (usage-insert не ходит в БД), undici замокан (нет сети до
 * GPU Ollama). Используем РЕАЛЬНЫЙ bearerAuthHook через named-key путь
 * (он не трогает БД).
 *
 * Проверяем: публикацию алиасов в /v1/models, серверный резолв алиас→tag
 * (дефолт при пусто/неизвестно), подмену model + снятие stream в upstream,
 * эхо опубликованного алиаса в ответе, запись slim-usage, проброс upstream-
 * ошибки, OpenAI-shaped 400 на кривое тело, auth-гейт, 503 без backend.
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
      baseUrl: 'http://gpu:11434/v1' as string | undefined,
      defaultAlias: 'parsdocs-chat',
      models: {
        'parsdocs-chat': 'mistral-small3.1',
        'parsdocs-vision': 'qwen2.5vl:72b',
      } as Record<string, string>,
      timeoutMs: 120000,
    },
  },
}));

vi.mock('../src/config.js', () => ({ config: cfg }));
vi.mock('../src/db.js', () => ({ db: { query: vi.fn() } }));

const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...a: unknown[]) => requestMock(...a) }));

let llmGatewayRoutes: typeof import('../src/routes/llm-gateway.js').llmGatewayRoutes;
let db: { query: Mock };

/** undici-ответ: только statusCode + body.text() (так читает chat-client). */
function upstream(status: number, json: unknown) {
  return { statusCode: status, body: { text: async () => JSON.stringify(json) } };
}

/** Типовой OpenAI chat.completion от Ollama. */
function completion(model: string) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model, // сырой backend-tag — шлюз должен заменить на алиас
    choices: [{ index: 0, message: { role: 'assistant', content: 'привет' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // сброс конфига к дефолтам (тесты, мутирующие cfg, восстановят его)
  cfg.llmGateway.baseUrl = 'http://gpu:11434/v1';
  cfg.llm.url = undefined;
  cfg.llmGateway.models = {
    'parsdocs-chat': 'mistral-small3.1',
    'parsdocs-vision': 'qwen2.5vl:72b',
  };
  cfg.llmGateway.defaultAlias = 'parsdocs-chat';
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

function lastUpstreamBody(): Record<string, unknown> {
  const [, opts] = requestMock.mock.calls.at(-1) as [string, { body: string }];
  return JSON.parse(opts.body);
}

describe('GET /v1/models', () => {
  it('публикует наши алиасы (не сырые backend-теги), требует auth', async () => {
    const app = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/v1/models', headers: AUTH });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.object).toBe('list');
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('parsdocs-chat');
    expect(ids).toContain('parsdocs-vision');
    // сырых ollama-тегов в публикации быть не должно
    expect(ids).not.toContain('mistral-small3.1');
  });

  it('без Bearer → 401', async () => {
    const app = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(r.statusCode).toBe(401);
  });

  it('неверный ключ → 401', async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer nope' },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('POST /v1/chat/completions — резолв модели', () => {
  it('пустой model → дефолтный алиас; upstream получает backend-tag, ответ эхает алиас', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'привет' }] },
    });
    expect(r.statusCode).toBe(200);
    // upstream получил backend-tag
    const [url, opts] = requestMock.mock.calls[0] as [string, { method: string }];
    expect(url).toBe('http://gpu:11434/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(lastUpstreamBody().model).toBe('mistral-small3.1');
    // ответ клиенту — эхо опубликованного алиаса
    expect(r.json().model).toBe('parsdocs-chat');
  });

  it('известный алиас parsdocs-vision → backend qwen2.5vl:72b', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, completion('qwen2.5vl:72b')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { model: 'parsdocs-vision', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(lastUpstreamBody().model).toBe('qwen2.5vl:72b');
    expect(r.json().model).toBe('parsdocs-vision');
  });

  it('неизвестный алиас → fallback на дефолт', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { model: 'gpt-4-turbo', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(lastUpstreamBody().model).toBe('mistral-small3.1');
    expect(r.json().model).toBe('parsdocs-chat');
  });

  it('stream:true принимается, но снимается перед upstream (единый JSON)', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    expect(r.statusCode).toBe(200);
    expect(lastUpstreamBody()).not.toHaveProperty('stream');
  });

  it('temperature/max_tokens пробрасываются в upstream', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
        max_tokens: 256,
      },
    });
    const body = lastUpstreamBody();
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(256);
  });
});

describe('POST /v1/chat/completions — usage', () => {
  it('пишет slim-строку (caller/alias/model/tokens/status=success)', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO llm_gateway_usage/);
    expect(params[0]).toBe('slai'); // caller из named key
    expect(params[1]).toBe('parsdocs-chat'); // alias
    expect(params[2]).toBe('mistral-small3.1'); // backend model
    expect(params[3]).toBe(11); // prompt_tokens
    expect(params[4]).toBe(7); // completion_tokens
    expect(params[6]).toBe('success'); // status
  });

  it('ответ клиенту не падает если usage-insert бросил', async () => {
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
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
});

describe('POST /v1/chat/completions — ошибки', () => {
  it('upstream 500 → проброс статуса и тела, usage status=error', async () => {
    requestMock.mockResolvedValueOnce(
      upstream(500, { error: { message: 'model crashed', type: 'server_error', code: 'oom' } }),
    );
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().error.message).toBe('model crashed');
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBe('error'); // status
    expect(params[7]).toBe('upstream_error'); // error_code
  });

  it('кривое тело (нет messages) → 400 в OpenAI-error форме', async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: { model: 'parsdocs-chat' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.type).toBe('invalid_request_error');
    // upstream дёргать не должны
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('без backend (baseUrl и llm.url пусты) → 503 gateway_unconfigured', async () => {
    cfg.llmGateway.baseUrl = undefined;
    cfg.llm.url = undefined;
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
