import { request } from 'undici';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../config.js';
import { bearerAuthHook } from '../auth.js';
import { resolveYandexVisionCredentials } from '../pipeline/ocr/yandex-gate.js';
import { ErrorResponse } from '../types/api-schemas.js';

/**
 * Operational settings + provider status endpoints.
 *
 * `GET /api/v1/settings` — sanitized snapshot of the runtime configuration.
 * Returns shape, thresholds, sweeper intervals, whether external secrets
 * (LLM URL, Yandex key, webhook secret) are configured — but NEVER the
 * secret values themselves. Used by the operator UI to render the Settings
 * view without needing access to env on the host.
 *
 * `GET /api/v1/providers/status` — proxies the upstream inference-service
 * `/v1/providers/status`. The UI surfaces which LLM providers are
 * configured (Claude / OpenAI / Qwen / stub) and which is active. If
 * LLM_INFERENCE_URL is not set or the upstream is down, we degrade
 * gracefully to `{ active: null, available: {}, upstream: "unreachable" }`
 * so the UI shows "не подключён" instead of erroring.
 *
 * Both endpoints are Bearer-protected like the rest of /api/v1/*.
 */

const SettingsResponse = z.object({
  service: z.object({
    name: z.literal('doc-service'),
    version: z.string(),
    port: z.number(),
  }),
  auth: z.object({
    api_key_configured: z.boolean(),
  }),
  worker: z.object({
    concurrency: z.number(),
  }),
  storage: z.object({
    backend: z.literal('local'),
    dir: z.string(),
    retention_days: z.number(),
  }),
  thresholds: z.object({
    pdf_text: z.number(),
    tesseract: z.number(),
    vision_llm: z.number(),
    needs_review: z.number(),
    regex_fallback: z.number(),
  }),
  ocr_engines: z.object({
    tesseract_langs: z.string(),
    vision_llm: z.object({
      enabled: z.boolean(),
      url: z.string().nullable(),
    }),
    yandex_vision: z.object({
      enabled: z.boolean(),
      pii_warning: z.string(),
    }),
  }),
  webhook: z.object({
    hmac_secret_configured: z.boolean(),
    max_attempts: z.number(),
  }),
  sweepers: z.object({
    pending_interval_ms: z.number(),
    pending_grace_seconds: z.number(),
    file_cleanup_interval_ms: z.number(),
    file_retention_days: z.number(),
    audit_log_interval_ms: z.number(),
    audit_log_retention_days: z.number(),
  }),
  limits: z.object({
    max_upload_mb: z.number(),
    max_metadata_bytes: z.number(),
  }),
});

const ProviderStatusResponse = z.object({
  upstream: z.enum(['ok', 'not_configured', 'unreachable']),
  active: z.string().nullable(),
  available: z.record(z.object({
    configured: z.boolean(),
    model: z.string().nullable(),
    description: z.string(),
  })),
  error: z.string().optional(),
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  r.get(
    '/settings',
    {
      schema: {
        tags: ['settings'],
        summary: 'Снимок операционных настроек сервиса',
        description:
          'Возвращает текущую конфигурацию (пороги OCR, ретеншены, флаги движков) без секретов. ' +
          'API-ключи и HMAC-секреты репортятся только как boolean `configured`.',
        security: [{ bearerAuth: [] }],
        response: {
          200: SettingsResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req) => {
      // Резолвим реальный источник (провайдер в UI → env), а не только env:
      // иначе панель покажет «выключено», пока UI-ключ уже гонит изображения в
      // облако — враньё в egress-чувствительную сторону.
      const yandexCreds = await resolveYandexVisionCredentials(req.log);
      return {
      service: {
        name: 'doc-service' as const,
        version: '0.1.0',
        port: config.port,
      },
      auth: {
        api_key_configured: !!config.apiKey,
      },
      worker: {
        concurrency: config.workerConcurrency,
      },
      storage: {
        backend: 'local' as const,
        dir: config.storageDir,
        retention_days: config.sweepers.fileRetentionDays,
      },
      thresholds: {
        pdf_text: config.thresholds.pdfText,
        tesseract: config.thresholds.tesseract,
        vision_llm: config.thresholds.visionLlm,
        needs_review: config.thresholds.needsReview,
        regex_fallback: config.thresholds.regexFallback,
      },
      ocr_engines: {
        tesseract_langs: config.tesseractLangs,
        vision_llm: {
          enabled: !!config.llm.url,
          url: config.llm.url ?? null,
        },
        yandex_vision: {
          enabled: !!yandexCreds.apiKey && !!yandexCreds.folderId,
          pii_warning:
            'При активном движке изображения уходят в Yandex Cloud. Для документов с ПДн (паспорт водителя в ТТН и т.п.) — держите выключенным.',
        },
      },
      webhook: {
        hmac_secret_configured: !!config.webhook.hmacSecret && config.webhook.hmacSecret !== 'change-me',
        max_attempts: config.webhook.maxAttempts,
      },
      sweepers: {
        pending_interval_ms: config.sweepers.pendingIntervalMs,
        pending_grace_seconds: config.sweepers.pendingGraceSeconds,
        file_cleanup_interval_ms: config.sweepers.fileCleanupIntervalMs,
        file_retention_days: config.sweepers.fileRetentionDays,
        audit_log_interval_ms: config.sweepers.auditLogIntervalMs,
        audit_log_retention_days: config.sweepers.auditLogRetentionDays,
      },
      limits: {
        max_upload_mb: config.maxUploadMb,
        max_metadata_bytes: config.maxMetadataBytes,
      },
      };
    },
  );

  r.get(
    '/providers/status',
    {
      schema: {
        tags: ['settings'],
        summary: 'Статус LLM-провайдеров (проксируется из inference-service)',
        description:
          'Возвращает список доступных LLM-бэкендов inference-service: какие настроены, какой активен. ' +
          'Если `LLM_INFERENCE_URL` не задан или inference-service недоступен — `upstream: not_configured | unreachable` и пустой список.',
        security: [{ bearerAuth: [] }],
        response: {
          200: ProviderStatusResponse,
          401: ErrorResponse,
        },
      },
    },
    async () => {
      if (!config.llm.url) {
        return {
          upstream: 'not_configured' as const,
          active: null,
          available: {},
        };
      }
      try {
        const url = new URL('/v1/providers/status', config.llm.url).toString();
        const res = await request(url, {
          method: 'GET',
          headers: {
            ...(config.llm.apiKey ? { authorization: `Bearer ${config.llm.apiKey}` } : {}),
          },
          headersTimeout: 5000,
          bodyTimeout: 5000,
        });
        if (res.statusCode >= 400) {
          return {
            upstream: 'unreachable' as const,
            active: null,
            available: {},
            error: `inference-service responded ${res.statusCode}`,
          };
        }
        const data = (await res.body.json()) as { active?: string | null; available?: Record<string, unknown> };
        return {
          upstream: 'ok' as const,
          active: data.active ?? null,
          available: (data.available ?? {}) as Record<string, { configured: boolean; model: string | null; description: string }>,
        };
      } catch (err) {
        return {
          upstream: 'unreachable' as const,
          active: null,
          available: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
