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
import { DaDataClient } from '../pipeline/llm/dadata-client.js';
import { YandexMapsClient } from '../pipeline/llm/yandex-maps-client.js';
import { providerSettingsRepo } from '../storage/provider-settings.js';
import { llmGatewayUsageRepo, type GatewayUsageStatus } from '../storage/llm-usage.js';
import { checkConsumerQuota } from '../storage/gateway-connectors.js';

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
  //
  // EXT-LLM-GATEWAY-KEY-FROM-DB (2026-06-XX): если env-ключ пуст — ленива
  // ходим в provider_settings (kind='llm', is_default=true, is_active=true)
  // и берём оттуда. Так user вводит Anthropic-ключ один раз через UI
  // Providers, и он работает И для extraction (/jobs), И для gateway
  // (/v1/chat/completions). С 60-секундным кэшом чтобы не дёргать БД на
  // каждом hit'е.
  type ChatClientLike = {
    chatCompletions(body: unknown): Promise<GatewayUpstreamResult>;
  };
  const KEY_CACHE_MS = 60_000;
  let cachedClient: ChatClientLike | null = null;
  let cachedKey: string | null = null;
  let cachedAt = 0;

  async function getClient(): Promise<ChatClientLike | null> {
    const now = Date.now();
    if (cachedClient && now - cachedAt < KEY_CACHE_MS) return cachedClient;

    if (config.llmGateway.backend === 'anthropic') {
      const baseUrl = config.llmGateway.baseUrl || 'https://api.anthropic.com';
      let apiKey: string | undefined = config.llmGateway.apiKey;
      // env пуст → fallback на provider_settings(is_default=true LLM)
      if (!apiKey) {
        try {
          const provider = await providerSettingsRepo.findDefault('llm');
          if (provider?.api_key) apiKey = provider.api_key;
        } catch {
          /* fail-soft — БД недоступна → клиент null → 503 */
        }
      }
      if (!apiKey) {
        cachedClient = null;
        cachedKey = null;
        cachedAt = now;
        return null;
      }
      if (apiKey !== cachedKey) {
        cachedClient = new AnthropicChatClient({
          baseUrl,
          apiKey,
          timeoutMs: config.llmGateway.timeoutMs,
        });
        cachedKey = apiKey;
      }
      cachedAt = now;
      return cachedClient;
    }

    // openai_compat: baseUrl-only passthrough, ключ не нужен здесь
    const baseUrl = config.llmGateway.baseUrl || config.llm.url || null;
    if (baseUrl && (!cachedClient || cachedKey !== baseUrl)) {
      cachedClient = new GatewayChatClient({
        baseUrl,
        timeoutMs: config.llmGateway.timeoutMs,
      });
      cachedKey = baseUrl;
    }
    cachedAt = now;
    return cachedClient;
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
  // EXT-LLM-GATEWAY-KEY-FROM-DB: embeddings ключ тоже с fallback на UI.
  // Берём из provider_settings.findById('openai') если env OPENAI_API_KEY
  // пуст. Активация: embCfg.enabled=true + есть ключ (env ИЛИ UI).
  let cachedEmbClient: OpenAiEmbeddingsClient | null = null;
  let cachedEmbKey: string | null = null;
  let cachedEmbAt = 0;
  async function getEmbClient(): Promise<OpenAiEmbeddingsClient | null> {
    if (!embCfg.enabled) return null;
    const now = Date.now();
    if (cachedEmbClient && now - cachedEmbAt < KEY_CACHE_MS) return cachedEmbClient;
    let apiKey: string | undefined = embCfg.apiKey;
    if (!apiKey) {
      try {
        const provider = await providerSettingsRepo.findById('openai');
        if (provider?.api_key && provider.is_active) apiKey = provider.api_key;
      } catch {
        /* fail-soft */
      }
    }
    if (!apiKey) {
      cachedEmbClient = null;
      cachedEmbKey = null;
      cachedEmbAt = now;
      return null;
    }
    if (apiKey !== cachedEmbKey) {
      cachedEmbClient = new OpenAiEmbeddingsClient({
        baseUrl: embCfg.baseUrl,
        apiKey,
        timeoutMs: embCfg.timeoutMs,
      });
      cachedEmbKey = apiKey;
    }
    cachedEmbAt = now;
    return cachedEmbClient;
  }
  function resolveEmbeddingsModel(requested?: string): { alias: string; model: string } | null {
    if (requested && Object.prototype.hasOwnProperty.call(embModels, requested)) {
      return { alias: requested, model: embModels[requested]! };
    }
    const fallback = embModels[embDefaultAlias];
    if (fallback) return { alias: embDefaultAlias, model: fallback };
    return null;
  }

  // EXT-LLM-GATEWAY-DADATA: тонкий passthrough к suggestions.dadata.ru.
  // Geo-доступен с Asha — никаких outbound-прокси (в отличие от Anthropic/
  // OpenAI). Key fallback env > provider_settings(kind='dadata') — у нас
  // уже зарегистрирован в Providers как enrichment provider.
  const dadataCfg = config.llmGateway.dadata;
  let cachedDadataClient: DaDataClient | null = null;
  let cachedDadataKey: string | null = null;
  let cachedDadataAt = 0;
  async function getDadataClient(): Promise<DaDataClient | null> {
    if (!dadataCfg.enabled) return null;
    const now = Date.now();
    if (cachedDadataClient && now - cachedDadataAt < KEY_CACHE_MS) return cachedDadataClient;
    let apiKey: string | undefined = dadataCfg.apiKey;
    if (!apiKey) {
      try {
        const provider = await providerSettingsRepo.findDefault('dadata');
        if (provider?.api_key) apiKey = provider.api_key;
      } catch {
        /* fail-soft */
      }
    }
    if (!apiKey) {
      cachedDadataClient = null;
      cachedDadataKey = null;
      cachedDadataAt = now;
      return null;
    }
    if (apiKey !== cachedDadataKey) {
      cachedDadataClient = new DaDataClient({
        baseUrl: dadataCfg.baseUrl,
        apiKey,
        timeoutMs: dadataCfg.timeoutMs,
      });
      cachedDadataKey = apiKey;
    }
    cachedDadataAt = now;
    return cachedDadataClient;
  }

  // INTEGRATION_HUB yandex_maps (Ф1): тонкий passthrough к Яндекс.Картам
  // (геокодер + маршрут/расстояние). Geo-доступен из РФ без outbound-прокси,
  // как DaData. Key fallback env > provider_settings(kind='yandex_maps').
  // Спит за флагом yandexMaps.enabled (fail-closed) — без ключа 503.
  const yandexCfg = config.llmGateway.yandexMaps;
  let cachedYandexClient: YandexMapsClient | null = null;
  let cachedYandexKey: string | null = null;
  let cachedYandexAt = 0;
  async function getYandexMapsClient(): Promise<YandexMapsClient | null> {
    if (!yandexCfg.enabled) return null;
    const now = Date.now();
    if (cachedYandexClient && now - cachedYandexAt < KEY_CACHE_MS) return cachedYandexClient;
    let apiKey: string | undefined = yandexCfg.apiKey;
    if (!apiKey) {
      try {
        const provider = await providerSettingsRepo.findDefault('yandex_maps');
        if (provider?.api_key) apiKey = provider.api_key;
      } catch {
        /* fail-soft */
      }
    }
    if (!apiKey) {
      cachedYandexClient = null;
      cachedYandexKey = null;
      cachedYandexAt = now;
      return null;
    }
    if (apiKey !== cachedYandexKey) {
      cachedYandexClient = new YandexMapsClient({
        geocoderBaseUrl: yandexCfg.geocoderBaseUrl,
        routerBaseUrl: yandexCfg.routerBaseUrl,
        apiKey,
        timeoutMs: yandexCfg.timeoutMs,
      });
      cachedYandexKey = apiKey;
    }
    cachedYandexAt = now;
    return cachedYandexClient;
  }

  /**
   * INTEGRATION_HUB (Ф1): enforcement суточной квоты потребителя на коннектор.
   * Строго за флагом config.llmGateway.quotaEnabled (default false) + fail-open.
   *
   * Возвращает true если запрос НАДО ЗАБЛОКИРОВАТЬ (и уже отправлен 429 в
   * OpenAI-error форме); false — пропускаем дальше в upstream.
   *
   * Fail-open (НИКОГДА не валим живой шлюз из-за enforcement):
   *   - флаг quotaEnabled выключен                  → пропуск (проверку даже не зовём);
   *   - caller неизвестен (root-key, caller=null)   → пропуск (некого энфорсить);
   *   - нет cap/budget (checkConsumerQuota allowed)  → пропуск;
   *   - любая ошибка проверки (БД упала и т.п.)      → пропуск (catch → false).
   * Блокируем (429) ТОЛЬКО при явном !allowed от checkConsumerQuota
   * (quota_exceeded / connector_disabled / consumer_disabled).
   */
  async function enforceQuota(
    req: { user?: { caller?: string | null }; log?: { warn(o: unknown, m: string): void } },
    reply: { code(n: number): { send(body: unknown): unknown } },
    connector: string,
  ): Promise<boolean> {
    if (!config.llmGateway.quotaEnabled) return false;
    const caller = req.user?.caller ?? null;
    if (!caller) return false; // root-key / без caller — нечего/некого энфорсить
    try {
      const q = await checkConsumerQuota(caller, connector);
      if (q.allowed) return false;
      reply.code(429).send(
        openAiError(
          `Дневной лимит потребителя «${caller}» по коннектору «${connector}» исчерпан (${q.reason ?? 'quota_exceeded'}). Обратитесь к администратору хаба.`,
          'rate_limit_error',
          'quota_exceeded',
        ),
      );
      return true;
    } catch (err) {
      // fail-open: сбой проверки квоты не должен блокировать живой трафик.
      req.log?.warn({ err, connector, caller }, 'llm-gateway: quota check failed (fail-open)');
      return false;
    }
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
      // /v1/models — синхронный список; если embeddings включены конфигом,
      // публикуем алиасы независимо от валидности ключа (фактический ключ
      // резолвится lazy на /v1/embeddings hit'е).
      if (embCfg.enabled) {
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
      const client = await getClient();
      if (!client) {
        // Сообщение зависит от backend: для anthropic не хватает ключа, для
        // openai_compat — upstream baseUrl. Раньше текст всегда ссылался на
        // ANTHROPIC_API_KEY, что путало в openai_compat-режиме.
        const hint =
          config.llmGateway.backend === 'anthropic'
            ? 'Set ANTHROPIC_API_KEY in env OR add an Anthropic provider in UI Providers (is_default=true).'
            : 'Set LLM_GATEWAY_BASE_URL (or LLM_INFERENCE_URL) to an OpenAI-compatible upstream.';
        return reply
          .code(503)
          .send(
            openAiError(
              `LLM gateway backend is not configured. ${hint}`,
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

      // INTEGRATION_HUB (Ф1): квота потребителя на коннектор 'llm'. Flag-gated +
      // fail-open — при выключенном флаге не вызывается вовсе.
      if (await enforceQuota(req, reply, 'llm')) return reply;

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
      const embClient = await getEmbClient();
      if (!embClient) {
        return reply
          .code(503)
          .send(
            openAiError(
              'Embeddings gateway is not configured. Set LLM_GATEWAY_EMBEDDINGS_ENABLED=true + OPENAI_API_KEY in env OR add OpenAI provider (id="openai", is_active=true) in UI Providers.',
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

      // INTEGRATION_HUB (Ф1): embeddings метерятся на тот же коннектор 'llm'.
      if (await enforceQuota(req, reply, 'llm')) return reply;

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

  // EXT-LLM-GATEWAY-DADATA (SLAI 2026-06-XX): тонкий passthrough к
  // suggestions.dadata.ru. Body и response — DaData-native verbatim
  // (мы НЕ переводим в OpenAI shape — клиент уже парсит DaData-формат).
  // Поэтому валидация мягкая: только наличие query (для findById обязательно).
  const DaDataRequest = z
    .object({
      query: z.string().min(1),
      count: z.number().optional(),
      type: z.string().optional(),
      branch_type: z.string().optional(),
    })
    .passthrough();

  async function handleDadata(
    req: {
      body: unknown;
      user?: { caller?: string | null };
      log: { warn(o: unknown, m: string): void };
    },
    reply: { code(n: number): { send(body: unknown): unknown } },
    operation: 'findById' | 'suggest',
  ): Promise<unknown> {
    const client = await getDadataClient();
    if (!client) {
      return reply.code(503).send(
        openAiError(
          'DaData gateway is not configured. Set LLM_GATEWAY_DADATA_ENABLED=true + DADATA_API_KEY in env OR add DaData provider (kind=dadata, is_default=true) in UI Providers.',
          'server_error',
          'dadata_unconfigured',
        ),
      );
    }
    // INTEGRATION_HUB (Ф1): квота на коннектор 'dadata'. Flag-gated + fail-open.
    if (await enforceQuota(req, reply, 'dadata')) return reply;
    const body = req.body;
    const caller = req.user?.caller ?? null;
    const startedAt = Date.now();
    const result =
      operation === 'findById'
        ? await client.findByIdParty(body)
        : await client.suggestParty(body);
    const latencyMs = Date.now() - startedAt;
    const status: GatewayUsageStatus = result.ok
      ? 'success'
      : result.errorCode === 'timeout'
        ? 'timeout'
        : 'error';
    try {
      await llmGatewayUsageRepo.record({
        caller,
        alias: `dadata-${operation}`,
        model: 'dadata',
        promptTokens: null,
        completionTokens: null,
        latencyMs,
        status,
        errorCode: result.errorCode ?? null,
        connector: 'dadata',
        units: 1,
        unitKind: 'calls',
      });
    } catch (err) {
      (req as { log?: { warn(o: unknown, m: string): void } }).log?.warn(
        { err },
        'llm-gateway: dadata usage record failed (non-fatal)',
      );
    }
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply.code(200).send(result.body);
  }

  r.post(
    '/v1/dadata/findById/party',
    {
      schema: {
        tags: ['llm-gateway'],
        summary: 'DaData findById party (passthrough by ИНН/ОГРН)',
        body: DaDataRequest,
      },
    },
    async (req, reply) => handleDadata(req as never, reply as never, 'findById'),
  );

  r.post(
    '/v1/dadata/suggest/party',
    {
      schema: {
        tags: ['llm-gateway'],
        summary: 'DaData suggest party (typeahead, passthrough)',
        body: DaDataRequest,
      },
    },
    async (req, reply) => handleDadata(req as never, reply as never, 'suggest'),
  );

  // INTEGRATION_HUB yandex_maps (Ф1): тонкий passthrough к Яндекс.Картам.
  // Тело — native query-параметры Яндекса (мы прокидываем их в query как есть,
  // подставляя только apikey). Ответ — Яндекс-native verbatim. Auth Яндекса —
  // apikey в query (НЕ Bearer). Усечённая валидация: только обязательный
  // ключевой параметр на эндпоинт (geocode / origins+destinations).
  const GeocodeRequest = z
    .object({
      geocode: z.string().min(1),
    })
    .passthrough();

  const RouteRequest = z
    .object({
      origins: z.string().min(1),
      destinations: z.string().min(1),
    })
    .passthrough();

  /** Native-параметры тела → Record<string,string> для query (числа/строки). */
  function toQueryParams(body: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
        else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
      }
    }
    return out;
  }

  async function handleYandexMaps(
    req: { body: unknown; user?: { caller?: string | null }; log?: { warn(o: unknown, m: string): void } },
    reply: { code(n: number): { send(body: unknown): unknown } },
    operation: 'geocode' | 'route',
  ): Promise<unknown> {
    const client = await getYandexMapsClient();
    if (!client) {
      return reply.code(503).send(
        openAiError(
          'Yandex Maps gateway is not configured. Set LLM_GATEWAY_YANDEX_ENABLED=true + YANDEX_MAPS_API_KEY in env OR add a Yandex Maps provider (kind=yandex_maps, is_default=true) in UI Providers.',
          'server_error',
          'yandex_unconfigured',
        ),
      );
    }
    // INTEGRATION_HUB (Ф1): квота на коннектор 'yandex_maps'. Flag-gated + fail-open.
    if (await enforceQuota(req, reply, 'yandex_maps')) return reply;
    const params = toQueryParams(req.body);
    const caller = req.user?.caller ?? null;
    const startedAt = Date.now();
    const result =
      operation === 'geocode' ? await client.geocode(params) : await client.route(params);
    const latencyMs = Date.now() - startedAt;
    const status: GatewayUsageStatus = result.ok
      ? 'success'
      : result.errorCode === 'timeout'
        ? 'timeout'
        : 'error';
    try {
      await llmGatewayUsageRepo.record({
        caller,
        alias: `yandex_maps-${operation}`,
        model: 'yandex_maps',
        promptTokens: null,
        completionTokens: null,
        latencyMs,
        status,
        errorCode: result.errorCode ?? null,
        connector: 'yandex_maps',
        units: 1,
        unitKind: operation === 'geocode' ? 'geocodes' : 'routes',
      });
    } catch (err) {
      req.log?.warn({ err }, 'llm-gateway: yandex_maps usage record failed (non-fatal)');
    }
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply.code(200).send(result.body);
  }

  r.post(
    '/v1/maps/geocode',
    {
      schema: {
        tags: ['llm-gateway'],
        summary: 'Yandex geocoder (passthrough; apikey in query)',
        body: GeocodeRequest,
      },
    },
    async (req, reply) => handleYandexMaps(req as never, reply as never, 'geocode'),
  );

  r.post(
    '/v1/maps/route',
    {
      schema: {
        tags: ['llm-gateway'],
        summary: 'Yandex distance matrix / route (passthrough; apikey in query)',
        body: RouteRequest,
      },
    },
    async (req, reply) => handleYandexMaps(req as never, reply as never, 'route'),
  );
}
