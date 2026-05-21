import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { access, constants } from 'node:fs/promises';
import { Redis as IORedis } from 'ioredis';
import { config } from '../config.js';
import { db } from '../db.js';
import { HealthResponse, ReadyResponse } from '../types/api-schemas.js';

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
