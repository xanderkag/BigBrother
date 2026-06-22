import type { FastifyError, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../config.js';
import { bearerAuthHook } from '../auth.js';
import {
  GatewayChatClient,
  extractUsage,
  openAiError,
  type GatewayUpstreamResult,
} from '../pipeline/llm/chat-client.js';
import { AnthropicChatClient } from '../pipeline/llm/anthropic-client.js';
import { OpenAiEmbeddingsClient } from '../pipeline/llm/openai-embeddings-client.js';
import { llmGatewayUsageRepo, type GatewayUsageStatus } from '../storage/llm-usage.js';

/**
 * EXT-LLM-GATEWAY (local): doc-service как локальный OpenAI-совместимый
 * LLM-шлюз для внешних клиентов (клиент №1 — SLAI AI-чат).
 *
 * Роуты намеренно регистрируются БЕЗ префикса (top-level /v1/*), потому что
 * OpenAI-SDK клиента бьёт в `<base>/v1/chat/completions`. Это НЕ /api/v1/*.
 *
 * Что делает роут: аутентифицирует named-ключом (bearerAuthHook), резолвит
 * запрошенный алиас в backend ollama-tag по серверной карте, passthrough'ит
 * запрос ПРЯМО в GPU Ollama (минуя inference-service), эхо-полем `model`
 * возвращает опубликованный алиас, снимает лёгкий usage. Облако запрещено.
 *
 * См. docs/EXT_LLM_GATEWAY_LOCAL_IMPL_TZ_2026-06-08.md.
 */

// Лёгкая валидация: это passthrough-шлюз, глубоко тело не разбираем — Ollama
// сам провалидирует. Требуем лишь непустой messages[] с ролью у каждого
// сообщения; всё прочее (content как строка/массив, name, tool_calls,
// temperature, max_tokens, ...) пробрасываем через .passthrough().
const ChatMessage = z.object({ role: z.string() }).passthrough();

const ChatCompletionRequest = z
  .object({
    model: z.string().optional(),
    messages: z.array(ChatMessage).min(1),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    // stream принимаем, но в MVP всегда отвечаем единым JSON (мягче для
    // клиента, чем 400). Флаг снимается перед отправкой в Ollama.
    stream: z.boolean().optional(),
  })
  .passthrough();

export async function llmGatewayRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Bearer auth на все /v1/* шлюза (как и остальной сервис).
  r.addHook('onRequest', bearerAuthHook);

  // OpenAI-shaped error для всего scope (валидация тела, неожиданные throw'ы),
  // чтобы OpenAI-клиент SLAI всегда получал {error:{message,type,code}}.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply
      .code(status)
      .send(
        openAiError(
          err.message,
          status === 400 ? 'invalid_request_error' : 'server_error',
          err.code || (status === 400 ? 'invalid_request' : 'internal_error'),
        ),
      );
  });

  // EXT-LLM-GATEWAY-ANTHROPIC: выбираем backend по config.llmGateway.backend.
  //   - openai_compat → старый GatewayChatClient (Ollama/vLLM passthrough)
  //   - anthropic → AnthropicChatClient с translator OpenAI↔Anthropic
  // Клиент статичен (конфиг фиксируется на boot'е) — собираем один раз.
  let client: { chatCompletions(body: unknown): Promise<GatewayUpstreamResult> } | null = null;
  if (config.llmGateway.backend === 'anthropic') {
    const apiKey = config.llmGateway.apiKey;
    const baseUrl = config.llmGateway.baseUrl || 'https://api.anthropic.com';
    if (apiKey) {
      client = new AnthropicChatClient({ baseUrl, apiKey, timeoutMs: config.llmGateway.timeoutMs });
    }
  } else {
    const baseUrl = config.llmGateway.baseUrl || config.llm.url || null;
    if (baseUrl) {
      client = new GatewayChatClient({ baseUrl, timeoutMs: config.llmGateway.timeoutMs });
    }
  }

  const models = config.llmGateway.models;
  const defaultAlias = config.llmGateway.defaultAlias;

  /**
   * Резолв алиас→backend-tag. Запрошенный алиас используется только если он
   * есть в опубликованной карте; пусто/неизвестно → дефолтный алиас. Сырые
   * ollama-теги клиент задать НЕ может (выбор моделей — серверный).
   */
  function resolveModel(requested?: string): { alias: string; model: string } | null {
    if (requested && Object.prototype.hasOwnProperty.call(models, requested)) {
      return { alias: requested, model: models[requested]! };
    }
    const fallback = models[defaultAlias];
    if (fallback) return { alias: defaultAlias, model: fallback };
    return null; // карта пуста / дефолт не настроен — misconfig
  }

  // EXT-LLM-GATEWAY-EMBEDDINGS: отдельный клиент под /v1/embeddings.
  // Не зависит от chat backend — Anthropic не делает embeddings, поэтому
  // даже на Asha (chat=anthropic) embeddings идут через OpenAI.
  const embCfg = config.llmGateway.embeddings;
  const embModels = embCfg.models;
  const embDefaultAlias = embCfg.defaultAlias;
  const embClient =
    embCfg.enabled && embCfg.apiKey
      ? new OpenAiEmbeddingsClient({
          baseUrl: embCfg.baseUrl,
          apiKey: embCfg.apiKey,
          timeoutMs: embCfg.timeoutMs,
        })
      : null;
  function resolveEmbeddingsModel(requested?: string): { alias: string; model: string } | null {
    if (requested && Object.prototype.hasOwnProperty.call(embModels, requested)) {
      return { alias: requested, model: embModels[requested]! };
    }
    const fallback = embModels[embDefaultAlias];
    if (fallback) return { alias: embDefaultAlias, model: fallback };
    return null;
  }

  // GET /v1/models — публикуем НАШИ алиасы (не сырые ollama-теги).
  r.get(
    '/v1/models',
    { schema: { tags: ['llm-gateway'], summary: 'List published model aliases' } },
    async () => {
      const chatIds = Object.keys(models);
      const chatList = chatIds.length > 0 ? chatIds : [defaultAlias];
      const data: Array<{ id: string; object: 'model'; owned_by: 'parsdocs' }> = chatList.map(
        (id) => ({ id, object: 'model', owned_by: 'parsdocs' }),
      );
      // EXT-LLM-GATEWAY-EMBEDDINGS: добавляем embeddings-алиасы если включены.
      if (embClient) {
        for (const id of Object.keys(embModels)) {
          data.push({ id, object: 'model', owned_by: 'parsdocs' });
        }
      }
      return { object: 'list', data };
    },
  );

  // POST /v1/chat/completions — OpenAI-compat, non-stream passthrough.
  r.post(
    '/v1/chat/completions',
    {
      schema: {
        tags: ['llm-gateway'],
        summary: 'OpenAI-compatible chat completion (non-stream)',
        body: ChatCompletionRequest,
      },
    },
    async (req, reply) => {
      if (!client) {
        return reply
          .code(503)
          .send(
            openAiError(
              'LLM gateway backend is not configured (LLM_GATEWAY_BASE_URL).',
              'server_error',
              'gateway_unconfigured',
            ),
          );
      }

      const body = req.body;
      const resolved = resolveModel(body.model);
      if (!resolved) {
        return reply
          .code(500)
          .send(
            openAiError(
              'No model alias is configured on the gateway (LLM_GATEWAY_MODELS_JSON).',
              'server_error',
              'no_model_configured',
            ),
          );
      }

      const caller = req.user?.caller ?? null;
      // Тело в upstream: подменяем model на backend-tag и снимаем stream
      // (MVP — всегда единый JSON-ответ).
      const { stream: _stream, ...rest } = body;
      const upstreamBody = { ...rest, model: resolved.model };

      const startedAt = Date.now();
      const result = await client.chatCompletions(upstreamBody);
      const latencyMs = Date.now() - startedAt;

      // Лёгкий usage — fail-soft (никогда не валим ответ клиенту).
      const usage = extractUsage(result.body);
      const status: GatewayUsageStatus = result.ok
        ? 'success'
        : result.errorCode === 'timeout'
          ? 'timeout'
          : 'error';
      try {
        await llmGatewayUsageRepo.record({
          caller,
          alias: resolved.alias,
          model: resolved.model,
          promptTokens: usage.prompt_tokens ?? null,
          completionTokens: usage.completion_tokens ?? null,
          latencyMs,
          status,
          errorCode: result.errorCode ?? null,
        });
      } catch (err) {
        req.log.warn({ err }, 'llm-gateway: usage record failed (non-fatal)');
      }

      if (!result.ok) {
        return reply.code(result.status).send(result.body);
      }

      // Эхо-поле model → опубликованный алиас (не сырой ollama-tag).
      const out = result.body;
      if (out && typeof out === 'object') {
        (out as Record<string, unknown>).model = resolved.alias;
      }
      return reply.code(200).send(out);
    },
  );

  // EXT-LLM-GATEWAY-EMBEDDINGS (SLAI 2026-06-XX): POST /v1/embeddings.
  // Шлюз к OpenAI text-embedding-3-* для SLAI Help-RAG (pgvector-индекс
  // на 1536 dim, text-embedding-3-small). Anthropic embeddings не делает —
  // даже когда chat backend = anthropic, embeddings идут через OpenAI.
  // Provider/key/models задаются ОТДЕЛЬНЫМИ env (LLM_GATEWAY_EMBEDDINGS_*).
  const EmbeddingsRequest = z
    .object({
      model: z.string().optional(),
      input: z.union([z.string(), z.array(z.string())]),
      encoding_format: z.enum(['float', 'base64']).optional(),
      dimensions: z.number().optional(),
      user: z.string().optional(),
    })
    .passthrough();

  r.post(
    '/v1/embeddings',
    {
      schema: {
        tags: ['llm-gateway'],
        summary: 'OpenAI-compatible embeddings (forward to OpenAI)',
        body: EmbeddingsRequest,
      },
    },
    async (req, reply) => {
      if (!embClient) {
        return reply
          .code(503)
          .send(
            openAiError(
              'Embeddings gateway is not configured (set LLM_GATEWAY_EMBEDDINGS_ENABLED=true + OPENAI_API_KEY + LLM_GATEWAY_EMBEDDINGS_MODELS_JSON).',
              'server_error',
              'embeddings_unconfigured',
            ),
          );
      }

      const body = req.body;
      const resolved = resolveEmbeddingsModel(body.model);
      if (!resolved) {
        return reply
          .code(500)
          .send(
            openAiError(
              'No embeddings alias is configured (LLM_GATEWAY_EMBEDDINGS_MODELS_JSON).',
              'server_error',
              'no_model_configured',
            ),
          );
      }

      const caller = req.user?.caller ?? null;
      const upstreamBody = { ...body, model: resolved.model };

      const startedAt = Date.now();
      const result = await embClient.embeddings(upstreamBody);
      const latencyMs = Date.now() - startedAt;

      const usage = extractUsage(result.body);
      const status: GatewayUsageStatus = result.ok
        ? 'success'
        : result.errorCode === 'timeout'
          ? 'timeout'
          : 'error';
      try {
        await llmGatewayUsageRepo.record({
          caller,
          alias: resolved.alias,
          model: resolved.model,
          promptTokens: usage.prompt_tokens ?? null,
          completionTokens: null, // embeddings нет completion-токенов
          latencyMs,
          status,
          errorCode: result.errorCode ?? null,
        });
      } catch (err) {
        req.log.warn({ err }, 'llm-gateway: embeddings usage record failed (non-fatal)');
      }

      if (!result.ok) {
        return reply.code(result.status).send(result.body);
      }

      // Эхо model → алиас (не сырой openai-tag).
      const out = result.body;
      if (out && typeof out === 'object') {
        (out as Record<string, unknown>).model = resolved.alias;
      }
      return reply.code(200).send(out);
    },
  );
}
