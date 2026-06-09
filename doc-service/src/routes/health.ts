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

// EXT-LINE (2026-05-29): per-line/per-doc transport signal fields, которые
// extractor умеет извлекать в items[i] и в корень документа. SLAI читает
// этот список чтобы знать какие сигналы доступны для матчинга — без
// `400`-сюрпризов на проде. Дополнения сюда — additive (contractVersion
// остаётся '1'). Структура `{line: [...], doc: [...]}` чтобы различать.
//
// Формат {name, since} (SLAI FOLLOWUP 2026-05-29 §1) — даёт version-visibility:
// их DocumentMatcher feature-gate'ит логику «если в supportedLineFields нет
// container_no — fallback на plate+route+date». Без `since` нужен отдельный
// запрос «когда поле появилось». Extensible — добавить `deprecated_at`/
// `accuracy_target` потом без breaking change.
const EXTRACTOR_SUPPORTED_FIELDS = {
  line: [
    // фрахт-атрибуты (commit 92745ce, 2026-05-20):
    { name: 'vehicle_plate', since: '2026-05-20' },
    { name: 'order_ref',     since: '2026-05-20' },
    { name: 'route_from',    since: '2026-05-20' },
    { name: 'route_to',      since: '2026-05-20' },
    { name: 'trip_date',     since: '2026-05-20' },
    // EXT-LINE (commit 42adffc, 2026-05-29):
    { name: 'container_no',   since: '2026-05-29' },
    { name: 'bl_no',          since: '2026-05-29' },
    { name: 'cmr_no',         since: '2026-05-29' },
    { name: 'ttn_no',         since: '2026-05-29' },
    { name: 'declaration_no', since: '2026-05-29' },
    { name: 'driver_name',    since: '2026-05-29' },
  ] as const,
  doc: [
    { name: 'period_from',   since: '2026-05-29' },
    { name: 'period_to',     since: '2026-05-29' },
    { name: 'contract_no',   since: '2026-05-29' },
    { name: 'contract_date', since: '2026-05-29' },
    // EXT-LINE-2 (SLAI 2026-06-03): транспортные сигналы для перевозочных
    // счетов. Заполняются только если в тексте счёта есть соответствующие
    // блоки («Основание», «гос. номер», «Маршрут», «Спецразрешение»).
    { name: 'order_ref',     since: '2026-06-03' },
    { name: 'vehicle.plate', since: '2026-06-03' },
    { name: 'route_from',    since: '2026-06-03' },
    { name: 'route_to',      since: '2026-06-03' },
    { name: 'permit_no',     since: '2026-06-03' },
    // EXT-LINE-3 (SLAI 2026-06-04 P0): bank/ogrn/due_date/payment_method
    // + items[].category enum.
    { name: 'seller.ogrn',     since: '2026-06-04' },
    { name: 'buyer.ogrn',      since: '2026-06-04' },
    { name: 'seller.bik',      since: '2026-06-04' },
    { name: 'seller.account',  since: '2026-06-04' },
    { name: 'seller.corr_account', since: '2026-06-04' },
    { name: 'due_date',        since: '2026-06-04' },
    { name: 'payment_method',  since: '2026-06-04' },
    { name: 'items[].category', since: '2026-06-04' },
    // EXT-LINE-4 (SLAI 2026-06-04 P1): transport.* nested + cargo + escort
    // + vehicle расширения + permit details + route.leg_kind.
    { name: 'vehicle.model',     since: '2026-06-04' },
    { name: 'vehicle.trailer',   since: '2026-06-04' },
    { name: 'vehicle.axles',     since: '2026-06-04' },
    { name: 'transport',         since: '2026-06-04' },
    { name: 'transport.driver',  since: '2026-06-04' },
    { name: 'transport.route.leg_kind', since: '2026-06-04' },
    { name: 'transport.route.distance_km', since: '2026-06-04' },
    { name: 'transport.permit.issued_by',  since: '2026-06-04' },
    { name: 'transport.permit.valid_to',   since: '2026-06-04' },
    { name: 'transport.cargo.description', since: '2026-06-04' },
    { name: 'transport.cargo.weight_kg',   since: '2026-06-04' },
    { name: 'transport.cargo.dimensions',  since: '2026-06-04' },
    { name: 'transport.cargo.oversized',   since: '2026-06-04' },
    { name: 'transport.escort.required',   since: '2026-06-04' },
    { name: 'transport.escort.type',       since: '2026-06-04' },
    { name: 'transport.escort.area',       since: '2026-06-04' },
    // EXT-TTN-1 (SLAI 2026-06-04 Q-TTN-CMR-BL-SCHEMA P0+P1): расширенные
    // схемы для ТТН / CMR / B/L. Поля per-type, перечисляем только новые
    // top-level — полные деревья видны в JSON-schema.
    // ТТН P0:
    { name: 'TTN.carrier',          since: '2026-06-04' },
    { name: 'TTN.driver.fullName',  since: '2026-06-04' },
    { name: 'TTN.driver.phone',     since: '2026-06-04' },
    { name: 'TTN.route.from_city',  since: '2026-06-04' },
    { name: 'TTN.route.to_city',    since: '2026-06-04' },
    { name: 'TTN.loading_date',     since: '2026-06-04' },
    { name: 'TTN.unloading_date',   since: '2026-06-04' },
    { name: 'TTN.seal_number',      since: '2026-06-04' },
    { name: 'TTN.cargo.weight_kg',  since: '2026-06-04' },
    { name: 'TTN.cargo.volume_m3',  since: '2026-06-04' },
    { name: 'TTN.cargo.dangerous_class', since: '2026-06-04' },
    // CMR P1:
    { name: 'CMR.consignor',         since: '2026-06-04' },
    { name: 'CMR.consignee',         since: '2026-06-04' },
    { name: 'CMR.successive_carrier', since: '2026-06-04' },
    { name: 'CMR.cargo.marks',       since: '2026-06-04' },
    { name: 'CMR.cargo.packages',    since: '2026-06-04' },
    { name: 'CMR.cargo.gross_weight_kg', since: '2026-06-04' },
    { name: 'CMR.cargo.volume_m3',   since: '2026-06-04' },
    { name: 'CMR.place_of_loading',  since: '2026-06-04' },
    { name: 'CMR.place_of_delivery', since: '2026-06-04' },
    { name: 'CMR.vehicle',           since: '2026-06-04' },
    { name: 'CMR.issued_at',         since: '2026-06-04' },
    // B/L P1 (новый тип в EXTENDED_SCHEMAS):
    { name: 'bill_of_lading.vessel',          since: '2026-06-04' },
    { name: 'bill_of_lading.port_of_loading', since: '2026-06-04' },
    { name: 'bill_of_lading.port_of_discharge', since: '2026-06-04' },
    { name: 'bill_of_lading.containers',      since: '2026-06-04' },
    { name: 'bill_of_lading.freight_terms',   since: '2026-06-04' },
    { name: 'bill_of_lading.incoterm',        since: '2026-06-04' },
  ] as const,
};

