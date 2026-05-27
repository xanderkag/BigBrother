import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { access, constants } from 'node:fs/promises';
import { Redis as IORedis } from 'ioredis';
import { config } from '../config.js';
import { db } from '../db.js';
import { documentTypesRepo } from '../storage/document-types.js';
import { HealthResponse, ReadyResponse } from '../types/api-schemas.js';

// EXT-A (2026-05-26): contract version, который parsdocs обещает SLAI'у
// в `GET /capabilities`. Bump'аем при ломающих изменениях payload-структуры
// (webhook payload, /jobs response, и т.п.). Минорные дополнения полей не
// требуют bump'а — поведение consumer'ов от extras не ломается.
const EXTRACTOR_CONTRACT_VERSION = '1';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        description: 'Сервис принимает соединения. Не проверяет внешние зависимости.',
        response: { 200: HealthResponse },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  // EXT-A (2026-05-26): capability-discovery для consumer-микросервисов
  // (SLAI и любых будущих). Публичный (без auth) — как /health и /version:
  // их `ExtractorGateway` должен уметь дёрнуть до выставления токена.
  // Содержит:
  //   - adapter: 'parsdocs' — имя адаптера, под которым parsdocs регистрируется
  //   - contractVersion: '1' — webhook payload + /jobs response shape
  //   - supportedDocumentTypes: список активных slug'ов из БД (динамика —
  //     не хардкод; админ может включить/выключить тип через UI)
  //   - maxFileMB: текущий лимит multipart upload (config.maxUploadMb)
  //   - webhookSupported: true — push-доставка работает. Polling доступен
  //     всегда (GET /jobs/:id) — про него явный флаг не нужен по контракту.
  //   - service / semver / commitShort — для drift-детекта без отдельного
  //     запроса /version
  app.get('/capabilities', async () => {
    const types = await documentTypesRepo.listActive();
    return {
      adapter: 'parsdocs' as const,
      contractVersion: EXTRACTOR_CONTRACT_VERSION,
      service: 'parsdocs',
      semver: process.env.APP_VERSION || '0.1.0',
      commitShort: process.env.GIT_COMMIT_SHORT
        || (process.env.GIT_COMMIT || 'unknown').slice(0, 7),
      supportedDocumentTypes: types.map((t) => t.slug),
      maxFileMB: config.maxUploadMb,
      webhookSupported: true as const,
      // L1 (2026-05-27): enablement-флаги новых ingest-возможностей, чтобы SLAI
      // обнаруживал их через /capabilities, а не ловил 400 на проде. Additive —
      // contractVersion остаётся '1' (доп. поля не ломают consumer'ов).
      fileUrlIngest: config.fileUrlIngest.enabled,
      asr: config.asr.enabled,
      byoLlm: config.byoLlmEnabled,
      hybridRouting: config.hybridRouting.enabled,
    };
  });

  // EPIC-7 Phase 1: версия билда — публичная (без auth, как /health),
  // чтобы внешний health-check SLAI видел version-drift. Git-метаданные
  // приходят из env, проставленных при docker build (--build-arg) в GHA
  // deploy-parsdocs.yml. Без них — фолбэк "unknown".
  app.get('/version', async () => {
    const semver = process.env.APP_VERSION || '0.1.0';
    const commit = process.env.GIT_COMMIT || 'unknown';
    const commitShort = process.env.GIT_COMMIT_SHORT
      || (commit !== 'unknown' ? commit.slice(0, 7) : 'unknown');
    return {
      service: 'parsdocs',
      version: `${semver}+${commitShort}`,
      semver,
      commit,
      commitShort,
      branch: process.env.GIT_BRANCH || 'unknown',
      buildTime: process.env.BUILD_TIME || 'unknown',
    };
  });

  r.get(
    '/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness probe',
        description: [
          'Готовность принимать трафик. Проверяет три зависимости:',
          '- PostgreSQL (`SELECT 1`),',
          '- Redis (`PING`),',
          '- запись в `STORAGE_DIR` (`access(W_OK)`).',
          '',
          'Любой провал — 503, в `error` — список failed-зависимостей через `; `.',
          'Подходит для k8s `readinessProbe` и LB-чеков.',
        ].join('\n'),
        response: { 200: ReadyResponse, 503: ReadyResponse },
      },
    },
    async (_req, reply) => {
      const failures: string[] = [];

      try {
        await db.query('SELECT 1');
      } catch (err) {
        failures.push(`postgres: ${(err as Error).message}`);
      }

      try {
        await pingRedis();
      } catch (err) {
        failures.push(`redis: ${(err as Error).message}`);
      }

      try {
        await access(config.storageDir, constants.W_OK);
      } catch (err) {
        failures.push(`storage (${config.storageDir}): ${(err as Error).message}`);
      }

      if (failures.length > 0) {
        reply.code(503);
        return { status: 'not_ready' as const, error: failures.join('; ') };
      }
      return { status: 'ready' as const };
    },
  );
}

/**
 * Lightweight Redis ping: opens a short-lived connection rather than reusing
 * the BullMQ-bound one (which has retries disabled and would mask real outage).
 * `lazyConnect` defers the dial until `.connect()`, so a probe that fails fast
 * on a dead Redis doesn't pollute the global ioredis state.
 */
async function pingRedis(): Promise<void> {
  const client = new IORedis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
  });
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') throw new Error(`unexpected reply: ${pong}`);
  } finally {
    client.disconnect();
  }
}
