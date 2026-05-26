import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { config, assertAuthConfigured } from './config.js';
import { documentTypesRoutes } from './routes/document-types.js';
import { jobsRoutes } from './routes/jobs.js';
import { slaiSyncRoutes } from './routes/integrations/slai-sync.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { operationalMetricsRoutes } from './routes/operational-metrics.js';
import { settingsRoutes } from './routes/settings.js';
import { providerSettingsRoutes } from './routes/provider-settings.js';
import { auditLogRoutes } from './routes/audit-log.js';
import { tenantRoutes } from './routes/tenants.js';
import { referenceListsRoutes } from './routes/reference-lists.js';
import { resolutionRoutes } from './routes/resolution.js';
import { closeDb } from './db.js';
import { closeQueue } from './queue.js';

async function main() {
  // P0 security: fail-closed до того как мы начнём слушать порт. Бросает,
  // если auth выключился бы по умолчанию (нет ключей, нет ALLOW_NO_AUTH).
  assertAuthConfigured(config);

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxUploadMb * 1024 * 1024,
    // Honour incoming X-Request-Id from upstream (nginx, client tooling) so a
    // single id traces a request through external proxies → our HTTP layer →
    // BullMQ payload → worker logs. If missing, generate a UUID locally.
    // Fastify exposes the chosen id on req.id and on every child logger
    // automatically as `reqId` (renamed to request_id below).
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 64) {
        return incoming;
      }
      return randomUUID();
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'request_id',
  }).withTypeProvider<ZodTypeProvider>();

  // Echo the resolved request id back to the client so they can correlate
  // their logs with ours. Cheap to do unconditionally.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Make Fastify validate/serialize using zod schemas instead of ajv. Only
  // affects routes that declare zod schemas; routes with raw JSON Schema
  // (e.g., the multipart POST /jobs) keep ajv defaults.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // I5: Rate-limiting. Keyed by API key (header) when present, falls back to
  // source IP. /health and /ready are excluded — they're polled by nginx/k8s
  // and must not be rate-limited. Set RATE_LIMIT_PER_MINUTE=0 to disable.
  // I5: Rate-limiting. Keyed by API key (header) when present, falls back to
  // source IP. /health and /ready are excluded — they're polled by nginx/k8s
  // and must not be rate-limited. Set RATE_LIMIT_PER_MINUTE=0 to disable.
  if (config.rateLimitPerMinute > 0) {
    await app.register(rateLimit, {
      max: config.rateLimitPerMinute,
      timeWindow: '1 minute',
      keyGenerator: (req) => {
        // Use the bearer token as the rate-limit key so different callers
        // with the same IP (VPN, NAT) don't share a bucket.
        const auth = req.headers['authorization'];
        const token = Array.isArray(auth) ? auth[0] : auth;
        if (token?.startsWith('Bearer ')) return token.slice(7);
        return req.ip;
      },
      allowList: (req) => req.url === '/health' || req.url === '/ready',
      skipOnError: true,
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Max ${context.max} requests per minute. Retry after ${context.after}.`,
      }),
    });
  }

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadMb * 1024 * 1024,
      files: 1,
    },
  });

  // OpenAPI spec at /docs/json, Swagger UI at /docs.
  // Auth scheme is declared globally; routes under /api/v1/* require it
  // (enforced by the bearerAuthHook), routes under /health and /ready don't.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'parsedocs',
        description:
          'Платформа обработки документов: OCR + извлечение структурированных данных по конфигурируемым типам. Multi-tenant, с локальными и облачными LLM-провайдерами.',
        version: '0.1.0',
      },
      servers: [{ url: `http://localhost:${config.port}`, description: 'local' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'API_KEY из конфигурации сервиса',
          },
        },
      },
      tags: [
        { name: 'jobs', description: 'Создание и отслеживание задач обработки' },
        { name: 'document-types', description: 'Реестр типов документов (CRUD + конфиг парсинга/валидации)' },
        { name: 'provider-settings', description: 'Ключи и URL-ы LLM/OCR провайдеров (Anthropic, OpenAI, Yandex, локальные)' },
        { name: 'audit-log', description: 'История админ-изменений document_types и provider_settings' },
        { name: 'tenants', description: 'Multi-tenant: organizations / projects / users / access' },
        { name: 'settings', description: 'Снимок настроек и статус LLM-провайдеров' },
        { name: 'reference-lists', description: 'Справочники для привязки документов (cargo units, nomenclature, …)' },
        { name: 'resolution', description: 'Результаты привязки документа к бизнес-сущностям: confirm / reject / re-resolve' },
        { name: 'health', description: 'Liveness/readiness пробники' },
      ],
    },
    transform: jsonSchemaTransform,
    // POST /api/v1/jobs is multipart — zod can't model the streamed body,
    // so the route declares no `body` schema and we inject the multipart
    // request shape into the OpenAPI document here. This keeps the
    // Swagger UI file-upload form working without breaking the zod
    // validator at request time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transformObject: ((doc: any) => {
      if (!doc.openapiObject) return doc.swaggerObject;
      const openapi = doc.openapiObject as { paths?: Record<string, Record<string, Record<string, unknown>>> };
      const post = openapi.paths?.['/api/v1/jobs']?.post;
      if (post) {
        // EXT-B (Q11): per-request BYO LLM credentials. Документируем заголовки
        // только в OpenAPI (route читает их из req.headers — не через zod).
        // Принимаются только если BYO_LLM_ENABLED=true; иначе 400 BYO_LLM_DISABLED.
        const existingParams = Array.isArray((post as Record<string, unknown>).parameters)
          ? ((post as Record<string, unknown>).parameters as unknown[])
          : [];
        (post as Record<string, unknown>).parameters = [
          ...existingParams,
          {
            name: 'X-LLM-Provider',
            in: 'header',
            required: false,
            description:
              'BYO LLM: провайдер для этого job (claude | openai_compatible | qwen_vl | ...). ' +
              'Действует только при BYO_LLM_ENABLED=true. Ключ НЕ попадает в логи/БД/webhook.',
            schema: { type: 'string' },
          },
          {
            name: 'X-LLM-Api-Key',
            in: 'header',
            required: false,
            description:
              'BYO LLM: api-ключ consumer\'а. Шифруется до постановки в очередь, ' +
              'никогда не сериализуется в plaintext. Обязателен вместе с X-LLM-Provider.',
            schema: { type: 'string' },
          },
          {
            name: 'X-LLM-Model',
            in: 'header',
            required: false,
            description: 'BYO LLM: модель (опционально), напр. claude-3-7-sonnet / gpt-4o.',
            schema: { type: 'string' },
          },
          {
            name: 'X-LLM-Base-Url',
            in: 'header',
            required: false,
            description:
              'BYO LLM: base URL inference-endpoint\'а (опционально). ' +
              'Если не задан — используется дефолтный LLM_INFERENCE_URL сервиса.',
            schema: { type: 'string' },
          },
        ];
      }
      if (post && !post.requestBody) {
        post.requestBody = {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                description: 'Передайте либо file (binary), либо file_url (ссылку).',
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Сам документ (PDF, JPG, PNG, BMP, TIFF). Обязателен, если не задан file_url.',
                  },
                  file_url: {
                    type: 'string',
                    format: 'uri',
                    description:
                      'EXT-D (Q12): ссылка на документ — сервер скачивает его сам (альтернатива file-part, снимает 50MB multipart-лимит). ' +
                      'Требует FILE_URL_INGEST_ENABLED. Только http(s); приватные/internal адреса блокируются (SSRF-защита).',
                  },
                  file_sha256: {
                    type: 'string',
                    description:
                      'Ожидаемый SHA-256 (hex) файла, скачанного по file_url. Проверяется после загрузки; mismatch → 400 FILE_URL_SHA_MISMATCH.',
                  },
                  webhook_url: {
                    type: 'string',
                    format: 'uri',
                    description:
                      'URL для POST результата после обработки. Тело подписывается HMAC-SHA256 в заголовке X-DocService-Signature.',
                  },
                  document_hint: {
                    type: 'string',
                    pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
                    description:
                      'Подсказка типа документа. Если задана — пропускается шаг классификации. ' +
                      'Принимается любой slug из Document Type Registry (builtin или пользовательский).',
                  },
                  metadata: {
                    type: 'string',
                    description:
                      'JSON-строка, echo обратно в ответе и webhook. Должен парситься JSON.parse.',
                  },
                  project_id: {
                    type: 'string',
                    format: 'uuid',
                    description:
                      'Проект, к которому относится этот job. Если не задан — используется default-проект пользователя (для super_admin = System / Default).',
                  },
                  organization_id: {
                    type: 'string',
                    format: 'uuid',
                    description:
                      'Организация. Обычно резолвится из project_id; задавайте явно только если хотите переопределить.',
                  },
                },
              },
            },
          },
        };
      }
      return doc.openapiObject;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
      // Сортировка для предсказуемого визуального порядка.
      tagsSorter: 'alpha',
      operationsSorter: 'method',
      // Прячем секцию «Schemas» внизу страницы — нашему пользователю
      // нужны endpoint'ы, не сырые JSON Schema.
      defaultModelsExpandDepth: -1,
      // Отключаем встроенный validator badge с Swagger.io — внешний
      // запрос наружу не нужен и пугает security-аудиторов.
      validatorUrl: null,
    },
    // Прячем верхний бар (логотип Fastify + URL-input + «Explore») —
    // ничего полезного в нём нет, только захламляет.
    theme: {
      css: [
        {
          filename: 'no-topbar.css',
          content: '.swagger-ui .topbar { display: none; }',
        },
      ],
    },
    staticCSP: true,
  });

  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(jobsRoutes, { prefix: '/api/v1' });
  await app.register(settingsRoutes, { prefix: '/api/v1' });
  await app.register(documentTypesRoutes, { prefix: '/api/v1' });
  await app.register(providerSettingsRoutes, { prefix: '/api/v1' });
  await app.register(auditLogRoutes, { prefix: '/api/v1' });
  await app.register(tenantRoutes, { prefix: '/api/v1' });
  await app.register(operationalMetricsRoutes, { prefix: '/api/v1' });
  await app.register(referenceListsRoutes, { prefix: '/api/v1' });
  await app.register(resolutionRoutes, { prefix: '/api/v1' });

  // F13: SLAI category sync receiver. Не использует Bearer auth — защищается
  // своим HMAC (X-SLAI-Signature). Поэтому регистрируется БЕЗ префикса
  // (полные paths внутри route файла).
  await app.register(slaiSyncRoutes);

  // --- Operator UI mount strategy ---
  //
  // Единственный UI — React-приложение из `ui/dist/`, маунтится на `/ui/*`.
  // Старый vanilla-JS UI (`web/`) удалён 2026-05-24 (снят с раздачи 2026-05-21).
  // Старые пути /ui-legacy/* по-прежнему редиректят на /ui/ (см. ниже), чтобы
  // букмарки не падали в 404.
  //
  // Резолвим папку относительно расположения server.ts (работает и в
  // dist/ после tsc, и в src/ через tsx dev mode).
  const here = dirname(fileURLToPath(import.meta.url));
  const uiDir = join(here, '..', 'ui', 'dist');

  // --- React UI at /ui/* (единственный) ---
  // Если ui/dist/ нет (dev mode без сборки) — silent skip; разработчик
  // использует `npm run dev` в ui/ на :5173 с proxy на API.
  try {
    const { statSync, readFileSync } = await import('node:fs');
    statSync(uiDir); // throws ENOENT если папки нет
    await app.register(staticFiles, {
      root: uiDir,
      prefix: '/ui/',
      decorateReply: false,
      wildcard: false,
    });
    // SPA fallback — React Router использует HTML5 history. Любой
    // GET /ui/* path, под который нет файла на диске, отдаёт index.html
    // и роутинг разруливает уже React Router в браузере.
    //
    // Читаем index.html один раз на старте — он маленький (~1KB) и не
    // меняется между релизами, кэш в памяти безопасен. decorateReply:
    // false на static-registration значит sendFile() недоступен, поэтому
    // отдаём buffer вручную через reply.type().send().
    const indexHtml = readFileSync(join(uiDir, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/ui/') && req.method === 'GET') {
        reply.type('text/html').send(indexHtml);
        return;
      }
      reply.code(404).send({ error: 'not found' });
    });
    app.log.info({ uiDir }, 'UI (React) mounted at /ui/');
  } catch {
    app.log.warn(
      'UI build not found (ui/dist/) — UI недоступен. Run `cd ui && npm run build`.',
    );
  }

  // Bare GET / → главный UI.
  app.get('/', async (_req, reply) => {
    reply.redirect('/ui/', 302);
  });

  // Bare GET /ui (без trailing-slash) → /ui/.
  // Fastify static prefix='/ui/' матчит только с / на конце, без redirect'а
  // юзер получает 404 от not-found-handler'а. Раньше люди жаловались на
  // «{error:not found}» при копи-пасте `/ui` без слеша.
  app.get('/ui', async (_req, reply) => {
    reply.redirect('/ui/', 301);
  });

  // --- Legacy UI отключён (2026-05-21): /ui-legacy/* → /ui/ ---
  // Старый vanilla-JS UI снят с раздачи. Редиректим, чтобы старые букмарки
  // и кнопки «Legacy →» не падали в 404, а вели на новый фронт.
  app.get('/ui-legacy', async (_req, reply) => reply.redirect('/ui/', 301));
  app.get('/ui-legacy/*', async (_req, reply) => reply.redirect('/ui/', 301));

  // --- Legacy redirect: /v2/* → /ui/* ---
  // На время фазы миграции, когда команда ещё могла поделиться ссылками
  // вида /v2/jobs/<id>. Просто разворачиваем prefix и сохраняем суффикс.
  app.get('/v2', async (_req, reply) => reply.redirect('/ui/', 301));
  app.get('/v2/*', async (req, reply) => {
    const tail = req.url.slice('/v2/'.length);
    reply.redirect(`/ui/${tail}`, 301);
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closeQueue();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { docs: `http://${config.host}:${config.port}/docs` },
    'API documentation available',
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
