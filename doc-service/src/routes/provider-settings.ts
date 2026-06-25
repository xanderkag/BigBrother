import { request } from 'undici';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { providerSettingsRepo } from '../storage/provider-settings.js';
import { auditLogRepo } from '../storage/audit-log.js';
import { dynamicLlm } from '../pipeline/llm/provider-resolver.js';
import { ErrorResponse } from '../types/api-schemas.js';
import { bearerAuthHook } from '../auth.js';
import { requireSuperAdmin } from '../authz.js';
import { config } from '../config.js';

/**
 * Provider Settings — admin CRUD over external LLM/OCR provider configs.
 *
 * Use-case: admin opens "Provider keys" в UI, выбирает Anthropic из списка,
 * вставляет ключ, жмёт "Save" → ключ кладётся в provider_settings.api_key.
 * При следующем job-е HttpLlmClient смотрит сначала в DB (по `is_default=true`
 * для kind='llm'), потом в env как fallback. Это позволяет менять ключи в
 * горячем режиме без правки .env.
 *
 * Secrets: `api_key` НИКОГДА не возвращается в API. Ответ содержит только
 * `api_key_masked` (••••1234) и `has_api_key` (boolean). Запись ключа —
 * через POST/PATCH с обычным телом запроса (передаётся по HTTPS).
 *
 * Audit: каждый write пишется в `audit_log`. `api_key`-поле маскируется
 * в snapshot'ах: в БД лежит plaintext только в самой `provider_settings`
 * (а ещё там есть `before/after` без секрета).
 */

const Kind = z.enum(['llm', 'ocr', 'dadata', 'yandex_maps']);

const IdParam = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: 'id должен быть в lowercase: [a-z0-9_-]',
  }),
});

