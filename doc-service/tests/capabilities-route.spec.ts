/**
 * EXT-A (2026-05-26) — GET /capabilities contract surface для SLAI
 * `ExtractorGateway`. Публичный (без auth), как /health и /version.
 *
 * Harness: minimal-route — регистрируем только healthRoutes на голом Fastify
 * с zod-компиляторами, без buildServer (rate-limit/multipart/swagger/DB-pool).
 *
 * NB: route в src/routes/health.ts тянет supportedDocumentTypes из
 * `documentTypesRepo.listActive()` (НЕ из documentTypeResolver, как сказано
 * в EXT-A брифе) — мокаем фактическую зависимость. db/ioredis замоканы,
 * чтобы /ready и pingRedis не дёргали живые сервисы при import графе.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const listActive = vi.fn();
vi.mock('../src/storage/document-types.js', () => ({
  documentTypesRepo: { listActive },
}));
vi.mock('../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('ioredis', () => ({ Redis: vi.fn() }));

let healthRoutes: typeof import('../src/routes/health.js').healthRoutes;

beforeAll(async () => {
  ({ healthRoutes } = await import('../src/routes/health.js'));
});

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(healthRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  listActive.mockReset();
  app = await makeApp();
});

describe('GET /capabilities — EXT-A contract', () => {
  it('возвращает документированную форму (без auth → 200)', async () => {
    listActive.mockResolvedValue([{ slug: 'invoice' }, { slug: 'upd' }]);
    const r = await app.inject({ method: 'GET', url: '/capabilities' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      adapter: 'parsdocs',
      contractVersion: '1',
      service: 'parsdocs',
      webhookSupported: true,
    });
    expect(typeof body.maxFileMB).toBe('number');
    expect(Array.isArray(body.supportedDocumentTypes)).toBe(true);
  });

  it('supportedDocumentTypes = slug-и активных типов из resolver', async () => {
    listActive.mockResolvedValue([
      { slug: 'invoice' },
      { slug: 'transport_invoice' },
      { slug: 'waybill' },
    ]);
    const r = await app.inject({ method: 'GET', url: '/capabilities' });
    expect(r.statusCode).toBe(200);
    expect(r.json().supportedDocumentTypes).toEqual([
      'invoice',
      'transport_invoice',
      'waybill',
    ]);
    expect(listActive).toHaveBeenCalledTimes(1);
  });

  it('maxFileMB = config.maxUploadMb', async () => {
    listActive.mockResolvedValue([]);
    const { config } = await import('../src/config.js');
    const r = await app.inject({ method: 'GET', url: '/capabilities' });
    expect(r.json().maxFileMB).toBe(config.maxUploadMb);
  });

  it('contractVersion === EXTRACTOR_CONTRACT_VERSION ("1")', async () => {
    listActive.mockResolvedValue([]);
    const r = await app.inject({ method: 'GET', url: '/capabilities' });
    expect(r.json().contractVersion).toBe('1');
  });

  it('webhookSupported всегда true', async () => {
    listActive.mockResolvedValue([{ slug: 'invoice' }]);
    const r = await app.inject({ method: 'GET', url: '/capabilities' });
    expect(r.json().webhookSupported).toBe(true);
  });

  it('пустой активный набор → supportedDocumentTypes []', async () => {
    listActive.mockResolvedValue([]);
    const r = await app.inject({ method: 'GET', url: '/capabilities' });
    expect(r.statusCode).toBe(200);
    expect(r.json().supportedDocumentTypes).toEqual([]);
  });
});
