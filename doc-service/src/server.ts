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
import { config } from './config.js';
import { documentTypesRoutes } from './routes/document-types.js';
import { jobsRoutes } from './routes/jobs.js';
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
        title: 'parsdocs',
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
      if (post && !post.requestBody) {
        post.requestBody = {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Сам документ (PDF, JPG, PNG, BMP, TIFF)',
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

  // --- Operator UI: static files at /ui, redirect / → /ui/ ---
  //
  // Lives outside src/ — kept as plain HTML + CDN-loaded Tailwind/Alpine so
  // there's no frontend build step. Source: ../web (relative to compiled
  // dist/, or src/ in dev via tsx). Resolved from this file's location to
  // work in both modes.
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, '..', 'web');
  await app.register(staticFiles, {
    root: webDir,
    prefix: '/ui/',
    decorateReply: false,
  });
  // Bare GET / → UI. Nothing else should live at the root.
  app.get('/', async (_req, reply) => {
    reply.redirect('/ui/', 302);
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