// adapterVersion — bump'аем при расширении SUPPORTED_FIELDS или сменах
// поведения, видимых consumer'у. Формат YYYY.MM.DD.
const EXTRACTOR_ADAPTER_VERSION = '2026.06.05';

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
      adapterVersion: EXTRACTOR_ADAPTER_VERSION,
      contractVersion: EXTRACTOR_CONTRACT_VERSION,
      service: 'parsdocs',
      semver: process.env.APP_VERSION || '0.1.0',
      commitShort: process.env.GIT_COMMIT_SHORT
        || (process.env.GIT_COMMIT || 'unknown').slice(0, 7),
      supportedDocumentTypes: types.map((t) => t.slug),
      supportedLineFields: EXTRACTOR_SUPPORTED_FIELDS.line,
      supportedDocFields: EXTRACTOR_SUPPORTED_FIELDS.doc,
      maxFileMB: config.maxUploadMb,
      webhookSupported: true as const,
      // L1 (2026-05-27): enablement-флаги новых ingest-возможностей, чтобы SLAI
      // обнаруживал их через /capabilities, а не ловил 400 на проде. Additive —
      // contractVersion остаётся '1' (доп. поля не ломают consumer'ов).
      fileUrlIngest: config.fileUrlIngest.enabled,
      asr: config.asr.enabled,
      byoLlm: config.byoLlmEnabled,
      hybridRouting: config.hybridRouting.enabled,
      // EXT-HINT-1 (SLAI 2026-06-03): сервис проставляет target_entity_hint в
      // webhook payload для счетов с транспортными сигналами. Значения сейчас:
      // 'Transportation'. Если отсутствует — хинт не вычисляется.
      targetEntityHint: true as const,
      // EXT-LLM-GATEWAY (local, 2026-06-08): doc-service как локальный
      // OpenAI-совместимый LLM-шлюз. Когда enabled — доступны top-level
      // /v1/chat/completions и /v1/models (Bearer named-key). `aliases` —
      // опубликованное меню моделей (наши алиасы, не сырые backend-теги).
      llmGateway: {
        enabled: config.llmGateway.enabled,
        defaultAlias: config.llmGateway.defaultAlias,
        aliases: Object.keys(config.llmGateway.models),
        streaming: false as const,
        embeddings: false as const,
      },
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
