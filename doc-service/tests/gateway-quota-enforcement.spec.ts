/**
 * INTEGRATION_HUB (Ф1) — enforcement суточных квот в LLM-шлюзе.
 *
 * Проверяем строгий flag-gate + fail-open на /v1/chat/completions (коннектор
 * 'llm'):
 *   - флаг off → ПРОПУСК даже при превышении (checkConsumerQuota даже не зовётся);
 *   - флаг on + !allowed → 429 в OpenAI-error форме (code=quota_exceeded), upstream НЕ зовётся;
 *   - флаг on + allowed (нет cap / под лимитом) → ПРОПУСК (fail-open);
 *   - флаг on + checkConsumerQuota бросил → ПРОПУСК (fail-open);
 *   - флаг on, но caller=null (root-key) → ПРОПУСК (некого энфорсить).
 *
 * Harness как в llm-gateway.spec: голый Fastify + zod, config/db/undici мокнуты,
 * checkConsumerQuota мокнут из ../src/storage/gateway-connectors.js.
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
      quotaEnabled: false,
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

const checkConsumerQuota = vi.fn();
vi.mock('../src/storage/gateway-connectors.js', () => ({ checkConsumerQuota }));

const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...a: unknown[]) => requestMock(...a) }));

let llmGatewayRoutes: typeof import('../src/routes/llm-gateway.js').llmGatewayRoutes;

function upstream(status: number, json: unknown) {
  return { statusCode: status, body: { text: async () => JSON.stringify(json) } };
}
function completion(model: string) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  cfg.llmGateway.quotaEnabled = false;
  cfg.llmGateway.baseUrl = 'http://gpu:11434/v1';
  cfg.llmGateway.models = { 'parsdocs-chat': 'mistral-small3.1' };
  cfg.llmGateway.defaultAlias = 'parsdocs-chat';
  ({ llmGatewayRoutes } = await import('../src/routes/llm-gateway.js'));
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
const payload = { messages: [{ role: 'user', content: 'hi' }] };

async function chat(app: FastifyInstance) {
  return app.inject({ method: 'POST', url: '/v1/chat/completions', headers: AUTH, payload });
}

describe('enforcement: флаг OFF', () => {
  it('quotaEnabled=false → ПРОПУСК даже при превышении; checkConsumerQuota не зовётся', async () => {
    cfg.llmGateway.quotaEnabled = false;
    checkConsumerQuota.mockResolvedValue({ allowed: false, reason: 'quota_exceeded' });
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    const r = await chat(app);
    expect(r.statusCode).toBe(200);
    expect(checkConsumerQuota).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1); // upstream дёрнут
  });
});

describe('enforcement: флаг ON', () => {
  it('!allowed → 429 quota_exceeded, upstream НЕ зовётся', async () => {
    cfg.llmGateway.quotaEnabled = true;
    checkConsumerQuota.mockResolvedValue({ allowed: false, reason: 'quota_exceeded' });
    const app = await makeApp();
    const r = await chat(app);
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('quota_exceeded');
    expect(r.json().error.type).toBe('rate_limit_error');
    expect(checkConsumerQuota).toHaveBeenCalledWith('slai', 'llm');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('allowed (нет cap / под лимитом) → ПРОПУСК (fail-open)', async () => {
    cfg.llmGateway.quotaEnabled = true;
    checkConsumerQuota.mockResolvedValue({ allowed: true, reason: 'no_cap' });
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    const r = await chat(app);
    expect(r.statusCode).toBe(200);
    expect(checkConsumerQuota).toHaveBeenCalledWith('slai', 'llm');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('checkConsumerQuota бросил → ПРОПУСК (fail-open, не 500/429)', async () => {
    cfg.llmGateway.quotaEnabled = true;
    checkConsumerQuota.mockRejectedValue(new Error('db down'));
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    const r = await chat(app);
    expect(r.statusCode).toBe(200);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe('enforcement: caller=null (root-key)', () => {
  it('квота включена, но root-key (нет caller) → ПРОПУСК, проверка не зовётся', async () => {
    cfg.llmGateway.quotaEnabled = true;
    // root API_KEY вместо named key → req.user.caller отсутствует
    cfg.apiKey = 'root-secret';
    checkConsumerQuota.mockResolvedValue({ allowed: false, reason: 'quota_exceeded' });
    requestMock.mockResolvedValueOnce(upstream(200, completion('mistral-small3.1')));
    const app = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer root-secret' },
      payload,
    });
    expect(r.statusCode).toBe(200);
    expect(checkConsumerQuota).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    cfg.apiKey = '';
  });
});
