import { z } from 'zod';

const numberFromEnv = (def: number) =>
  z
    .preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number())
    .default(def);

const ConfigSchema = z.object({
  port: numberFromEnv(3000),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  maxUploadMb: numberFromEnv(50),

  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  storageDir: z.string().min(1),

  // A2: storage backend. `local` — пишем в storageDir (default), `s3` —
  // S3/MinIO + write-through локальный кэш в том же storageDir. Подробно
  // про deferred trade-offs (нет shared-nothing) см. TECH_DEBT A2.
  storageBackend: z.enum(['local', 's3']).default('local'),
  s3: z.object({
    bucket: z.string().optional(),
    // Endpoint для MinIO / другого S3-compatible (например http://minio:9000).
    // Undefined = AWS S3 endpoints по region.
    endpoint: z.string().optional(),
    region: z.string().default('us-east-1'),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    // MinIO требует path-style (bucket в пути, не в hostname).
    // AWS S3 принимает оба; default=true безопаснее (работает везде).
    forcePathStyle: z.coerce.boolean().default(true),
  }),

  // Empty string disables auth — used for local dev. In production set a strong key.
  // Applies to all /api/v1/* routes; /health and /ready are always public.
  apiKey: z.string().default(''),

  // A3: Named client keys. JSON map of { "<key>": "<client_name>" }.
  // Each key grants the same access as API_KEY but tags req.user.caller
  // with the client name for audit/logging. Example:
  //   API_KEYS_JSON='{"abc123":"erp-system","xyz456":"mobile-app"}'
  // API_KEY (root key) takes priority; listed keys are checked second.
  apiKeysJson: z
    .preprocess((v) => {
      if (!v || v === '') return {};
      try { return JSON.parse(v as string); } catch { return {}; }
    }, z.record(z.string()))
    .default({}),

  // P0 security: явный opt-in в no-auth dev-режим. Если apiKey И apiKeysJson
  // пустые, сервис отказывается стартовать — кроме случая когда allowNoAuth=true
  // (loud warn). Default false → fail-closed. См. assertAuthConfigured() ниже
  // и bearerAuthHook (defense in depth).
  allowNoAuth: z.coerce.boolean().default(false),

  // Master key для envelope-шифрования секретов в БД (api_key провайдеров).
  // Формат: 64-символьная hex-строка (= 32 байта). Сгенерировать:
  //   openssl rand -hex 32
  // В production переменная обязательна; пустая в dev → используется
  // deterministic dev-default (см. src/storage/secrets.ts).
  // ВНИМАНИЕ: смена ключа делает ранее зашифрованные секреты нечитаемыми.
  // Процедура ротации — отдельная миграция (см. TECH_DEBT).
  secretsEncryptionKey: z.string().default(''),

  // Number of jobs the BullMQ worker processes in parallel.
  //
  // 2026-05-18: bumped default 1 → 2.
  // Reasoning: LLM extract — main bottleneck в pipeline (100-600 сек
  // per doc на Qwen 32B), а сам LLM запрос идёт сетью на GPU-узел
  // (10.10.28.10), который сам queue'ит запросы. Pipeline до этого
  // (OCR + classify) — CPU-bound, но мы имеем 2+ CPU cores. С
  // concurrency=2 один worker может classify свежий job пока другой
  // ждёт ответ Qwen → ~1.5-2× throughput.
  //
  // Bump до 3+ только при GPU-узлах с параллельным KV-cache (vLLM)
  // или multi-tenant Ollama. На single Qwen 32B Ollama serial'ит
  // запросы, поэтому effective speedup capped at OCR-stage parallel.
  workerConcurrency: numberFromEnv(2),

  // I2: Hard deadline for job processing. If a job has been sitting in the
  // queue longer than this, it is failed unconditionally (no more retries).
  // Prevents a backlog of retries from a prolonged LLM/OCR outage from
  // clogging the queue indefinitely.
  // Default: 4 hours. OCR + LLM on the worst-case document takes ~10 min;
  // 4 h gives ample room for transient outages without holding jobs forever.
  jobMaxAgeSeconds: numberFromEnv(4 * 60 * 60),

  // I5: Rate-limiting. Requests per minute per client (identified by API key,
  // or by IP when the key is absent). Set to 0 to disable rate-limiting.
  rateLimitPerMinute: numberFromEnv(200),

  // Hard cap on the multipart `metadata` field, in bytes. Caller-supplied
  // metadata is JSONB-stored verbatim; without a cap a client could pin
  // arbitrary blobs to every job row.
  maxMetadataBytes: numberFromEnv(64 * 1024),

  // Порог «slow job» — в логе появляется warn-событие `slow job` с
  // указанием bottleneck-шага (ocr / classify / extract / validate).
  // Дефолт 60s — типичный LLM-extract документа на средней локальной
  // модели; настраивать под клиентское железо.
  slowJobThresholdMs: numberFromEnv(60_000),

  sweepers: z.object({
    // How often the pending-job sweeper looks for rows that were inserted
    // into `jobs` but never made it into BullMQ (e.g. Redis hiccup between
    // INSERT and queue.add). Lower = faster recovery, more DB chatter.
    pendingIntervalMs: numberFromEnv(60_000),
    // A pending row younger than this is left alone — gives the normal
    // enqueue path time to land before the sweeper second-guesses it.
    pendingGraceSeconds: numberFromEnv(60),
    // How often we sweep finished jobs to delete their on-disk file.
    fileCleanupIntervalMs: numberFromEnv(60 * 60 * 1000), // hourly
    // Retain uploaded files for N days after the job reaches a terminal
    // state. The DB row itself is kept (audit trail), only the blob on
    // disk is removed and `file_path` is NULLed.
    fileRetentionDays: numberFromEnv(30),
    // How often the audit_log retention sweeper runs. Default daily —
    // частота не важна, ведь удаления редкие; раз в сутки достаточно.
    auditLogIntervalMs: numberFromEnv(24 * 60 * 60 * 1000),
    // Retention для admin-audit (changes на document_types и provider_settings).
    // По умолчанию 365 дней — типичный IT-change audit. Под регуляторные
    // требования (5-7 лет в финансовом контексте) поднимайте через env.
    auditLogRetentionDays: numberFromEnv(365),
    // Webhook auto-retry sweeper (A4 remainder). Ищет jobs у которых
    // webhook_delivered_at IS NULL и последняя попытка была давно.
    // Интервал — как часто проверять (default 15 мин).
    webhookSweeperIntervalMs: numberFromEnv(15 * 60 * 1000),
    // Не трогать job'ы, у которых последняя попытка была менее N минут назад.
    // Default 60 мин — даёт delivery-backoff закончиться естественно, прежде
    // чем sweeper вмешивается.
    webhookSweeperGraceMinutes: numberFromEnv(60),
    // Суммарный жёсткий лимит попыток (initial + sweeper). При 5 initial
    // maxAttempts и лимите 15 — sweeper даёт ещё 2 волны по 5 попыток.
    // После достижения лимита — только ручная кнопка redeliver-webhook.
    webhookSweeperHardLimit: numberFromEnv(15),
  }),

  thresholds: z.object({
    pdfText: numberFromEnv(0.9),
    tesseract: numberFromEnv(0.75),
    visionLlm: numberFromEnv(0.75),
    needsReview: numberFromEnv(0.6),
    // Below this regex-parser confidence, Phase 1 parsers fall back to LLM /extract.
    // Set to 0 to disable LLM-fallback for invoice/UPD entirely.
    regexFallback: numberFromEnv(0.7),
    // Phase B: при OCR-тексте крупнее этого порога авто-включается MultiPassLlmParser
    // для типов с parser_kind='llm_extract'. Двухпроходный режим разбивает текст
    // на header + items-батчи, что улучшает точность на длинных таблицах и
    // уменьшает риск «потери середины» у недорогих моделей.
    //
    // 2026-05-18: понижен с 30k до 15k байт. Реальный VED-кейс показал что
    // Qwen 32B на 10.10.28.10 падает с Ollama OOM («model runner has
    // unexpectedly stopped») на prompt'е >20k chars. Контракт 8MB scan дал
    // 26.7k chars от tesseract → single-shot OOM. На 15k threshold —
    // contract/cert/long-CI идут через multipass, что устраняет OOM.
    multipassAutoBytes: numberFromEnv(15_000),
  }),

  /**
   * MultiPassLlmParser tuning. Раньше эти пороги были хардкодом в
   * parsers/multipass-llm.ts; вынесены в env для подгонки под клиентское
   * железо и модель (контекст-окно, лимит позиций, parallelism к inference).
   *   - headerHeadBytes / headerTailBytes — сколько байт начала/конца текста
   *     уходит в Pass 1 (шапка).
   *   - chunkSizeBytes — размер куска items для Pass 2.
   *   - maxPasses — потолок числа кусков (защита от timeout-цепочки).
   *   - maxItemsTotal — потолок финального items[].
   *   - itemsParallelism — макс одновременных extract-вызовов к inference.
   */
  multipass: z.object({
    headerHeadBytes: numberFromEnv(4_000),
    headerTailBytes: numberFromEnv(2_000),
    chunkSizeBytes: numberFromEnv(12_000),
    maxPasses: numberFromEnv(10),
    maxItemsTotal: numberFromEnv(1_000),
    itemsParallelism: numberFromEnv(3),
  }),

  tesseractLangs: z.string().default('rus+eng'),

  llm: z.object({
    url: z.string().optional(),
    apiKey: z.string().optional(),
    timeoutMs: numberFromEnv(60000),
  }),

  /**
   * EXT-B (Q11): BYO (bring-your-own) LLM credentials per request. Когда
   * включено, consumer (SLAI) может передать свой LLM-провайдер/ключ/модель
   * через заголовки `X-LLM-Provider` / `X-LLM-Api-Key` / `X-LLM-Model` /
   * `X-LLM-Base-Url` на POST /jobs — и THIS job пойдёт через эти creds
   * вместо default provider_settings.
   *
   * Default false (fail-closed): пока флаг выключен, заголовки `X-LLM-*`
   * не принимаются — запрос с `X-LLM-Api-Key` отбивается 400 с понятным
   * error_code (явный сигнал для SLAI, а не молчаливое игнорирование).
   *
   * SECURITY: переданный api_key НИКОГДА не пишется в БД/Redis/логи в
   * plaintext — он шифруется secrets-envelope перед постановкой в очередь
   * и расшифровывается только в воркере в hot-path (см.
   * pipeline/llm/inline-credentials.ts).
   */
  byoLlmEnabled: z.coerce.boolean().default(false),

  /**
   * EXT-D (Q12): ingest a document by URL instead of multipart upload.
   * Consumer (SLAI) pre-uploads to its own blob and sends parsdocs a link —
   * removes the 50MB multipart bottleneck on large freight docs.
   *
   * Default false (fail-closed): server-side fetch of an arbitrary
   * user-supplied URL is an SSRF vector, so the whole feature is gated.
   *
   * SECURITY (см. pipeline/ingest/url-fetch.ts):
   *   - только http(s) схемы;
   *   - host резолвится и блокируется если указывает на private/loopback/
   *     link-local/metadata IP (RFC1918, 127.x, 169.254.x, ::1, …);
   *   - allowedHosts (FILE_URL_ALLOWED_HOSTS, CSV) — опциональный whitelist
   *     для ужесточения. Пусто = block-private-IPs default;
   *   - redirects запрещены (maxRedirections=0);
   *   - hard byte-ceiling enforced mid-stream (не верим Content-Length);
   *   - timeout.
   */
  fileUrlIngest: z.object({
    enabled: z.coerce.boolean().default(false),
    // CSV-список разрешённых хостов (case-insensitive). Пусто = любой
    // публичный хост (private/internal всё равно блокируются IP-проверкой).
    allowedHosts: z
      .preprocess((v) => {
        if (typeof v !== 'string' || v.trim() === '') return [];
        return v
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h.length > 0);
      }, z.array(z.string()))
      .default([]),
    timeoutMs: numberFromEnv(20_000),
  }),

  yandex: z.object({
    apiKey: z.string().optional(),
    folderId: z.string().optional(),
    timeoutMs: numberFromEnv(30000),
    // Yandex OCR-модель для recognizeText. `page` — обычный текст (default).
    // Альтернативы: `table`, `page-column-sort`, `handwritten`.
    model: z.string().default('page'),
    /**
     * I8: глобальный флаг выключения Yandex для PII-документов (TTN, CMR).
     * Per-job opt-out также доступен через `metadata._disable_external_ocr=true`.
     * См. router.ts ChainOptions.
     */
    disableForPii: z.coerce.boolean().default(false),
  }),

  /**
   * DaData party-by-INN enrichment (enrich-стадия пайплайна). Российский
   * сервис: шлём только ИНН юрлиц (публичные данные ЕГРЮЛ, не ПДн — 152-ФЗ ок).
   * Доступность гейтится наличием apiKey (см. DadataClient.isAvailable()).
   */
  dadata: z.object({
    apiKey: z.string().optional(),
    timeoutMs: numberFromEnv(10000),
    // TTL in-memory кэша по ИНН. Default 24h — данные ЕГРЮЛ меняются редко.
    cacheTtlMs: numberFromEnv(24 * 60 * 60 * 1000),
  }),

  webhook: z.object({
    hmacSecret: z.string().min(1),
    timeoutMs: numberFromEnv(10000),
    maxAttempts: numberFromEnv(5),
  }),

  /**
   * F13: SLAI continuous category sync (inbound webhook от SLAI к нам).
   * См. PARSDOCS_CATEGORY_SYNC_REPLY.md секция 5 — 2 отдельных HMAC
   * секрета (один для исходящих от нас, второй для входящих от SLAI),
   * чтобы можно было ротировать независимо.
   *
   * Если `toParsdocsHmacSecret` пустой — endpoint `/api/v1/integrations/slai/sync/*`
   * fail-closed (401 на любой запрос). Это безопасный default для прода
   * пока обмен ключами с SLAI не завершён (см. S3 в SLAI_SYNC_QUEUE.md).
   */
  slai: z.object({
    toParsdocsHmacSecret: z.string().optional(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    maxUploadMb: env.MAX_UPLOAD_MB,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    storageDir: env.STORAGE_DIR,
    storageBackend: env.STORAGE_BACKEND,
    s3: {
      bucket: env.S3_BUCKET || undefined,
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    },
    apiKey: env.API_KEY ?? '',
    apiKeysJson: env.API_KEYS_JSON,
    allowNoAuth: env.ALLOW_NO_AUTH,
    secretsEncryptionKey: env.SECRETS_ENCRYPTION_KEY ?? '',
    workerConcurrency: env.WORKER_CONCURRENCY,
    jobMaxAgeSeconds: env.JOB_MAX_AGE_SECONDS,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    maxMetadataBytes: env.MAX_METADATA_BYTES,
    slowJobThresholdMs: env.SLOW_JOB_THRESHOLD_MS,
    sweepers: {
      pendingIntervalMs: env.PENDING_SWEEPER_INTERVAL_MS,
      pendingGraceSeconds: env.PENDING_SWEEPER_GRACE_SECONDS,
      fileCleanupIntervalMs: env.FILE_CLEANUP_INTERVAL_MS,
      fileRetentionDays: env.FILE_RETENTION_DAYS,
      auditLogIntervalMs: env.AUDIT_LOG_SWEEP_INTERVAL_MS,
      auditLogRetentionDays: env.AUDIT_LOG_RETENTION_DAYS,
    },
    thresholds: {
      pdfText: env.PDF_TEXT_ACCEPT_THRESHOLD,
      tesseract: env.TESSERACT_ACCEPT_THRESHOLD,
      visionLlm: env.VISION_LLM_ACCEPT_THRESHOLD,
      needsReview: env.NEEDS_REVIEW_THRESHOLD,
      regexFallback: env.LLM_FALLBACK_THRESHOLD,
      multipassAutoBytes: env.MULTIPASS_AUTO_BYTES,
    },
    multipass: {
      headerHeadBytes: env.MULTIPASS_HEADER_HEAD_BYTES,
      headerTailBytes: env.MULTIPASS_HEADER_TAIL_BYTES,
      chunkSizeBytes: env.MULTIPASS_CHUNK_SIZE_BYTES,
      maxPasses: env.MULTIPASS_MAX_PASSES,
      maxItemsTotal: env.MULTIPASS_MAX_ITEMS_TOTAL,
      itemsParallelism: env.MULTIPASS_ITEMS_PARALLELISM,
    },
    tesseractLangs: env.TESSERACT_LANGS,
    llm: {
      url: env.LLM_INFERENCE_URL || undefined,
      apiKey: env.LLM_API_KEY || undefined,
      timeoutMs: env.LLM_TIMEOUT_MS,
    },
    byoLlmEnabled: env.BYO_LLM_ENABLED,
    fileUrlIngest: {
      enabled: env.FILE_URL_INGEST_ENABLED,
      allowedHosts: env.FILE_URL_ALLOWED_HOSTS,
      timeoutMs: env.FILE_URL_FETCH_TIMEOUT_MS,
    },
    yandex: {
      apiKey: env.YANDEX_VISION_API_KEY || undefined,
      folderId: env.YANDEX_FOLDER_ID || undefined,
      timeoutMs: env.YANDEX_TIMEOUT_MS,
      model: env.YANDEX_OCR_MODEL || undefined,
      disableForPii: env.YANDEX_DISABLE_FOR_PII,
    },
    dadata: {
      apiKey: env.DADATA_API_KEY || undefined,
      timeoutMs: env.DADATA_TIMEOUT_MS,
      cacheTtlMs: env.DADATA_CACHE_TTL_MS,
    },
    webhook: {
      hmacSecret: env.WEBHOOK_HMAC_SECRET ?? '',
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
      maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    },
    slai: {
      toParsdocsHmacSecret: env.SLAI_TO_PARSDOCS_HMAC_SECRET || undefined,
    },
  });
}

/**
 * P0 security guard — fail-closed на старте.
 *
 * «Running open» = НЕТ ни root API_KEY, ни named keys (apiKeysJson пустой).
 * В этом случае bearerAuthHook отдаёт system super_admin на каждый запрос →
 * API полностью открыт. На prod это случилось из-за пустого API_KEY.
 *
 *   - allowNoAuth=true → разрешаем, но громкий warn (dev-режим).
 *   - иначе → fatal: бросаем, процесс должен упасть с non-zero до listen().
 *
 * Срабатывает независимо от NODE_ENV — prod-деплой мог его не выставить,
 * полагаться на него нельзя. Единственный opt-out — ALLOW_NO_AUTH=true.
 */
export function assertAuthConfigured(
  cfg: Pick<Config, 'apiKey' | 'apiKeysJson' | 'allowNoAuth'>,
  log: { warn: (msg: string) => void } = { warn: (m) => console.warn(m) }, // eslint-disable-line no-console
): void {
  const hasRootKey = cfg.apiKey.length > 0;
  const hasNamedKeys = Object.keys(cfg.apiKeysJson).length > 0;
  if (hasRootKey || hasNamedKeys) return;

  if (cfg.allowNoAuth) {
    log.warn(
      'AUTH DISABLED — all requests run as super_admin. Never use in production.',
    );
    return;
  }

  throw new Error(
    'Refusing to start: no API_KEY / API_KEYS_JSON configured and ALLOW_NO_AUTH ' +
      'is not set. Set API_KEY or explicitly opt into no-auth dev mode ' +
      '(ALLOW_NO_AUTH=true).',
  );
}

export const config = loadConfig();
