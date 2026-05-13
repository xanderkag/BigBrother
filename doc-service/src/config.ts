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

  // Master key для envelope-шифрования секретов в БД (api_key провайдеров).
  // Формат: 64-символьная hex-строка (= 32 байта). Сгенерировать:
  //   openssl rand -hex 32
  // В production переменная обязательна; пустая в dev → используется
  // deterministic dev-default (см. src/storage/secrets.ts).
  // ВНИМАНИЕ: смена ключа делает ранее зашифрованные секреты нечитаемыми.
  // Процедура ротации — отдельная миграция (см. TECH_DEBT).
  secretsEncryptionKey: z.string().default(''),

  // Number of jobs the BullMQ worker processes in parallel. Tesseract is
  // CPU-bound and single-threaded — bumping past 1 doesn't speed up
  // tesseract-heavy workloads on a single CPU core. Increase only when the
  // workload is mostly LLM/network bound or you have multiple cores.
  workerConcurrency: numberFromEnv(1),

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
    multipassAutoBytes: numberFromEnv(30_000),
  }),

  tesseractLangs: z.string().default('rus+eng'),

  llm: z.object({
    url: z.string().optional(),
    apiKey: z.string().optional(),
    timeoutMs: numberFromEnv(60000),
  }),

  yandex: z.object({
    apiKey: z.string().optional(),
    folderId: z.string().optional(),
    timeoutMs: numberFromEnv(30000),
  }),

  webhook: z.object({
    hmacSecret: z.string().min(1),
    timeoutMs: numberFromEnv(10000),
    maxAttempts: numberFromEnv(5),
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
    apiKey: env.API_KEY ?? '',
    apiKeysJson: env.API_KEYS_JSON,
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
    tesseractLangs: env.TESSERACT_LANGS,
    llm: {
      url: env.LLM_INFERENCE_URL || undefined,
      apiKey: env.LLM_API_KEY || undefined,
      timeoutMs: env.LLM_TIMEOUT_MS,
    },
    yandex: {
      apiKey: env.YANDEX_VISION_API_KEY || undefined,
      folderId: env.YANDEX_FOLDER_ID || undefined,
      timeoutMs: env.YANDEX_TIMEOUT_MS,
    },
    webhook: {
      hmacSecret: env.WEBHOOK_HMAC_SECRET ?? '',
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
      maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    },
  });
}

export const config = loadConfig();
