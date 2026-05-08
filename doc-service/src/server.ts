import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { config } from './config.js';
import { jobsRoutes } from './routes/jobs.js';
import { healthRoutes } from './routes/health.js';
import { closeDb } from './db.js';
import { closeQueue } from './queue.js';
import { DOCUMENT_TYPES } from './types/documents.js';

async function main() {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxUploadMb * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  // Make Fastify validate/serialize using zod schemas instead of ajv. Only
  // affects routes that declare zod schemas; routes with raw JSON Schema
  // (e.g., the multipart POST /jobs) keep ajv defaults.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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
        title: 'doc-service',
        description:
          'Универсальный сервис обработки транспортных и бухгалтерских документов: OCR + извлечение структурированных данных.',
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
        { name: 'health', description: 'Liveness/readiness пробники' },
      ],
    },
    transform: jsonSchemaTransform,
    // POST /api/v1/jobs is multipart — zod can't model the streamed body,
    // so the route declares no `body` schema and we inject the multipart
    // request shape into the OpenAPI document here. This keeps the
    // Swagger UI file-upload form working without breaking the zod
    // validator at request time.
    transformObject: ({ openapiObject }) => {
      const post = (openapiObject as { paths?: Record<string, Record<string, Record<string, unknown>>> })
        .paths?.['/api/v1/jobs']?.post;
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
                    enum: [...DOCUMENT_TYPES],
                    description:
                      'Подсказка типа документа. Если задана — пропускается шаг классификации.',
                  },
                  metadata: {
                    type: 'string',
                    description:
                      'JSON-строка, echo обратно в ответе и webhook. Должен парситься JSON.parse.',
                  },
                },
              },
            },
          },
        };
      }
      return openapiObject;
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
  });

  await app.register(healthRoutes);
  await app.register(jobsRoutes, { prefix: '/api/v1' });

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
