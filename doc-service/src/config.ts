import { z } from 'zod';

const numberFromEnv = (def: number) =>
  z
    .preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number())
    .default(def);

// Булев флаг из env. НЕ `z.coerce.boolean()` — тот трактует ЛЮБУЮ непустую
// строку как true, включая "false" → нельзя выключить дефолтно-включённый флаг
// (был баг: OFFICE_IMAGE_FALLBACK_ENABLED=false не выключал vision-fallback).
// Здесь: не задан/"" → дефолт; "false"/"0"/"no"/"off" (без регистра) → false;
// всё прочее непустое → true.
const booleanFromEnv = (def: boolean) =>
  z
    .preprocess((v) => {
      // Пусто/не задан → сразу дефолт. ВАЖНО: возвращаем `def`, а НЕ undefined:
      // `.default()` ловит только undefined-ВХОД схемы, а не undefined из
      // preprocess, поэтому "" (пустой env-var) с `return undefined` ронял
      // z.boolean() на boot'е (Required). Дефолт-возврат закрывает и "".
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      return !(s === 'false' || s === '0' || s === 'no' || s === 'off');
    }, z.boolean())
    .default(def);

// M1: confidence-пороги — это доли 0..1. Misconfig вроде
// HYBRID_VISION_CONF_THRESHOLD=70 (думали «70%») роутил бы ВСЁ в vision.
// Жёстко отбиваем out-of-range на старте с понятным сообщением — лучше
// падение на boot'е, чем тихое неверное поведение (не clamp'аем молча).
const confidence01FromEnv = (def: number) =>
  z
    .preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number())
    .refine((n) => n >= 0 && n <= 1, {
      message: 'must be a confidence fraction between 0 and 1 (e.g. 0.7, not 70)',
    })
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
    forcePathStyle: booleanFromEnv(true),
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
  allowNoAuth: booleanFromEnv(false),

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

  /**
   * Auto-requality (2026-07-10): после extract'а pipeline оценивает разбор
   * детектором «странности» (quality-assessment.ts). Если сигналы сработали
   * (пустое извлечение, обрыв JSON, reasoning-bleed, мусорный OCR) — extract
   * автоматически переигрывается через `fallbackProviderId` (другая модель),
   * и лучший из двух результатов сохраняется. Если и после этого странно —
   * job уходит в needs_review с перечнем факторов.
   *
   *   - enabled: мастер-выключатель. false → ведём себя как раньше (без
   *     авто-переразбора), guard на пустое извлечение остаётся.
   *   - fallbackProviderId: id провайдера для второй попытки. Должен быть
   *     ДРУГИМ бэкендом чем основной (напр. Ollama-32k если основной vLLM-8k):
   *     разные модели ловят разные сбои. Пусто → авто-переразбор пропускается
   *     (fail-soft, только детекция + needs_review).
   */
  requality: z.object({
    enabled: booleanFromEnv(true),
    fallbackProviderId: z.string().default(''),
  }),

  /**
   * Classifier tuning. Раньше эти числа были хардкодом в двух модулях
   * (filename-signal.ts + llm-classifier.ts) и подбирались руками; вынесены
   * сюда чтобы быть env-tunable в одном месте. Дефолты = прежние значения
   * (behavior-preserving).
   *
   *   - filenameSignalWeight: вес одиночного filename-сигнала во внутреннем
   *     weight-пространстве keyword-классификатора (не в [0,1]). 5.5 > invoice(5),
   *     но < title-boosted strong-матч (7.5). См. filename-signal.ts.
   *   - filenameAgreeBoost: аддитивный boost когда имя подтверждает тип с
   *     контент-поддержкой.
   *   - priorConfidentThreshold: порог уверенности keyword-prior'а, ниже
   *     которого при LLM=unknown документ помечается «не опознан» (иначе берём
   *     тип prior'а как fallback).
   *   - llmTextChars: сколько первых символов raw-текста уходит в classify-prompt.
   *   - classifyTimeoutMs: таймаут одного classify-вызова к LLM.
   */
  classifier: z.object({
    filenameSignalWeight: numberFromEnv(5.5),
    filenameAgreeBoost: numberFromEnv(1.0),
    priorConfidentThreshold: confidence01FromEnv(0.5),
    llmTextChars: numberFromEnv(2500),
    classifyTimeoutMs: numberFromEnv(18_000),
    // Ниже этой уверенности классификации документ уходит в needs_review
    // (тип мог быть определён неверно). 0.5 = расхождение keyword↔LLM (см.
    // llm-classifier.llmConfidence); 0.7 = LLM-only проходит; 0.9 = согласие.
    classifyReviewThreshold: confidence01FromEnv(0.6),
    // §P0-2/P0-3 (CLASSIFIER-PACKET-V2): сегментация композитов.
    segmentMinConf: confidence01FromEnv(0.4), // порог открытия сегмента по классификатору
    segmentTypedConf: confidence01FromEnv(0.5), // порог "typed" в isMultiDocument
    segmentBoundaryFloor: confidence01FromEnv(0.6), // floor уверенности boundary-сегмента
    segmentHardBoundary: booleanFromEnv(true), // kill-switch детектора границ
    // §P0-1: per-page classify через LLM-catalog вместо keyword-only. Default
    // false — границы уже типизируют boundary-страницы; включать по eval-bctt
    // (стоимость: N вызовов на N-стр композит).
    multidocLlmClassify: booleanFromEnv(false),
    // §P2-3: форс-провайдер для per-page classify (A/B qwen3.6 vs yandexgpt-5).
    // '' = default-провайдер (no-op). Действует только с multidocLlmClassify=true.
    classifyProviderId: z.string().default(''),
    // §P0-0: восстанавливать постраничность склеенного OCR (pages≤1) из текста,
    // чтобы сегментация запустилась. Default false — эвристика, включать по eval.
    segmentForcePageSplit: booleanFromEnv(false),
    // §P2-2: VLM-классификация по изображению для плохих фото (пустой/мусорный
    // OCR-текст). Default false — vision дороже; локальная модель (не облако).
    vlmClassify: booleanFromEnv(false),
  }),

  tesseractLangs: z.string().default('rus+eng'),

  /**
   * P1-B (OFFICE_FILES_V2 §3): vision-fallback для картиночных офисных файлов.
   * Docx-обёртка вокруг скана даёт почти пустой текст → LLM извлекает из
   * огрызка. Когда извлечённого текста < minTextChars И есть крупные картинки
   * (≥ minImageKb), картинки прогоняются через vision-движок (qwen3-vl:32b) и
   * склеиваются с текстом. Если текста достаточно — картинки не трогаем (не
   * жжём GPU зря).
   *
   *   - enabled=false → fallback выключен, docx-движок ведёт себя как раньше.
   *   - minTextChars: «текста почти нет» (< → vision при любой картинке ≥ minImageKb).
   *   - minImageKb: логотипы/печати мельче этого не идут в vision.
   *   - maxImages: потолок числа картинок на документ (latency/GPU-guard).
   *   - largeImageKb: «скан-размер» картинки (полная страница, не логотип).
   *   - imageDocMaxChars: если есть скан-картинка И текста меньше этого — док
   *     «картинко-доминирован» (содержание в картинке, текст — шапка), гоним
   *     vision даже когда текста > minTextChars. Ловит реальный кейс
   *     (Тех.описание: 588 симв текста + картинки 582/231 KB — vision НЕ сработал
   *     на пороге minTextChars=200, т.к. 588 > 200).
   */
  officeImageFallback: z.object({
    enabled: booleanFromEnv(true),
    minTextChars: numberFromEnv(200),
    minImageKb: numberFromEnv(50),
    maxImages: numberFromEnv(8),
    largeImageKb: numberFromEnv(200),
    imageDocMaxChars: numberFromEnv(2500),
  }),

  llm: z.object({
    url: z.string().optional(),
    apiKey: z.string().optional(),
    timeoutMs: numberFromEnv(60000),
  }),

  /**
   * ASR (voice/audio ingestion) — «OCR for audio». Когда включено, doc-service
   * принимает аудио-файлы (audio/wav, audio/mpeg, audio/mp4, audio/ogg) на
   * POST /jobs, транскрибирует их через inference-service `/v1/transcribe`, а
   * затем гонит ПОЛУЧЕННЫЙ ТЕКСТ через тот же downstream-пайплайн (classify →
   * extract → validate → webhook). Никаких изменений ниже по потоку.
   *
   * enabled=false (default) → аудио-загрузки отбиваются 4xx с понятным
   * error_code ASR_DISABLED; поведение для всех остальных типов не меняется.
   *
   * Endpoint inference-сервиса берётся из того же llm.url (LLM_INFERENCE_URL) —
   * /v1/transcribe живёт там же, где /v1/classify и /v1/extract. Сама ASR-модель
   * настраивается на стороне inference-service (ASR_BASE_URL/ASR_MODEL) и
   * model-agnostic — doc-service о ней ничего не знает. Ключ НЕ нужен.
   *
   *   - confidenceDefault: per-clip confidence ASR-серверы обычно не дают;
   *     этим значением заполняем overall, чтобы downstream needs_review-логика
   *     получила число. Дефолт 0.8 — нейтрально-высокий (не блокируем, но и не
   *     слепо доверяем); понижайте, если хотите ручную проверку всех голосовых.
   *   - language: опц. ISO 639-1 подсказка ('ru'), уходит в /v1/transcribe.
   */
  asr: z.object({
    enabled: booleanFromEnv(false),
    timeoutMs: numberFromEnv(300_000),
    confidenceDefault: confidence01FromEnv(0.8),
    language: z.string().optional(),
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
  byoLlmEnabled: booleanFromEnv(false),

  /**
   * Hybrid-routing (SLAI backlog Sequencing #3) — главный рычаг по latency.
   *
   * После OCR+classify, перед extract, роутер решает PATH per-job:
   *   - чистый text-PDF (высокая OCR-уверенность, pdf-text engine) → быстрый
   *     text-провайдер (phi4), в SLA, без картинки;
   *   - скан / низкая OCR-уверенность / image / per-type prefer_vision →
   *     vision-провайдер (Qwen-VL) с картинкой первой страницы (точность).
   *
   * enabled=false (default) → роутер не вмешивается, поведение в точности как
   * сегодня: provider.vision + metadata._extract_from_image работают как раньше.
   *
   *   - visionConfThreshold: OCR-уверенность ниже которой считаем «нужен vision».
   *   - visionProviderId: явный id строки provider_settings vision-провайдера.
   *     Пусто → роутер сам ищет активную vision-строку (findActiveVision()).
   */
  hybridRouting: z.object({
    enabled: booleanFromEnv(false),
    visionConfThreshold: confidence01FromEnv(0.7),
    visionProviderId: z.string().optional(),
    /**
     * Явный id provider_settings-строки для vision-OCR сканов (VisionLlmEngine).
     * Отделён от visionProviderId (extract-from-image), потому что OCR-движок
     * должен идти на vision-capable модель (qwen3-vl:32b), а НЕ на default
     * text-провайдера extraction'а (qwen3.6:27b). Пусто → OCR-движок берёт
     * любую активную vision-строку через findActiveVision().
     */
    ocrVisionProviderId: z.string().optional(),
  }),

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
    enabled: booleanFromEnv(false),
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
     * Per-type override OCR-модели. Для перечисленных slug'ов документов
     * вместо `model` используется `tableModel` (по умолчанию `table`) —
     * на сканах счёт-фактур / УПД табличная модель распознаёт таблицы
     * заметно лучше. CSV slug'ов, case-insensitive. Пусто = поведение
     * не меняется (везде `model`). Per-job override — metadata._yandex_ocr_model.
     */
    tableModel: z.string().default('table'),
    tableModelTypes: z
      .preprocess((v) => {
        if (typeof v !== 'string' || v.trim() === '') return [];
        return v
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length > 0);
      }, z.array(z.string()))
      .default([]),
    /**
     * Когда Yandex настроен (key+folder) и флаг включён — Yandex OCR
     * становится ПЕРВЫМ scan-движком (перед tesseract / vision-llm) для
     * растровых входов (image/* и PDF). Нативные текстовые движки
     * (pdf-text/xlsx/docx) всё равно идут первыми — Yandex не нужен на
     * чистом текстовом слое. PII-гард сохраняется: на PII-типах /
     * _disable_external_ocr Yandex по-прежнему выкидывается из цепочки.
     * Default false → порядок цепочки не меняется (Yandex — last-resort).
     */
    preferForScans: booleanFromEnv(false),
    /**
     * I8: глобальный флаг выключения Yandex для PII-документов (TTN, CMR).
     * Per-job opt-out также доступен через `metadata._disable_external_ocr=true`.
     * См. router.ts ChainOptions.
     */
    disableForPii: booleanFromEnv(false),
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

  /**
   * EXT-LLM-GATEWAY (local): doc-service как локальный OpenAI-совместимый
   * LLM-шлюз для внешних клиентов (клиент №1 — SLAI AI-чат). Это
   * аутентифицированный passthrough на локальный GPU-бокс (Ollama,
   * OpenAI-compat) с подменой `model` по карте алиасов. Облачные бэкенды
   * НЕ используются (правило TAIPIT-канала: corp-данные только on-prem).
   * См. docs/EXT_LLM_GATEWAY_LOCAL_IMPL_TZ_2026-06-08.md.
   *
   * enabled=false (default) → роуты /v1/chat/completions, /v1/models,
   * /v1/embeddings НЕ регистрируются (фича-флаг, fail-closed).
   *
   *   - baseUrl: endpoint GPU Ollama (OpenAI-compat), напр.
   *     http://10.10.33.10:11434/v1. ВАЖНО: это НЕ config.llm.url —
   *     тот указывает на inference-service (кастомные /v1/classify,
   *     /v1/extract). Шлюз идёт ПРЯМО в Ollama, минуя inference-service.
   *     Если пусто — fallback на config.llm.url (на случай если оба
   *     указывают на один OpenAI-compat endpoint).
   *   - defaultAlias: алиас по умолчанию когда клиент не указал model
   *     или указал неизвестный.
   *   - models: карта alias→ollama-tag. Публикуем клиенту алиасы (стабильны),
   *     backend-тег меняем без правок у клиента. Парсится из JSON.
   *   - timeoutMs: таймаут одного chat/embeddings-вызова к Ollama.
   */
  llmGateway: z.object({
    enabled: booleanFromEnv(false),
    /**
     * INTEGRATION_HUB (Ф1): enforcement суточных квот потребителей в шлюзе.
     * Перед upstream-вызовом каждого коннектора (llm/dadata/yandex_maps) шлюз
     * зовёт checkConsumerQuota(caller, connector) и при !allowed отдаёт 429.
     *
     * default false (fail-closed по поведению, но fail-OPEN по трафику):
     * пока флаг выключен, проверка квот ВООБЩЕ не вызывается — живой LLM-чат
     * работает в точности как раньше. Включать только после того как owner
     * выставил cap/budget. Даже при включённом флаге enforcement fail-open:
     * нет cap/budget ИЛИ ошибка проверки → запрос ПРОПУСКАЕТСЯ (никогда не
     * блокируем из-за сбоя). См. src/routes/llm-gateway.ts.
     */
    quotaEnabled: booleanFromEnv(false),
    /**
     * EXT-LLM-GATEWAY-ANTHROPIC (2026-06-XX): backend selector. По умолчанию
     * 'openai_compat' — старое поведение (passthrough в Ollama / vLLM /
     * OpenAI-compat upstream). 'anthropic' — translator OpenAI↔Anthropic
     * native API на лету (для Asha, где нет локальной GPU и используется
     * облачный Anthropic ключ).
     *
     * Подбирается per-окружение:
     *   - kb-docker (корп) → openai_compat (локальный Ollama на 10.10.33.10)
     *   - asha (пилот SLAI) → anthropic (cloud Anthropic key)
     */
    backend: z.enum(['openai_compat', 'anthropic']).default('openai_compat'),
    baseUrl: z.string().optional(),
    /**
     * Anthropic API key (только для backend='anthropic'). Не используется
     * для openai_compat (там key в baseUrl или passthrough без auth).
     */
    apiKey: z.string().optional(),
    defaultAlias: z.string().default('parsdocs-chat'),
    models: z
      .preprocess((v) => {
        if (!v || v === '') return {};
        try {
          const parsed = JSON.parse(v as string);
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      }, z.record(z.string()))
      .default({}),
    timeoutMs: numberFromEnv(120_000),
    /**
     * EXT-LLM-GATEWAY-EMBEDDINGS (SLAI 2026-06-XX): отдельный provider
     * для /v1/embeddings, не зависит от chat backend. Anthropic embeddings
     * не делает, поэтому даже на Asha (chat = anthropic) embeddings идут
     * через OpenAI.
     *
     * SLAI Help-RAG требует text-embedding-3-small (1536 dim) — на ней
     * у них pgvector help_chunk-индекс построен.
     *
     * enabled=false по умолчанию (фича-флаг). Активируется когда есть
     * OPENAI_API_KEY и хотя бы один алиас в EMBEDDINGS_MODELS_JSON.
     */
    embeddings: z.object({
      enabled: booleanFromEnv(false),
      provider: z.enum(['openai']).default('openai'),
      baseUrl: z.string().default('https://api.openai.com/v1'),
      apiKey: z.string().optional(),
      defaultAlias: z.string().default('parsdocs-embeddings'),
      models: z
        .preprocess((v) => {
          if (!v || v === '') return {};
          try {
            const parsed = JSON.parse(v as string);
            return parsed && typeof parsed === 'object' ? parsed : {};
          } catch {
            return {};
          }
        }, z.record(z.string()))
        .default({}),
      timeoutMs: numberFromEnv(60_000),
    }),
    /**
     * EXT-LLM-GATEWAY-DADATA (SLAI 2026-06-XX): третий внешний канал.
     * DaData — geo-доступен из РФ, никакого outbound-прокси (в отличие
     * от Anthropic/OpenAI). Тонкий passthrough к suggestions.dadata.ru.
     * SLAI шлёт свой PAT, мы подставляем DADATA_API_KEY.
     *
     * Ключ берётся: env > provider_settings.kind='dadata' (через UI
     * Providers — у нас kind='dadata' уже зарегистрирован, используется
     * в enrichment pipeline).
     */
    dadata: z.object({
      enabled: booleanFromEnv(false),
      baseUrl: z.string().default('https://suggestions.dadata.ru'),
      apiKey: z.string().optional(),
      timeoutMs: numberFromEnv(15_000),
    }),
    /**
     * INTEGRATION_HUB yandex_maps (Ф1): четвёртый внешний канал. Яндекс.Карты —
     * geo-доступен из РФ без outbound-прокси (как DaData). Тонкий passthrough:
     *   - геокодер  → https://geocode-maps.yandex.ru (GET /1.x/?apikey&geocode)
     *   - маршрут   → https://api.routing.yandex.net (GET /v2/distancematrix)
     * Auth — `apikey` в query (НЕ Bearer). Ключ берётся: env > provider_settings
     * .kind='yandex_maps' (через UI Providers). Коннектор спит за enabled=false.
     */
    yandexMaps: z.object({
      enabled: booleanFromEnv(false),
      geocoderBaseUrl: z.string().default('https://geocode-maps.yandex.ru'),
      routerBaseUrl: z.string().default('https://api.routing.yandex.net'),
      apiKey: z.string().optional(),
      timeoutMs: numberFromEnv(15_000),
    }),
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
    requality: {
      enabled: env.REQUALITY_ENABLED,
      fallbackProviderId: env.REQUALITY_FALLBACK_PROVIDER_ID || '',
    },
    classifier: {
      filenameSignalWeight: env.FILENAME_SIGNAL_WEIGHT,
      filenameAgreeBoost: env.FILENAME_AGREE_BOOST,
      priorConfidentThreshold: env.CLASSIFY_PRIOR_CONFIDENT_THRESHOLD,
      llmTextChars: env.CLASSIFY_TEXT_CHARS,
      classifyTimeoutMs: env.CLASSIFY_TIMEOUT_MS,
      classifyReviewThreshold: env.CLASSIFY_REVIEW_THRESHOLD,
      segmentMinConf: env.SEGMENT_MIN_CONF,
      segmentTypedConf: env.SEGMENT_TYPED_CONF,
      segmentBoundaryFloor: env.SEGMENT_BOUNDARY_FLOOR,
      segmentHardBoundary: env.SEGMENT_HARD_BOUNDARY,
      multidocLlmClassify: env.MULTIDOC_LLM_CLASSIFY,
      classifyProviderId: env.CLASSIFY_PROVIDER_ID || '',
      segmentForcePageSplit: env.SEGMENT_FORCE_PAGE_SPLIT,
      vlmClassify: env.VLM_CLASSIFY,
    },
    tesseractLangs: env.TESSERACT_LANGS,
    officeImageFallback: {
      enabled: env.OFFICE_IMAGE_FALLBACK_ENABLED,
      minTextChars: env.OFFICE_MIN_TEXT_CHARS,
      minImageKb: env.OFFICE_IMAGE_MIN_KB,
      maxImages: env.OFFICE_IMAGE_MAX_COUNT,
      largeImageKb: env.OFFICE_IMAGE_LARGE_KB,
      imageDocMaxChars: env.OFFICE_IMAGE_DOC_MAX_CHARS,
    },
    llm: {
      url: env.LLM_INFERENCE_URL || undefined,
      apiKey: env.LLM_API_KEY || undefined,
      timeoutMs: env.LLM_TIMEOUT_MS,
    },
    asr: {
      enabled: env.ASR_ENABLED,
      timeoutMs: env.ASR_TIMEOUT_MS,
      confidenceDefault: env.ASR_CONFIDENCE_DEFAULT,
      language: env.ASR_LANGUAGE || undefined,
    },
    byoLlmEnabled: env.BYO_LLM_ENABLED,
    hybridRouting: {
      enabled: env.HYBRID_ROUTING_ENABLED,
      visionConfThreshold: env.HYBRID_VISION_CONF_THRESHOLD,
      visionProviderId: env.HYBRID_VISION_PROVIDER_ID || undefined,
      ocrVisionProviderId: env.OCR_VISION_PROVIDER_ID || undefined,
    },
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
      tableModel: env.YANDEX_TABLE_MODEL || undefined,
      tableModelTypes: env.YANDEX_TABLE_MODEL_TYPES,
      preferForScans: env.YANDEX_PREFER_FOR_SCANS,
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
    llmGateway: {
      enabled: env.LLM_GATEWAY_ENABLED,
      quotaEnabled: env.LLM_GATEWAY_QUOTA_ENABLED,
      backend: env.LLM_GATEWAY_BACKEND,
      baseUrl: env.LLM_GATEWAY_BASE_URL || undefined,
      apiKey: env.LLM_GATEWAY_API_KEY || env.ANTHROPIC_API_KEY || undefined,
      defaultAlias: env.LLM_GATEWAY_DEFAULT_ALIAS,
      models: env.LLM_GATEWAY_MODELS_JSON,
      timeoutMs: env.LLM_GATEWAY_TIMEOUT_MS,
      embeddings: {
        enabled: env.LLM_GATEWAY_EMBEDDINGS_ENABLED,
        provider: env.LLM_GATEWAY_EMBEDDINGS_PROVIDER,
        baseUrl: env.LLM_GATEWAY_EMBEDDINGS_BASE_URL,
        apiKey: env.LLM_GATEWAY_EMBEDDINGS_API_KEY || env.OPENAI_API_KEY || undefined,
        defaultAlias: env.LLM_GATEWAY_EMBEDDINGS_DEFAULT_ALIAS,
        models: env.LLM_GATEWAY_EMBEDDINGS_MODELS_JSON,
        timeoutMs: env.LLM_GATEWAY_EMBEDDINGS_TIMEOUT_MS,
      },
      dadata: {
        enabled: env.LLM_GATEWAY_DADATA_ENABLED,
        baseUrl: env.LLM_GATEWAY_DADATA_BASE_URL,
        apiKey: env.LLM_GATEWAY_DADATA_API_KEY || env.DADATA_API_KEY || undefined,
        timeoutMs: env.LLM_GATEWAY_DADATA_TIMEOUT_MS,
      },
      yandexMaps: {
        enabled: env.LLM_GATEWAY_YANDEX_ENABLED,
        geocoderBaseUrl: env.LLM_GATEWAY_YANDEX_GEOCODER_BASE_URL,
        routerBaseUrl: env.LLM_GATEWAY_YANDEX_ROUTER_BASE_URL,
        apiKey: env.LLM_GATEWAY_YANDEX_API_KEY || env.YANDEX_MAPS_API_KEY || undefined,
        timeoutMs: env.LLM_GATEWAY_YANDEX_TIMEOUT_MS,
      },
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

/**
 * H1: fail-closed cross-validation внешне-вызывающих флагов. Эти комбинации
 * «загружаются успешно», но гарантированно ломаются в рантайме или роняют
 * безопасность — лучше упасть на boot'е с понятным сообщением.
 *
 * Сейчас покрывает:
 *   - BYO LLM включён, но SECRETS_ENCRYPTION_KEY пустой → consumer-ключи
 *     шифровались бы insecure dev-default'ом (см. src/storage/secrets.ts:
 *     пустой ключ → deterministic SHA-256 от константы). В prod недопустимо.
 *   - ASR включён, но inference-endpoint (LLM_INFERENCE_URL → config.llm.url)
 *     не задан → все аудио-job'ы падали бы в рантайме ('ASR transcriber not
 *     configured'). Surface это на старте.
 *
 * Вызывается рядом с assertAuthConfigured() из server.ts main() и worker.ts.
 */
export function assertRuntimeConfig(
  cfg: Pick<Config, 'byoLlmEnabled' | 'secretsEncryptionKey' | 'asr' | 'llm'>,
): void {
  // «Insecure dev key» = пустой SECRETS_ENCRYPTION_KEY. secrets.ts при пустом
  // ключе использует deterministic dev-default (один и тот же у всех);
  // непустой невалидный ключ уже отбивается getMasterKey() (64-hex guard).
  if (cfg.byoLlmEnabled && cfg.secretsEncryptionKey.trim().length === 0) {
    throw new Error(
      'Refusing to start: BYO_LLM_ENABLED=true but SECRETS_ENCRYPTION_KEY is ' +
        'unset. Consumer LLM credentials would be encrypted with the insecure ' +
        'dev-default key. Set SECRETS_ENCRYPTION_KEY (openssl rand -hex 32).',
    );
  }

  if (cfg.asr.enabled && !cfg.llm.url) {
    throw new Error(
      'Refusing to start: ASR_ENABLED=true but LLM_INFERENCE_URL is unset. ' +
        'The ASR transcriber posts to <LLM_INFERENCE_URL>/v1/transcribe, so ' +
        'every audio job would fail at runtime. Set LLM_INFERENCE_URL.',
    );
  }
}

export const config = loadConfig();