const ProviderApi = z.object({
  id: z.string(),
  kind: Kind,
  display_name: z.string(),
  description: z.string().nullable(),
  base_url: z.string().nullable(),
  api_key_masked: z.string().nullable(),
  has_api_key: z.boolean(),
  has_secret_key: z.boolean(),
  model: z.string().nullable(),
  is_active: z.boolean(),
  is_default: z.boolean(),
  extra: z.record(z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ListResponse = z.object({ items: z.array(ProviderApi) });

const UrlOrEmpty = z
  .string()
  .max(2000)
  .refine(
    (v) => v === '' || /^https?:\/\//.test(v),
    'base_url должен быть http(s):// URL или пустой строкой',
  )
  .nullable();

const CreateBody = z.object({
  id: IdParam.shape.id,
  kind: Kind,
  display_name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  base_url: UrlOrEmpty.optional(),
  api_key: z.string().max(4000).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  is_active: z.boolean().optional(),
  extra: z.record(z.unknown()).nullable().optional(),
});

const PatchBody = CreateBody.omit({ id: true, kind: true }).partial();

const TestResponse = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  latency_ms: z.number().optional(),
  message: z.string().optional(),
});

/** Snapshot we ship into audit_log — never includes the plaintext api_key. */
function maskSecretsForAudit(row: Awaited<ReturnType<typeof providerSettingsRepo.findById>>) {
  if (!row) return null;
  return providerSettingsRepo.toApi(row);
}

export async function providerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  r.get(
    '/provider-settings',
    {
      schema: {
        tags: ['provider-settings'],
        summary: 'Список настроенных провайдеров (LLM и OCR)',
        description:
          'Возвращает все записи provider_settings. Секретные ключи маскируются (••••1234) — реальные значения не уходят клиенту.',
        security: [{ bearerAuth: [] }],
        response: { 200: ListResponse, 401: ErrorResponse },
      },
    },
    async () => {
      const rows = await providerSettingsRepo.list();
      return { items: rows.map((r) => providerSettingsRepo.toApi(r)) };
    },
  );

  r.get(
    '/provider-settings/:id',
    {
      schema: {
        tags: ['provider-settings'],
        summary: 'Конфигурация одного провайдера',
        security: [{ bearerAuth: [] }],
        params: IdParam,
        response: { 200: ProviderApi, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const row = await providerSettingsRepo.findById(req.params.id);
      if (!row) {
        reply.code(404);
        return { error: 'provider not found' };
      }
      return providerSettingsRepo.toApi(row);
    },
  );

  r.post(
    '/provider-settings',
    {
      schema: {
        tags: ['provider-settings'],
        summary: 'Создать или заменить провайдера',
        description:
          'Upsert по id: если id уже есть — все поля перезаписываются. Поле api_key пишется напрямую; ' +
          'значение НЕ возвращается в ответе, только маска. Default-флаг через POST не устанавливается — см. POST /:id/set-default.',
        security: [{ bearerAuth: [] }],
        body: CreateBody,
        response: { 201: ProviderApi, 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const before = await providerSettingsRepo.findById(req.body.id);
      const body = {
        ...req.body,
        // Пустая строка в base_url трактуется как «очистить»
        base_url: req.body.base_url === '' ? null : req.body.base_url,
      };
      const row = await providerSettingsRepo.upsert(body);
      const after = providerSettingsRepo.toApi(row);
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'provider_setting',
        entity_id: row.id,
        action: before ? 'update' : 'create',
        before: before ? maskSecretsForAudit(before) : null,
        after,
      });
      // Сбрасываем кэш LLM-клиента — следующий job увидит новые base_url/key.
      if (row.kind === 'llm') dynamicLlm.invalidate();
      reply.code(201);
      return after;
    },
  );

  r.patch(
    '/provider-settings/:id',
    {
      schema: {
        tags: ['provider-settings'],
        summary: 'Частичное обновление провайдера',
        description:
          'Только переданные поля пишутся. Чтобы стереть api_key — передайте `api_key: null`.',
        security: [{ bearerAuth: [] }],
        params: IdParam,
        body: PatchBody,
        response: { 200: ProviderApi, 400: ErrorResponse, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const before = await providerSettingsRepo.findById(req.params.id);
      if (!before) {
        reply.code(404);
        return { error: 'provider not found' };
      }
      const patch = {
        ...req.body,
        base_url: req.body.base_url === '' ? null : req.body.base_url,
      };
      const updated = await providerSettingsRepo.patch(req.params.id, patch);
      if (!updated) {
        reply.code(404);
        return { error: 'provider not found' };
      }
      const beforeApi = maskSecretsForAudit(before);
      const afterApi = providerSettingsRepo.toApi(updated);
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'provider_setting',
        entity_id: updated.id,
        action: 'update',
        before: beforeApi,
        after: afterApi,
      });
      if (updated.kind === 'llm') dynamicLlm.invalidate();
      return afterApi;
    },
  );

  r.delete(
    '/provider-settings/:id',
    {
      schema: {
        tags: ['provider-settings'],
        summary: 'Удалить провайдера',
        security: [{ bearerAuth: [] }],
        params: IdParam,
        response: { 204: z.null(), 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
      const before = await providerSettingsRepo.findById(req.params.id);
      if (!before) {
        reply.code(404);
        return { error: 'provider not found' };
      }
      const deleted = await providerSettingsRepo.delete(req.params.id);
      if (deleted) {
        await auditLogRepo.append({
          actor: 'admin',
          entity: 'provider_setting',
          entity_id: before.id,
          action: 'delete',
          before: maskSecretsForAudit(before),
        });
        if (before.kind === 'llm') dynamicLlm.invalidate();
      }
      reply.code(204);
      return null;
    },
  );

  r.post(
    '/provider-settings/:id/set-default',
    {
      schema: {
        tags: ['provider-settings'],
        summary: 'Сделать провайдера активным по умолчанию',
        description:
          'Атомарно: снимает default-флаг со всех других провайдеров того же kind, ставит этому. ' +
          'Заодно is_active=true. Партиальный UNIQUE-индекс гарантирует ровно один default per kind.',
        security: [{ bearerAuth: [] }],
        params: IdParam,
        response: { 200: ProviderApi, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const before = await providerSettingsRepo.findById(req.params.id);
      if (!before) {
        reply.code(404);
        return { error: 'provider not found' };
      }
      const row = await providerSettingsRepo.setDefault(req.params.id);
      if (!row) {
        reply.code(404);
        return { error: 'provider not found' };
      }
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'provider_setting',
        entity_id: row.id,
        action: 'update',
        before: maskSecretsForAudit(before),
        after: providerSettingsRepo.toApi(row),
      });
      if (row.kind === 'llm') dynamicLlm.invalidate();
      return providerSettingsRepo.toApi(row);
    },
  );

  r.post(
    '/provider-settings/:id/test',
    {
      schema: {
        tags: ['provider-settings'],
        summary: 'Проверить связь с провайдером',
        description:
          'Для kind=llm — GET `<base_url>/models` (стандартный OpenAI Chat Completions endpoint; ' +
          'поддерживается Ollama, vLLM, llama.cpp, LM Studio, OpenAI). Для kind=ocr — GET `<base_url>/`. ' +
          'Возвращает ok+latency или ok=false+message. Полезно после установки base_url/key.',
        security: [{ bearerAuth: [] }],
        params: IdParam,
        response: { 200: TestResponse, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const row = await providerSettingsRepo.findById(req.params.id);
      if (!row) {
        reply.code(404);
        return { error: 'provider not found' };
      }
      // Если у провайдера нет base_url — пробуем дефолтный inference-service.
      const target =
        row.base_url ||
        (row.kind === 'llm' ? config.llm.url : null) ||
        null;
      if (!target) {
        return {
          ok: false as const,
          message: 'не задан base_url и нет LLM_INFERENCE_URL для fallback',
        };
      }
      // Для llm-провайдеров пингуем стандартный OpenAI endpoint `/models`
      // (поддерживают все: Ollama, vLLM, llama.cpp, LM Studio, OpenAI).
      // Это даёт честный сигнал «сервер живой И знает наш API». Для ocr —
      // пингуем корень.
      const probePath = row.kind === 'llm' ? '/models' : '/';
      // Если base_url не оканчивается на /v1 — обычно сам сервер хочет именно
      // /v1/models. Прокладка чуть-чуть умнее URL'a: если в base_url нет
      // суффикса с версией — добавляем.
      const normalizedBase = /\/v\d+\/?$/.test(target) ? target : `${target.replace(/\/$/, '')}/v1`;
      const url = new URL(probePath.replace(/^\//, ''), normalizedBase.replace(/\/?$/, '/')).toString();
      const startedAt = Date.now();
      try {
        const res = await request(url, {
          method: 'GET',
          headers: row.api_key ? { authorization: `Bearer ${row.api_key}` } : {},
          headersTimeout: 5000,
          bodyTimeout: 5000,
        });
        // drain body to release the socket
        await res.body.dump();
        const latency = Date.now() - startedAt;
        return {
          ok: res.statusCode < 500,
          status: res.statusCode,
          latency_ms: latency,
          message:
            res.statusCode >= 500
              ? `upstream returned ${res.statusCode}`
              : undefined,
        };
      } catch (err) {
        return {
          ok: false as const,
          latency_ms: Date.now() - startedAt,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
