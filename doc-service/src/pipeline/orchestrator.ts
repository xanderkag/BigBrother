import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { config } from '../config.js';
import { jobsRepo } from '../storage/jobs.js';
import type { OcrEngine, OcrInput, OcrResult } from './ocr/types.js';
import { detectOcrRefusal, OcrRefusedError } from './ocr/refusal.js';
import { HttpAsrTranscriber, type AsrTranscriber } from './asr/transcribe.js';
import { isAudioMime } from './asr/mime.js';

const execP = promisify(exec);
import { PdfTextEngine } from './ocr/pdf-text.js';
import { TesseractEngine } from './ocr/tesseract.js';
import { VisionLlmEngine } from './ocr/vision-llm.js';
import { YandexVisionEngine } from './ocr/yandex.js';
import {
  isYandexVisionAllowed,
  recordYandexVisionPages,
  pagesSentFrom,
  resolveYandexVisionCredentials,
} from './ocr/yandex-gate.js';
import { XlsxEngine } from './ocr/xlsx.js';
import { DocxEngine } from './ocr/docx.js';
import { DocEngine } from './ocr/doc.js';
import { XmlEngine } from './ocr/xml.js';
import { selectOcrChain } from './router.js';
import {
  withJobLlmUsage,
  currentJobLlmUsage,
  isUsageComplete,
} from './llm/usage-context.js';
import { sanitizeText } from './text-sanitize.js';
import { KeywordClassifier } from './classifier/keywords.js';
import { LlmDocClassifier, type ClassificationMetadata } from './classifier/llm-classifier.js';
import { LlmPageClassifierAdapter } from './classifier/llm-page-adapter.js';
import type { Classifier } from './classifier/types.js';
import { classifyImageViaVlm } from './classifier/vlm-classify.js';
import { getCatalogForOrg } from './classifier/catalog.js';
import { correctSpecVsInvoice } from './classifier/spec-invoice-correction.js';
import { combineConfidence } from './quality.js';
import { assessQuality, countBusinessFields, type QualityFactor } from './quality-assessment.js';
import { ParsersFactory } from './parsers/index.js';
import { dynamicLlm } from './llm/provider-resolver.js';
import type { LlmClient, LlmExtractDebug } from './llm/types.js';
import type { DocumentTypeSlug } from '../types/documents.js';
import { validateExtractedWithResolver } from './validation/index.js';
import { runPostExtractNormalization } from './normalize/run.js';
import { deliverFinalizedJobWebhook } from './webhook-delivery.js';
import { documentTypeResolver, type ResolvedTypeConfig } from './document-type-resolver.js';
import {
  jobsDurationSeconds,
  jobsTotal,
  ocrEngineDurationSeconds,
  llmCredentialsSuppliedTotal,
  llmProviderErrorsTotal,
  forcedProviderFallthroughTotal,
} from '../metrics.js';
import {
  decryptInlineCredentials,
  classifyLlmError,
  INLINE_CREDS_METADATA_KEY,
} from './llm/inline-credentials.js';
import { runResolutionPipeline } from '../resolution/pipeline.js';
import { tryMultiDoc } from './multidoc/runner.js';
import { processFieldConfidence } from './normalize/field-confidence.js';
import { maskIdContentInRawText } from './normalize/id-raw-mask.js';
import { isIdDocument, buildIdSegmentExtract } from './normalize/id-allowlist.js';
import { splitCollapsedText } from './multidoc/collapsed-pages.js';
import { fileStorage } from '../storage/files.js';
import { organizationSettingsRepo } from '../storage/organization-settings.js';
import { DadataClient } from './enrich/dadata.js';
import { enrichWithDadata } from './enrich/index.js';
import {
  decideExtractPath,
  resolveVisionProviderId,
  type RouteReason,
} from './hybrid-router.js';

// --- Wire dependencies once at module load. The pipeline is stateless beyond this.
//
// LLM-клиент берём через resolver, который читает provider_settings из БД
// (с env-fallback). Это позволяет админу менять ключ/URL через UI без
// рестарта; resolver инкапсулирует TTL-кэш и lazy-инициализацию.
const llm: LlmClient = dynamicLlm;

const engines: readonly OcrEngine[] = [
  // XlsxEngine / DocxEngine / XmlEngine — специфичны по MIME (xls/xlsx, docx,
  // xml). Router выберет ТОЛЬКО их для этих MIME-types, остальные engines
  // вернут supports()==false. Идут текстовым путём, БЕЗ OCR/vision/cascade.
  // Ставим первыми для cache-locality.
  new XlsxEngine(),
  new DocxEngine((imagePath) => dynamicLlm.withVisionProvider(() => llm.visionOcr({ imagePath }))),
  // DocEngine — legacy .doc (x-cfb + .doc extension) через catdoc. Идёт после
  // XlsxEngine: оба видят x-cfb, но supports() разводит по расширению файла.
  new DocEngine(),
  new XmlEngine(),
  new PdfTextEngine(config.thresholds.pdfText),
  new TesseractEngine(config.thresholds.tesseract, config.tesseractLangs),
  new VisionLlmEngine(config.thresholds.visionLlm, llm, (fn) => dynamicLlm.withVisionProvider(fn)),
  new YandexVisionEngine(config.yandex),
];

const classifier = new KeywordClassifier();
// Production LLM classifier — прогоняется на КАЖДОМ документе поверх keyword
// prior'а. keyword остаётся PRIOR и FALLBACK. См. classifier/llm-classifier.ts.
const llmDocClassifier = new LlmDocClassifier(classifier, llm);

/**
 * Валидация slug'а по каталогу: тип существует и активен для орг. Резолвер уже
 * кэширует listActiveForOrg — проверяем принадлежность к активному набору
 * (тот же набор, что попал в каталог классификации). F22-алиасы учитываем
 * через resolveConfig.get() как fallback (SLAI-нейминг).
 */
async function makeCatalogSlugValidator(
  orgId: string | null,
): Promise<(slug: string) => Promise<boolean>> {
  const active = await documentTypeResolver.listActiveForOrg(orgId);
  const activeSet = new Set(active.map((r) => r.slug));
  return async (slug: string) => {
    if (activeSet.has(slug)) return true;
    // F22: LLM мог вернуть SLAI-alias/регистр-вариант — резолвер расширит.
    const row = await documentTypeResolver.get(slug);
    return row !== null && row.is_active === true;
  };
}

const dadataClient = new DadataClient(config.dadata);

// ASR transcriber — «OCR for audio». Аудио-вход транскрибируется через
// inference-service /v1/transcribe, затем результат идёт в тот же downstream
// pipeline. Endpoint = тот же LLM_INFERENCE_URL; модель настраивается на
// стороне inference-service (model-agnostic, без ключа).
const asrTranscriber: AsrTranscriber = new HttpAsrTranscriber({
  baseUrl: config.llm.url,
  apiKey: config.llm.apiKey,
  timeoutMs: config.asr.timeoutMs,
  confidenceDefault: config.asr.confidenceDefault,
  language: config.asr.language,
});
const parsersFactory = new ParsersFactory(llm, {
  regexFallbackThreshold: config.thresholds.regexFallback,
  multipass: config.multipass,
});

/** Combined output of the full file → structured data run. */
export type PipelineRunResult = {
  ocr: OcrResult;
  documentType: DocumentTypeSlug | null;
  classificationSource: 'hint' | 'keyword';
  classificationMatch?: string;
  extracted: Record<string, unknown>;
  parserConfidence?: number;
  parserMissing: string[];
  overallConfidence: number;
};

/**
 * Per-step timings, накапливаются в течение processJob'а.
 * Используются для (а) bottleneck-определения в slow-job warning,
 * (б) для сводного `job completed` события в лог-агрегатор.
 */
type StepTimings = {
  ocr_ms: number;
  classify_ms: number;
  extract_ms: number;
  validate_ms: number;
};

function pickBottleneck(t: StepTimings): keyof StepTimings {
  let best: keyof StepTimings = 'ocr_ms';
  let bestVal = t.ocr_ms;
  (['classify_ms', 'extract_ms', 'validate_ms'] as const).forEach((k) => {
    if (t[k] > bestVal) {
      best = k;
      bestVal = t[k];
    }
  });
  return best;
}

function roundConf(c: number | null | undefined): number | null {
  if (c === null || c === undefined) return null;
  return Math.round(c * 1000) / 1000;
}

/**
 * Process a job end-to-end. Called from the BullMQ worker.
 *
 * Thin wrapper around the pure pipeline functions: pulls input from DB,
 * runs OCR + post-OCR pipeline, persists result, fires webhook. The two
 * pure functions (`runOcrChain`, `runDocumentPipeline`) are exported so
 * the smoke CLI and integration tests can reuse them without DB plumbing.
 */
/**
 * Обёртка учёта токенов. Внутри контекста `HttpLlmClient.post` складывает
 * `usage` КАЖДОГО ответа inference-service — включая чанки multipass, которые
 * идут с includeDebug:false и раньше не приносили расход вовсе. Итог пишется в
 * `jobs.llm_usage` на обоих путях finalize (успех и падение).
 */
export async function processJob(
  jobId: string,
  log: Logger,
  opts: { attempt?: number } = {},
): Promise<void> {
  const { usage } = await withJobLlmUsage(() => processJobBody(jobId, log, opts));
  log.info(
    {
      job_id: jobId,
      llm_calls: usage.calls,
      prompt_tokens: usage.prompt_tokens,
      output_tokens: usage.output_tokens,
      // > 0 → суммы неполны (stub/qwen_vl не сообщают usage), и любая
      // производная ₽/док по этой джобе — нижняя граница.
      calls_without_usage: usage.calls_without_usage,
      usage_complete: isUsageComplete(usage),
    },
    'job llm usage',
  );
}

async function processJobBody(
  jobId: string,
  log: Logger,
  opts: { attempt?: number } = {},
): Promise<void> {
  const job = await jobsRepo.findById(jobId);
  if (!job) {
    log.error({ jobId }, 'job not found');
    return;
  }

  await jobsRepo.markProcessing(jobId);

  const meta = (job.metadata as Record<string, unknown> | null | undefined) ?? null;

  // EXT-B (Q11): BYO inline LLM credentials. Зашифрованный envelope лежит в
  // metadata._inline_llm_creds (route положил его туда secrets-envelope'ом).
  // Расшифровываем ТОЛЬКО здесь, в hot-path воркера, в локальную переменную —
  // ключ никуда не пишется, не логируется и не уходит дальше HttpLlmClient'а.
  // Приоритетнее force_provider и default-провайдера.
  const inlineCreds = decryptInlineCredentials(meta?.[INLINE_CREDS_METADATA_KEY]);
  if (inlineCreds) {
    // Лог только факт + provider (без ключа). Метрика supplied — by provider.
    log.info({ jobId, byo_provider: inlineCreds.provider }, 'using BYO LLM credentials for this job');
    llmCredentialsSuppliedTotal.inc({ provider: inlineCreds.provider });
    return dynamicLlm.withInlineCredentials(inlineCreds, () =>
      processJobInner(job, jobId, log, opts).catch((err: unknown) => {
        // Грубый, редактированный код — никогда не текст ошибки целиком.
        llmProviderErrorsTotal.inc({
          provider: inlineCreds.provider,
          code: classifyLlmError(err),
        });
        throw err;
      }),
    );
  }

  // Per-job force_provider override: пользователь мог при загрузке выбрать
  // конкретного LLM-провайдера через UI Upload (передаётся как
  // `metadata._force_provider_id`). Если задан — оборачиваем всю обработку
  // в withForceProvider, который через AsyncLocalStorage заставит все вызовы
  // dynamicLlm внутри pipeline резолвиться к этому провайдеру.
  const forceProviderId = meta?.['_force_provider_id'];
  if (typeof forceProviderId === 'string' && forceProviderId.length > 0) {
    log.info({ jobId, force_provider: forceProviderId }, 'using forced LLM provider for this job');
    // Observability (TECH_DEBT M3): плохой forced-provider id молча откатывается
    // на default внутри delegate(). Пробуем резолв заранее — если не выйдет,
    // логируем warn + инкрементим counter (routing НЕ меняем, реальный fallthrough
    // делает withForceProvider как и раньше).
    const fallthrough = await dynamicLlm.probeForceProvider(forceProviderId);
    if (fallthrough) {
      log.warn(
        { jobId, force_provider: forceProviderId, reason: fallthrough },
        'forced LLM provider did not resolve; falling through to default provider',
      );
      forcedProviderFallthroughTotal.inc({ reason: fallthrough });
    }
    return dynamicLlm.withForceProvider(forceProviderId, () => processJobInner(job, jobId, log, opts));
  }
  return processJobInner(job, jobId, log, opts);
}

/**
 * Внутренняя реализация обработки job — вынесена чтобы можно было обернуть
 * её в withForceProvider() для per-job LLM override. См. processJob выше.
 */
async function processJobInner(
  job: NonNullable<Awaited<ReturnType<typeof jobsRepo.findById>>>,
  jobId: string,
  log: Logger,
  opts: { attempt?: number } = {},
): Promise<void> {
  // Локальный helper для пайплайн-событий: best-effort, исключения глушим.
  // Цель — observability, ронять обработку из-за лога нельзя.
  const stepEvent = async (
    step: string,
    status: 'started' | 'done' | 'failed' | 'skipped',
    extras?: { duration_ms?: number; details?: Record<string, unknown> },
  ): Promise<void> => {
    try {
      await jobsRepo.appendPipelineStep(jobId, {
        step, status,
        at: new Date().toISOString(),
        ...extras,
      });
    } catch (err) {
      log.warn({ jobId, step, status, err }, 'failed to record pipeline step (non-fatal)');
    }
  };

  let ocr: OcrResult | null = null;
  let documentType: DocumentTypeSlug | null = job.document_hint ?? null;

  // Phase 3 (CP7): per-org consumer profile. Грузим один раз. Дефолт-профиль
  // (extract / pull / no secret) возвращается когда орг нет или строки нет —
  // тогда поведение в точности как до Phase 3 (backwards compat).
  const profile = await organizationSettingsRepo.get(job.organization_id);
  const classifyOnly = profile.mode === 'classify_only';

  // Per-step timings — для bottleneck-определения и сводного `job completed`.
  const timings: StepTimings = { ocr_ms: 0, classify_ms: 0, extract_ms: 0, validate_ms: 0 };

  // Metrics: end-to-end timer. `started` is "worker pickup" — close enough
  // to user-perceived latency for a fire-and-forget API. Label values are
  // resolved at finalize time (we don't know status/type up front).
  const startedAt = Date.now();

  // item A: cleanup-хэндлы (materialized-файл + tmp first-page PNG). Хоистим
  // наружу try, чтобы outer catch тоже мог почистить при ошибке между OCR и
  // parse (refusal / multidoc). Идемпотентны — повторный вызов безопасен.
  let cleanupArtifacts: () => Promise<void> = async () => {};

  try {
    // ── OCR ────────────────────────────────────────────────────────────────
    // I8: per-job PII opt-out из metadata._disable_external_ocr. document_hint
    // используется как ранний намёк на тип документа (для PII-фильтрации даже
    // до классификации).
    const metaForRouter = (job.metadata as Record<string, unknown> | null) ?? {};
    const disableExternalOcr =
      metaForRouter._disable_external_ocr === true ||
      metaForRouter._disable_external_ocr === 'true';
    // F26: per-job override Tesseract languages. Если metadata.tesseract_langs
    // содержит "rus+eng+chi_sim" — этот язык-pack будет использован вместо
    // env-default. Допустимые языки определяются установленными в Docker
    // tessdata packs (см. Dockerfile: rus/eng/chi_sim/tur/pol).
    const tesseractLangsOverride =
      typeof metaForRouter.tesseract_langs === 'string' && metaForRouter.tesseract_langs.length > 0
        ? (metaForRouter.tesseract_langs as string)
        : undefined;
    // Per-job override модели Yandex OCR (metadata._yandex_ocr_model). Побеждает
    // env-default и per-type tableModel. Применяется только если Yandex в цепочке.
    const yandexModelOverride =
      typeof metaForRouter._yandex_ocr_model === 'string' && metaForRouter._yandex_ocr_model.length > 0
        ? (metaForRouter._yandex_ocr_model as string)
        : undefined;
    // F20: per-job override LLM-промпта (см. runDocumentPipeline.options.promptOverride)
    const promptOverride =
      typeof metaForRouter.prompt_override === 'string' && metaForRouter.prompt_override.length > 0
        ? (metaForRouter.prompt_override as string)
        : undefined;
    // item A: metadata._extract_from_image=true форсирует image-extract даже
    // на не-vision провайдере. Без флага — решение по provider.vision.
    const forceExtractFromImage =
      metaForRouter._extract_from_image === true ||
      metaForRouter._extract_from_image === 'true';
    // Hybrid-routing (SLAI #3): metadata._extract_from_text=true форсирует
    // быстрый text-путь даже если роутер выбрал бы vision (оператор знает,
    // что документ — чистый текст). Старше forceImage в decideExtractPath.
    const forceExtractFromText =
      metaForRouter._extract_from_text === true ||
      metaForRouter._extract_from_text === 'true';
    const isImageInput = job.mime_type.startsWith('image/');

    await stepEvent(isAudioMime(job.mime_type) ? 'transcribe' : 'ocr', 'started', {
      details: { mime: job.mime_type },
    });
    const ocrStart = Date.now();
    // A2: для S3-backend'а materialize стримит в tmp если локальный кэш
    // протух (worker в другом pod'е). Для local — возвращает оригинал,
    // cleanup — no-op. Держим materialized живым до конца pipeline (parse
    // тоже может ему понадобиться для image-extract); cleanup — в finally.
    const materialized = await fileStorage.materialize(job.file_path);
    // item A: image первой страницы готовим один раз; cleanup вместе с
    // materialized. Подготовка — fail-soft (вернёт undefined при проблемах).
    let firstPageImage: { imagePath: string | undefined; cleanup: () => Promise<void> } = {
      imagePath: undefined,
      cleanup: async () => {},
    };
    let cleanedUp = false;
    cleanupArtifacts = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await firstPageImage.cleanup().catch(() => undefined);
      await materialized.cleanup().catch(() => undefined);
    };
    const audioInput = isAudioMime(job.mime_type);
    try {
      if (audioInput) {
        // ── ASR path (audio → text) ────────────────────────────────────────
        // Транскрибируем аудио в текст вместо OCR-цепочки; дальше пайплайн
        // (classify → extract → validate → webhook) не отличается. Записываем
        // отдельный pipeline-шаг `transcribe`. Гейтится config.asr.enabled на
        // route'е (загрузка), но страхуемся и тут — fail с понятной ошибкой.
        if (!config.asr.enabled || !asrTranscriber.isAvailable()) {
          throw new Error(
            'audio input received but ASR is not enabled/configured (ASR_ENABLED + LLM_INFERENCE_URL)',
          );
        }
        const t = await asrTranscriber.transcribe({
          filePath: materialized.absolutePath,
          mimeType: job.mime_type,
        });
        ocr = {
          engine: 'transcribe',
          text: t.text,
          confidence: t.confidence,
          durationMs: t.durationMs,
        };
        // image-extract для аудио бессмысленен — firstPageImage остаётся noop.
      } else {
        ocr = await runOcrChain(
          {
            filePath: materialized.absolutePath,
            mimeType: job.mime_type,
            tesseractLangsOverride,
            yandexModelOverride,
          },
          log,
          {
            documentType: job.document_hint ?? undefined,
            disableExternalOcr,
          },
        );
        firstPageImage = await prepareFirstPageImage(
          materialized.absolutePath,
          job.mime_type,
          log,
        );
      }
    } catch (err) {
      await cleanupArtifacts();
      throw err;
    }
    timings.ocr_ms = Date.now() - ocrStart;
    // P0 (2026-05-20): убираем NUL/control-байты из OCR-текста до того, как он
    // уйдёт в classifier, LLM /extract и DB. Иначе finalize падает на
    // "invalid byte sequence for encoding UTF8: 0x00". Чистим один раз здесь —
    // дальше по пайплайну текст уже безопасен.
    ocr.text = sanitizeText(ocr.text);
    await stepEvent(ocr.engine === 'transcribe' ? 'transcribe' : `ocr.${ocr.engine}`, 'done', {
      duration_ms: timings.ocr_ms,
      details: { confidence: roundConf(ocr.confidence), text_length: ocr.text.length },
    });

    // ── OCR refusal detection ──────────────────────────────────────────────
    // Real-case 2026-05-18: на VED-кейсе eac-cert.pdf (скан-сертификат без
    // текстового слоя) vision-LLM вернул 4× «Извините, я не могу
    // просматривать изображения». Pipeline принял это за валидный OCR-output,
    // classifier нашёл NULL, job завершился со status='done' и пустым типом.
    // Это «тихий провал». Детектируем и валим job явно — оператор сразу
    // видит причину и решает: переснять документ / попробовать другой OCR /
    // ручной разбор.
    const refusal = detectOcrRefusal(ocr.text);
    if (refusal.isRefusal) {
      log.warn(
        { jobId, engine: ocr.engine, coverage: refusal.coverage, preview: refusal.preview },
        'OCR engine returned refusal sentence — bailing out',
      );
      await stepEvent('ocr.refusal', 'failed', {
        details: {
          engine: ocr.engine,
          coverage_percent: Math.round((refusal.coverage ?? 0) * 100),
          preview: refusal.preview,
          pattern: refusal.pattern,
        },
      });
      throw new OcrRefusedError(ocr.engine, refusal);
    }

    // ── F5 Multi-doc detection (xlsx multi-sheet, MVP) ──────────────────
    // Если OCR engine выдал множество страниц (xlsx с несколькими sheets'ами),
    // классифицируем каждую отдельно. Если sheets имеют разные types →
    // запускаем per-segment extract pipeline. Иначе fall back на обычный
    // single-doc. Полный PDF F5 (per-page raster + classify) — отдельный
    // sprint, нужен page-level OCR.
    // Phase 3 (CP7): в classify_only мульти-doc extract не запускаем вовсе
    // (per-segment extract — это как раз LLM-стадия, которую потребитель
    // явно не хочет). Single-doc classify ниже всё равно даст primary type.
    // §P0-0: если многостраничный скан склеился в 1 blob (pages≤1) — по флагу
    // SEGMENT_FORCE_PAGE_SPLIT восстанавливаем постраничность из текста, чтобы
    // сегментация запустилась. Иначе mdOcr === ocr (поведение не меняется).
    let mdOcr = ocr;
    if (config.classifier.segmentForcePageSplit && (!ocr.pages || ocr.pages.length <= 1)) {
      const pseudo = splitCollapsedText(ocr.text);
      if (pseudo.length >= 2) {
        const conf = ocr.confidence;
        mdOcr = { ...ocr, pages: pseudo.map((t) => ({ text: t, confidence: conf })) };
        log.info({ jobId, pseudoPages: pseudo.length }, '§P0-0: восстановлена постраничность склеенного скана');
      }
    }

    let multiDocResult: Awaited<ReturnType<typeof tryMultiDoc>> = null;
    if (!classifyOnly && mdOcr.pages && mdOcr.pages.length > 1) {
      // §P0-1: per-page классификатор. По умолчанию keyword (границы уже
      // типизируют boundary-страницы). За флагом MULTIDOC_LLM_CLASSIFY —
      // LLM-catalog адаптер для безъякорных иноязычных страниц.
      let pageClassifier: Classifier = classifier;
      if (config.classifier.multidocLlmClassify) {
        const isCatalogSlug = await makeCatalogSlugValidator(job.organization_id);
        // §P2-3: если CLASSIFY_PROVIDER_ID выставлен — per-page classify идёт
        // на A/B-провайдер через forceProvider; иначе default (no-op).
        const forcedId = config.classifier.classifyProviderId;
        const wrapProvider = forcedId
          ? <T>(fn: () => Promise<T>) => dynamicLlm.withForceProvider(forcedId, fn)
          : undefined;
        pageClassifier = new LlmPageClassifierAdapter(
          llmDocClassifier,
          isCatalogSlug,
          log,
          wrapProvider,
        );
      }
      // §FIX-1: VLM по картинке для скудных ХВОСТОВЫХ страниц (бледная СТС,
      // чей OCR-текст якорь не поймал). Рендерим страницу PDF по требованию →
      // classifyImageViaVlm через vision-провайдер (на asha направлен на Yandex
      // per «все картинки через Yandex»). Гейт VLM_CLASSIFY; только для PDF.
      let classifyPageImage: ((pageNo: number) => Promise<string | null>) | undefined;
      if (config.classifier.vlmClassify && job.mime_type === 'application/pdf') {
        const { text: vlmCatalog } = await getCatalogForOrg(job.organization_id);
        if (vlmCatalog) {
          const isCatalogSlug = await makeCatalogSlugValidator(job.organization_id);
          classifyPageImage = async (pageNo: number): Promise<string | null> => {
            const rendered = await prepareFirstPageImage(
              materialized.absolutePath,
              job.mime_type,
              log,
              pageNo,
            );
            if (!rendered.imagePath) return null;
            try {
              return await classifyImageViaVlm(
                rendered.imagePath,
                vlmCatalog,
                {
                  visionOcr: (i) => llm.visionOcr(i),
                  isCatalogSlug,
                  withVisionProvider: (fn) => dynamicLlm.withVisionProvider(fn),
                },
                log,
              );
            } finally {
              await rendered.cleanup();
            }
          };
        }
      }

      multiDocResult = await tryMultiDoc(mdOcr, {
        classifier: pageClassifier,
        classifyPageImage,
        organizationId: job.organization_id,
        extractSegment: async (text, type, segLog) => {
          // §8.5b (ПДн-блокер): паспорт/ID-сегмент НЕ отправляем в LLM (тем
          // более облачный). Extract строим детерминированно из MRZ по
          // allowlist {doc_kind,country,present} — персональные поля не
          // извлекаются, паспортный текст не покидает контур.
          if (isIdDocument(type, null)) {
            segLog.info({ jobId, segment: type }, '§8.5b: ID-сегмент — extract без LLM (allowlist из MRZ)');
            return { extracted: buildIdSegmentExtract(text), fieldConfidence: {} };
          }
          const segPipeline = await runDocumentPipeline(
            text,
            { hint: type, promptOverride, organizationId: job.organization_id },
            segLog,
            { jobId, segment: type },
          );
          const fcResult = processFieldConfidence(segPipeline.extracted);
          return {
            extracted: fcResult.cleanedExtracted,
            fieldConfidence: fcResult.fieldConfidence,
          };
        },
        log,
      });
      if (multiDocResult) {
        await stepEvent('multidoc.detected', 'done', {
          details: {
            sheets: mdOcr.pages.length,
            segments: multiDocResult.length,
            types: multiDocResult.map((d) => d.document_type),
          },
        });
      }
    }

    // ── Classify + Parse + Validate (внутри runDocumentPipeline) ───────────
    // Мы не лезем во внутренности runDocumentPipeline (это shared smoke/test
    // surface), а пишем агрегированный шаг "pipeline" с timing'ом каждой
    // фазы из вернувшегося timings объекта. Подробности — в details.
    //
    // F5: даже при multi-doc запускаем full pipeline один раз — это даст
    // primary document_type + extracted для job row (backwards compat).
    // documents[] из multi-doc идёт в extracted._multidoc_documents и
    // потом в webhook payload.documents.
    const post = await runDocumentPipeline(
      ocr.text,
      {
        hint: documentType ?? undefined,
        promptOverride,
        organizationId: job.organization_id,
        fileName: job.file_name,
        classifyOnly,
        imagePath: firstPageImage.imagePath,
        forceExtractFromImage,
        // Hybrid-routing (SLAI #3). Гейтится HYBRID_ROUTING_ENABLED — при
        // выключенном флаге pipeline игнорирует hybrid и ведёт себя как раньше.
        hybrid: config.hybridRouting.enabled
          ? {
              ocrEngine: ocr.engine,
              ocrConfidence: ocr.confidence,
              textLength: ocr.text.length,
              pageCount: ocr.pages?.length ?? 1,
              isImageInput,
              forceImage: forceExtractFromImage,
              forceText: forceExtractFromText,
              visionConfThreshold: config.hybridRouting.visionConfThreshold,
              visionProviderId: config.hybridRouting.visionProviderId,
            }
          : undefined,
      },
      log,
      { jobId },
      timings,
    );
    // §P2-2: VLM-фолбэк по изображению для плохих фото. Если text-классификатор
    // не определил тип И текста мало И есть картинка — спрашиваем локальную
    // vision-модель. ДО cleanupArtifacts (картинка ещё на диске). Гейтится
    // VLM_CLASSIFY (default off). Паспорт → downstream allowlist/§8.5b всё
    // равно не дадут извлечь ПДн; vision локальный, не облако.
    if (
      config.classifier.vlmClassify &&
      !classifyOnly &&
      !post.documentType &&
      firstPageImage.imagePath &&
      ocr.text.trim().length < 200
    ) {
      const { text: catalog } = await getCatalogForOrg(job.organization_id);
      if (catalog) {
        const isCatalogSlug = await makeCatalogSlugValidator(job.organization_id);
        const vlmSlug = await classifyImageViaVlm(
          firstPageImage.imagePath,
          catalog,
          {
            visionOcr: (i) => llm.visionOcr(i),
            isCatalogSlug,
            withVisionProvider: (fn) => dynamicLlm.withVisionProvider(fn),
          },
          log,
        );
        if (vlmSlug) {
          post.documentType = vlmSlug as typeof post.documentType;
          if (post.classification) {
            post.classification.type = vlmSlug as typeof post.classification.type;
            post.classification.unknown = false;
            post.classification.method = 'vlm';
          }
          log.info({ jobId, vlmSlug }, '§P2-2: тип определён по изображению (VLM)');
        }
      }
    }

    // item A: image первой страницы больше не нужен (parse завершён) — чистим
    // tmp PNG + materialized-файл сразу. Не ждём конца processJob.
    await cleanupArtifacts();
    documentType = post.documentType;
    // Production LLM classifier: персистим метаданные классификации в
    // jobs.classification (для UI). Общий helper для воркера и reprocess-route.
    await persistClassification(jobId, post.classification, log);
    await stepEvent('classify', 'done', {
      duration_ms: timings.classify_ms,
      details: {
        document_type: documentType,
        source: post.classificationSource,
        method: post.classification?.method ?? null,
        llm_said: post.classification?.llm_said ?? null,
        keyword_said: post.classification?.keyword_said?.type ?? null,
        classify_llm_duration_ms: post.classification?.duration_ms ?? null,
        unknown: post.classification?.unknown ?? false,
      },
    });
    if (classifyOnly) {
      // Phase 3 (CP7): extract-стадия пропущена по профилю потребителя.
      await stepEvent('parse', 'skipped', {
        details: { reason: 'profile.mode=classify_only' },
      });
    } else {
      await stepEvent('parse', 'done', {
        duration_ms: timings.extract_ms,
        details: {
          parser_kind: post.typeConfig?.parserKind ?? 'default',
          confidence: roundConf(post.parserConfidence),
          missing: post.parserMissing,
          llm_called: !!post.llmCall,
          // item A: видимость в job detail — extract шёл по картинке или тексту.
          extract_mode: post.extractMode ?? 'text',
          // Hybrid-routing (SLAI #3): почему выбран этот путь (debug в job detail).
          // undefined когда hybrid выключен — поле просто не пишется.
          route_reason: post.routeReason,
        },
      });
    }
    await stepEvent('validate', post.validationIssues.length > 0 ? 'done' : 'done', {
      duration_ms: timings.validate_ms,
      details: { issues_count: post.validationIssues.length },
    });

    // ── Enrich (DaData party-by-INN) ───────────────────────────────────────
    // Additive обогащение extracted официальной карточкой ЕГРЮЛ по ИНН.
    // Гейтится per-consumer профилем (profile.enrich_enabled) И доступностью
    // DaData (DADATA_API_KEY). Fail-soft: НИКОГДА не роняет job. Кладёт
    // результат в extracted._enrichment, который relay'ится через webhook.
    // Не запускаем в classify_only (extracted пустой — нечего обогащать).
    if (!classifyOnly && profile.enrich_enabled && (await dadataClient.isAvailable())) {
      const enrichStart = Date.now();
      try {
        const result = await enrichWithDadata(
          post.extracted,
          dadataClient,
          config.dadata.cacheTtlMs,
          log,
        );
        post.extracted = result.extracted;
        await stepEvent('enrich', result.ok ? 'done' : 'failed', {
          duration_ms: Date.now() - enrichStart,
          details: { provider: 'dadata', lookups: result.lookups },
        });
      } catch (err) {
        // enrichWithDadata уже не бросает, но страхуемся — стадия не блокирует job.
        log.warn({ jobId, err }, 'enrich stage error (non-fatal)');
        await stepEvent('enrich', 'failed', {
          duration_ms: Date.now() - enrichStart,
          details: { error: String((err as Error)?.message ?? err) },
        });
      }
    } else if (!classifyOnly) {
      await stepEvent('enrich', 'skipped', {
        details: {
          reason: !profile.enrich_enabled ? 'profile.enrich_enabled=false' : 'dadata_unavailable',
        },
      });
    }

    const overall = combineConfidence(ocr.confidence, post.parserConfidence);

    // needs_review threshold precedence (most specific wins):
    //   1. per-type document_types.confidence_threshold — админ выставил
    //      его сознательно для конкретного типа (контракты всегда review,
    //      low-stakes invoices auto-pass).
    //   2. profile.auto_approve_threshold — уровень доверия потребителя
    //      (per-org override глобального дефолта).
    //   3. config.thresholds.needsReview — глобальный env-default.
    // В classify_only extract/validation нет — overall = OCR/classification
    // confidence, и статус решается им же против этого порога.
    const confidenceThreshold =
      post.typeConfig?.confidenceThreshold ??
      profile.auto_approve_threshold ??
      config.thresholds.needsReview;

    // A document with hard validation failures (e.g., INN checksum mismatch)
    // should always be reviewed by a human, regardless of OCR confidence.
    const lowConfidence = overall < confidenceThreshold;
    const hasIssues = post.validationIssues.length > 0;

    // Persist issues alongside the structured data. `_issues` is a reserved
    // key inside extracted; `toApi` lifts it back into a top-level field.
    // Strip any pre-existing `_issues` (e.g., if an LLM accidentally emitted
    // one in /extract output) — domain validation here is authoritative.
    const { _issues: _ignore, ...extractedClean } = post.extracted as {
      _issues?: unknown;
    } & Record<string, unknown>;

    // Empty-extract safety-net: когда auto-requality ВЫКЛЮЧЕН
    // (config.requality.enabled=false), assessQuality в runDocumentPipeline не
    // запускался → requalityFactors пуст. Ловим «уверенно 0 полей» здесь, чтобы
    // пустой разбор всё равно ушёл в needs_review, а не притворился готовым.
    // Когда requality ВКЛЮЧЁН, фактор `empty_extract` уже добавлен через
    // requalityFactors (см. runDocumentPipeline перед return) — не дублируем.
    const emptyExtraction =
      countBusinessFields(extractedClean) === 0 && !classifyOnly && !config.requality.enabled;
    if (emptyExtraction) {
      log.warn(
        { jobId, overall_confidence: overall, document_type: post.documentType },
        'extract returned 0 business fields (requality disabled) — routing to needs_review',
      );
      post.validationIssues.push(
        'extract_empty: модель вернула 0 бизнес-полей (возможен reasoning-bleed vision-модели или обрезка контекста)',
      );
    }

    // Classify-uncertainty gate: уверенность классификации раньше НЕ влияла на
    // needs_review (в overall только OCR+extract). Итог: уверенно-неверный тип
    // (синтетические 0.9) проходил как `done`, а null-тип при включённом
    // requality мог финализироваться пустым. Теперь низкая уверенность типа ИЛИ
    // «не опознан» → на ревью. hint (оператор задал тип вручную) не гейтим.
    // Гейт работает и в classify_only (там классификация — сам выхлоп, потому
    // не исключаем этот режим, в отличие от empty-extract guard выше).
    const classifyConfidence = post.classification?.confidence ?? 1;
    if (
      post.classification?.method !== 'hint' &&
      (post.documentType === null ||
        classifyConfidence < config.classifier.classifyReviewThreshold)
    ) {
      const why =
        post.documentType === null
          ? 'тип не опознан'
          : `тип «${post.documentType}» определён с низкой уверенностью (${classifyConfidence})`;
      log.info(
        { jobId, classify_confidence: classifyConfidence, method: post.classification?.method, type: post.documentType },
        'classification uncertain — routing to needs_review',
      );
      post.validationIssues.push(`classify_uncertain: ${why} — проверьте тип документа`);
    }

    const status: 'done' | 'needs_review' =
      lowConfidence || post.validationIssues.length > 0 || emptyExtraction
        ? 'needs_review'
        : 'done';

    if (hasIssues) {
      log.info({ jobId, issues: post.validationIssues }, 'validation issues detected');
    }
    const extractedToStore: Record<string, unknown> = { ...extractedClean };
    if (post.validationIssues.length > 0) {
      extractedToStore._issues = post.validationIssues;
    }
    // F5: если нашли multi-doc — сохраняем массив всех найденных документов
    // в служебном поле. Webhook delivery подхватит его как payload.documents.
    // Primary doc (для job.extracted) — это single-doc pipeline result выше,
    // обеспечивает backwards compatibility для receiver'ов которые читают
    // только extracted.
    if (multiDocResult && multiDocResult.length > 0) {
      extractedToStore._multidoc_documents = multiDocResult;
    }

    const updated = await jobsRepo.finalize(jobId, {
      status,
      llmUsage: currentJobLlmUsage(),
      documentType,
      ocrEngine: ocr.engine,
      // §8.1 (ПДн-блокер): маскируем паспортные/ID-страницы в raw_text до
      // персиста — иначе MRZ/ФИО/номер сохранятся в jobs.raw_text и уйдут
      // наружу (GET /jobs/:id/raw_text, reprocess). Для не-ID доков no-op.
      rawText: maskIdContentInRawText(ocr.text, ocr.pages, documentType, multiDocResult),
      confidence: overall,
      llmCall: post.llmCall ?? null,
      extracted: extractedToStore,
      error: null,
    });
    await stepEvent('finalize', 'done', {
      duration_ms: Date.now() - startedAt,
      details: { status, confidence: roundConf(overall), issues_count: post.validationIssues.length },
    });

    // Metrics: terminal counter + duration histogram. `document_type` may
    // be null (unclassified) — coerce to a stable label value to keep
    // cardinality bounded and avoid leaking "undefined" buckets.
    const dtLabel = documentType ?? 'unknown';
    const totalDurationMs = Date.now() - startedAt;
    jobsTotal.inc({ status, document_type: dtLabel });
    jobsDurationSeconds.observe(
      { document_type: dtLabel, outcome: status },
      totalDurationMs / 1000,
    );

    // Single rich событие — каждое поле полезно для log-агрегатора (Loki/
    // Datadog/...): построить гистограмму latency по типу документа,
    // алертить на confidence-деградацию, видеть когда модель сменилась.
    log.info(
      {
        job_id: jobId,
        status,
        document_type: dtLabel,
        ocr_engine: ocr.engine,
        confidence: roundConf(overall),
        validation_issues_count: post.validationIssues.length,
        total_duration_ms: totalDurationMs,
        ocr_duration_ms: timings.ocr_ms,
        classify_duration_ms: timings.classify_ms,
        extract_duration_ms: timings.extract_ms,
        validate_duration_ms: timings.validate_ms,
        file_size_bytes: Number(job.file_size),
        mime_type: job.mime_type,
        attempt: opts.attempt ?? 1,
        llm_called: !!post.llmCall,
        llm_provider: post.llmCall?.backend ?? null,
        llm_model: post.llmCall?.model ?? null,
        llm_duration_ms: post.llmCall?.duration_ms ?? null,
        prompt_tokens: post.llmCall?.prompt_tokens ?? null,
        output_tokens: post.llmCall?.output_tokens ?? null,
      },
      'job completed',
    );

    // Slow-job: ищем bottleneck-шаг (макс из per-step timing'а) и пишем
    // warn'кой. Алерт-правило в Grafana / Datadog ловит по level=warn +
    // msg='slow job', тегирует bottleneck-полем.
    if (totalDurationMs > config.slowJobThresholdMs) {
      const bottleneck = pickBottleneck(timings);
      log.warn(
        {
          job_id: jobId,
          total_duration_ms: totalDurationMs,
          threshold_ms: config.slowJobThresholdMs,
          bottleneck,
          ...timings,
        },
        'slow job',
      );
    }

    // Resolution phase: привязка к справочникам и матчинг номенклатуры.
    // Запускается после finalize() — результат не влияет на основной статус
    // (только resolution может дополнительно перевести в needs_review если
    // on_not_found='needs_review' и сущность не найдена).
    // Ошибки здесь не бросаются наружу — job уже в финальном статусе.
    if (updated && post.typeConfig?.resolutionConfig) {
      const orgId = job.organization_id;
      const resolveStart = Date.now();
      void runResolutionPipeline({
        jobId,
        organizationId: orgId,
        extracted: extractedToStore,
        resolutionConfig: post.typeConfig.resolutionConfig,
        log,
      })
        .then(() => stepEvent('resolve', 'done', { duration_ms: Date.now() - resolveStart }))
        .catch((err) => {
          log.warn({ jobId, err }, 'resolution pipeline error (job finalized, continuing)');
          void stepEvent('resolve', 'failed', {
            duration_ms: Date.now() - resolveStart,
            details: { error: String((err as Error)?.message ?? err) },
          });
        });
    } else if (updated) {
      await stepEvent('resolve', 'skipped', { details: { reason: 'no resolution_config' } });
    }

    // ── Output routing (Phase 3 / CP7) ────────────────────────────────────
    // Precedence:
    //   1. job.webhook_url задан (explicit per-job) → доставка туда, подпись
    //      ГЛОБАЛЬНЫМ секретом (today's exact behavior — backwards compat,
    //      не трогаем).
    //   2. иначе profile.output==='webhook' И profile.webhook_url задан →
    //      доставка на profile webhook, подпись per-org секретом. Если у
    //      профиля секрета нет — fallback на глобальный + warn (мягкий
    //      misconfig, не фатально).
    //   3. иначе (output==='pull' или URL нигде нет) → push не делаем.
    // F2/F4/F27 трансформации — внутри deliverFinalizedJobWebhook.
    if (updated && updated.webhook_url) {
      await deliverFinalizedJobWebhook(updated, jobId, log);
    } else if (updated && profile.output === 'webhook' && profile.webhook_url) {
      let hmacSecret: string | undefined;
      if (profile.has_webhook_secret) {
        hmacSecret =
          (await organizationSettingsRepo.getDecryptedWebhookSecret(job.organization_id)) ??
          undefined;
      }
      if (!hmacSecret) {
        log.warn(
          { jobId, organization_id: job.organization_id },
          'profile webhook has no per-consumer secret; falling back to global HMAC secret',
        );
      }
      await deliverFinalizedJobWebhook(updated, jobId, log, {
        url: profile.webhook_url,
        hmacSecret,
      });
    }
  } catch (err) {
    // item A: подчищаем tmp-артефакты (materialized + first-page PNG) на любом
    // пути ошибки между OCR и parse. Идемпотентно (cleanedUp-guard).
    await cleanupArtifacts().catch(() => undefined);
    const errMsg = err instanceof Error ? err.message : String(err);
    const totalDurationMs = Date.now() - startedAt;
    log.error(
      {
        job_id: jobId,
        err: errMsg,
        attempt: opts.attempt ?? 1,
        total_duration_ms: totalDurationMs,
        ocr_duration_ms: timings.ocr_ms,
        classify_duration_ms: timings.classify_ms,
        extract_duration_ms: timings.extract_ms,
        validate_duration_ms: timings.validate_ms,
        document_type: documentType ?? 'unknown',
      },
      'job failed',
    );
    await jobsRepo.finalize(jobId, {
      status: 'failed',
      // Расход уже понесён — пишем его и на провале.
      llmUsage: currentJobLlmUsage(),
      error: errMsg,
      ocrEngine: ocr?.engine ?? null,
      rawText: ocr?.text ?? null,
      confidence: ocr?.confidence ?? null,
      documentType,
    });
    await stepEvent('finalize', 'failed', {
      duration_ms: totalDurationMs,
      details: { error: errMsg },
    });
    // Metrics: count failures and record their duration too — long failures
    // (e.g. timeouts) are interesting separately from quick rejects.
    const dtLabel = documentType ?? 'unknown';
    jobsTotal.inc({ status: 'failed', document_type: dtLabel });
    jobsDurationSeconds.observe(
      { document_type: dtLabel, outcome: 'failed' },
      totalDurationMs / 1000,
    );
    throw err; // let BullMQ apply its retry policy
  }
}

/**
 * Run engines in declared order, returning early when one clears its threshold.
 * If no engine clears, return the highest-confidence result. Errors from one
 * engine never abort the chain — they are logged and the next engine is tried.
 *
 * A5: PDFs are rasterized once before the engine loop when more than one engine
 * is in the chain. Both TesseractEngine and VisionLlmEngine check
 * `OcrInput.rasterizedPages` and skip their own pdftoppm call when present.
 * The shared tmpdir is cleaned up in a `finally` block regardless of outcome.
 *
 * Exported so the smoke CLI can reuse the same engine wiring.
 */
export async function runOcrChain(
  input: {
    filePath: string;
    mimeType: string;
    tesseractLangsOverride?: string;
    yandexModelOverride?: string;
  },
  log: Logger,
  options: { documentType?: string; disableExternalOcr?: boolean } = {},
): Promise<OcrResult> {
  // Ключ+folder Yandex Vision резолвим из «Провайдеров» (provider_settings,
  // api_key шифруется at rest) с откатом на env — секрет вводится в интерфейсе,
  // без правки .env и рестарта. БД трогаем только для mime, которые движок
  // вообще берёт (pdf/image); для docx/xlsx это лишний запрос, там Yandex не
  // участвует. Модели/таймаут остаются из env (поведенческие тумблеры).
  const mightUseYandex =
    input.mimeType === 'application/pdf' || input.mimeType.startsWith('image/');
  const yandexCreds = mightUseYandex
    ? await resolveYandexVisionCredentials(log)
    : { apiKey: config.yandex.apiKey, folderId: config.yandex.folderId };

  // Пересобираем yandex-движок с резолвнутыми данными, чтобы UI-конфиг делал
  // его доступным даже когда env пуст. Если оба поля совпали с env — не тратим
  // аллокацию, гоняем статический массив.
  const runEngines: readonly OcrEngine[] =
    yandexCreds.apiKey === config.yandex.apiKey &&
    yandexCreds.folderId === config.yandex.folderId
      ? engines
      : engines.map((e) =>
          e.name === 'yandex'
            ? new YandexVisionEngine({
                ...config.yandex,
                apiKey: yandexCreds.apiKey,
                folderId: yandexCreds.folderId,
              })
            : e,
        );

  // Рубильник коннектора `yandex_vision` из «Интеграций» + суточный лимит.
  // Спрашиваем БД только если Yandex вообще сконфигурирован (иначе лишний
  // запрос на каждом docx/xlsx). Гейт fail-closed: см. ocr/yandex-gate.ts.
  const yandexConfigured = runEngines.some((e) => e.name === 'yandex' && e.isAvailable());

  // Ключ есть, но движок недоступен — значит нет folder id. НЕ молчим: иначе
  // Yandex тихо выпадает из каскада (уходит на tesseract), а оператор не
  // понимает почему. Fail-safe (наружу ничего не ушло), но требует внимания.
  if (mightUseYandex && yandexCreds.apiKey && !yandexConfigured) {
    log.warn(
      'yandex vision api key resolved but engine unavailable (folder id missing) — cloud OCR skipped',
    );
  }

  const yandexVisionAllowed = yandexConfigured ? await isYandexVisionAllowed(log) : undefined;

  // I8: PII opt-out. Per-job флаг приходит из orchestrator (через metadata),
  // глобальный disableForPii — из env. selectOcrChain выкинет Yandex если
  // что-то из условий совпало. Все фильтры через AND: рубильник может только
  // убрать Yandex, но не вернуть его после PII-фильтра.
  const chain = selectOcrChain(runEngines, input, {
    documentType: options.documentType,
    disableExternalOcr: options.disableExternalOcr,
    disableYandexForPii: config.yandex.disableForPii,
    preferYandexForScans: config.yandex.preferForScans,
    yandexVisionAllowed,
  });
  // documentType прокидываем в OcrInput, чтобы YandexVisionEngine выбрал
  // tableModel для табличных типов (счёт-фактура/УПД скан).
  const inputWithType: OcrInput = { ...input, documentType: options.documentType };
  if (chain.length === 0) {
    throw new Error(`no OCR engine available for mime type ${input.mimeType}`);
  }

  // Pre-rasterize PDF once when the chain has multiple engines — avoids a
  // second pdftoppm call if the first rasterizing engine (tesseract) doesn't
  // clear its threshold and vision-llm is tried next.
  let rasterDir: string | undefined;
  let ocrInput: OcrInput = inputWithType;
  if (input.mimeType === 'application/pdf' && chain.length > 1) {
    try {
      rasterDir = await mkdtemp(join(tmpdir(), 'docsvc-raster-'));
      const prefix = join(rasterDir, 'page');
      await execP(`pdftoppm -png -r 200 "${input.filePath}" "${prefix}"`, { timeout: 120_000 });
      const rasterizedPages = (await readdir(rasterDir))
        .filter((f) => f.startsWith('page') && f.endsWith('.png'))
        .sort()
        .map((f) => join(rasterDir!, f));
      ocrInput = { ...inputWithType, rasterizedPages };
      log.debug(
        { filePath: input.filePath, page_count: rasterizedPages.length },
        'pdf pre-rasterized (shared across engines)',
      );
    } catch (err) {
      // Pre-rasterization failed (pdftoppm not installed, corrupt PDF, …).
      // Each engine will fall back to its own rasterization path — same
      // behaviour as before A5, no data loss.
      log.warn({ err }, 'pdf pre-rasterization failed, engines will rasterize independently');
      if (rasterDir) {
        await rm(rasterDir, { recursive: true, force: true }).catch(() => {});
        rasterDir = undefined;
      }
    }
  }

  let best: OcrResult | null = null;
  try {
    for (let i = 0; i < chain.length; i += 1) {
      const engine = chain[i]!;
      const engineStartedAt = Date.now();
      try {
        const r = await engine.run(ocrInput);
        // Учёт облачного OCR: страницы уже отправлены и оплачены — пишем расход
        // независимо от того, победил ли Yandex в каскаде. `model` пишем как
        // имя сервиса: конкретная OCR-модель (page/table) выбирается движком
        // внутри и наружу не выдаётся, врать про неё не будем.
        if (engine.name === 'yandex') {
          await recordYandexVisionPages(
            { pages: r.pages?.length ?? 1, latencyMs: r.durationMs, model: 'yandex-vision' },
            log,
          );
        }
        const accepted = r.confidence >= engine.acceptanceThreshold;
        log.info(
          {
            engine: engine.name,
            confidence: roundConf(r.confidence),
            duration_ms: r.durationMs,
            text_length_chars: r.text.length,
            text_lines: r.text ? r.text.split('\n').length : 0,
            accepted,
            skipped: false,
          },
          'ocr engine result',
        );
        ocrEngineDurationSeconds.observe(
          { engine: engine.name, outcome: accepted ? 'accepted' : 'rejected' },
          r.durationMs / 1000,
        );
        if (!best || r.confidence > best.confidence) best = r;
        if (accepted) {
          // Логируем все оставшиеся движки как skipped — даёт log-агрегатору
          // видимость «pdf-text справился, tesseract и vision-llm даже не
          // тронули». Без этого факт пропуска незаметен.
          for (let j = i + 1; j < chain.length; j += 1) {
            log.info(
              { engine: chain[j]!.name, skipped: true, reason: `${engine.name} accepted` },
              'ocr engine result',
            );
          }
          return r;
        }
      } catch (err) {
        // Движок упал — но облачный OCR мог уже отправить (и оплатить) часть
        // страниц: каждая страница = отдельный POST. Без этого списания
        // суточный лимит не сдвинется, а ретрай отправит их повторно.
        if (engine.name === 'yandex') {
          const sent = pagesSentFrom(err);
          if (sent > 0) {
            await recordYandexVisionPages(
              { pages: sent, latencyMs: Date.now() - engineStartedAt, model: 'yandex-vision' },
              log,
            );
          }
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn({ engine: engine.name, err: errMsg, skipped: false }, 'ocr engine failed');
        ocrEngineDurationSeconds.observe({ engine: engine.name, outcome: 'error' }, 0);
      }
    }
    if (!best) throw new Error('all OCR engines failed');
    return best;
  } finally {
    // Cleanup shared raster tmpdir regardless of outcome (accepted, rejected, or thrown).
    if (rasterDir) {
      await rm(rasterDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * extraction-from-image (item A): подготовить путь к изображению первой
 * страницы документа для image-extract.
 *
 *   - image/* MIME → сам файл уже изображение, возвращаем filePath (cleanup=no-op).
 *   - application/pdf → растеризуем ТОЛЬКО первую страницу в tmp PNG.
 *   - всё остальное (docx/xlsx/...) → null (нет смысла в image-extract).
 *
 * Fail-soft: если pdftoppm недоступен / PDF битый — возвращаем null, и
 * pipeline тихо откатывается на text-only extract. Возвращает cleanup-хэндл,
 * который caller обязан вызвать в finally (tmp PNG не должен утечь).
 */
async function prepareFirstPageImage(
  filePath: string,
  mimeType: string,
  log: Logger,
  pageNo = 1,
): Promise<{ imagePath: string | undefined; cleanup: () => Promise<void> }> {
  const noop = { imagePath: undefined, cleanup: async () => {} };
  if (mimeType.startsWith('image/')) {
    // Одиночное изображение = одна страница; pageNo>1 не применим — отдаём как есть.
    return { imagePath: filePath, cleanup: async () => {} };
  }
  if (mimeType !== 'application/pdf') {
    return noop;
  }
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'docsvc-extract-img-'));
    const prefix = join(dir, 'page');
    // -f N -l N — только страница pageNo (§FIX-1: VLM по хвостовой странице);
    // -r 200 совпадает с OCR-растеризацией.
    await execP(`pdftoppm -png -r 200 -f ${pageNo} -l ${pageNo} "${filePath}" "${prefix}"`, { timeout: 120_000 });
    const pages = (await readdir(dir))
      .filter((f) => f.startsWith('page') && f.endsWith('.png'))
      .sort();
    const first = pages[0];
    if (!first) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return noop;
    }
    const imagePath = join(dir, first);
    const tmpDir = dir;
    return {
      imagePath,
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (err) {
    log.warn({ err }, 'first-page rasterization for image-extract failed; falling back to text');
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return noop;
  }
}

/**
 * Персист метаданных классификации в jobs.classification (jsonb, для UI).
 * Один источник для обоих путей — воркер (processJob) и reprocess-route.
 * best-effort: метаданные наблюдаемости не должны ронять обработку, ошибку
 * глушим в warn. No-op когда classification не задан (caller передал hint
 * напрямую и pipeline не заполнил метаданные — редкий путь).
 */
export async function persistClassification(
  jobId: string,
  classification: ClassificationMetadata | undefined,
  log: Logger,
): Promise<void> {
  if (!classification) return;
  try {
    await jobsRepo.saveClassification(jobId, classification);
  } catch (err) {
    log.warn({ jobId, err }, 'failed to save classification metadata (non-fatal)');
  }
}

/**
 * Pure post-OCR pipeline: classify (or honour caller-supplied hint), then
 * dispatch to the parser registered for that document type.
 *
 * No DB writes, no I/O beyond the classifier and parser dependencies (which
 * may call the LLM client). Safe to use from tests, smoke scripts, and
 * future scenarios where text comes from somewhere other than a job row.
 */
export async function runDocumentPipeline(
  rawText: string,
  options: {
    hint?: DocumentTypeSlug;
    promptOverride?: string;
    organizationId?: string | null;
    /**
     * Имя загруженного файла — weighted-сигнал классификации (booster /
     * tie-breaker). Прокидывается в classifier; тип из имени усиливает или
     * переворачивает low-confidence кейс, но не бьёт strong контент-матч.
     * См. classifier/filename-signal.ts.
     */
    fileName?: string | null;
    /**
     * Phase 3 (CP7): classify_only-режим потребителя. Когда true — гоняем
     * только классификацию (нужен documentType), но НЕ запускаем parser/
     * LLM-extract. Возвращаем extracted={}, llmCall=null, validationIssues=[].
     * parserConfidence остаётся undefined — caller считает overall только по
     * OCR/classification confidence.
     */
    classifyOnly?: boolean;
    /**
     * extraction-from-image (item A): путь к PNG/JPEG первой страницы.
     * Если задан И resolved LLM-провайдер vision-capable (или включён
     * `forceExtractFromImage`) — extract пойдёт по image-пути (модель
     * извлекает поля из картинки). Если провайдер не vision и override не
     * задан — image игнорируется (классический text-only extract).
     */
    imagePath?: string;
    /**
     * metadata-override `_extract_from_image=true`: форсировать image-extract
     * даже если у провайдера vision=false (на свой риск). Без него решение
     * принимается по `llm.supportsVision()`.
     */
    forceExtractFromImage?: boolean;
    /**
     * Hybrid-routing (SLAI #3). Когда задан — после classify роутер решает
     * text/vision PATH по дешёвым сигналам и (при vision) маршрутизирует
     * extract через designated vision-провайдера + картинку. Передаётся ТОЛЬКО
     * когда HYBRID_ROUTING_ENABLED=true (orchestrator гейтит). undefined →
     * поведение как раньше (provider.vision / forceExtractFromImage).
     *
     * Fail-soft: если vision-провайдер недоступен или картинки нет — откат
     * на text-путь, job не падает.
     */
    hybrid?: {
      ocrEngine: import('./ocr/types.js').OcrResult['engine'];
      ocrConfidence: number;
      textLength: number;
      pageCount: number;
      isImageInput: boolean;
      forceImage: boolean;
      forceText: boolean;
      visionConfThreshold: number;
      visionProviderId?: string;
    };
  },
  log: Logger,
  context: Record<string, unknown> = {},
  /** Опц. mutable timings — заполняются по ходу выполнения шагов. */
  timings?: StepTimings,
): Promise<{
  documentType: DocumentTypeSlug | null;
  classificationSource: 'hint' | 'keyword';
  classificationMatch?: string;
  /**
   * Production LLM classifier: богатые метаданные классификации (method,
   * llm_said, keyword_said, candidates, duration_ms, unknown). undefined когда
   * classify не запускался (caller передал hint напрямую). Caller (orchestrator/
   * reprocess) персистит их в jobs.classification.
   */
  classification?: ClassificationMetadata;
  extracted: Record<string, unknown>;
  parserConfidence?: number;
  parserMissing: string[];
  validationIssues: string[];
  /**
   * Resolved per-type config used for this run. Returned so the caller
   * (processJob) can apply per-type `confidenceThreshold` for the
   * needs_review decision without re-resolving. `null` when no type was
   * classified — caller falls back to global env threshold.
   */
  typeConfig: ResolvedTypeConfig | null;
  /** Debug-след LLM-вызова (если парсер ходил в модель). */
  llmCall?: LlmExtractDebug;
  /**
   * extraction-from-image (item A): какой режим extract фактически
   * отработал — 'image' (модель видела картинку) или 'text' (классический
   * OCR-текст). undefined когда extract не запускался (classify_only / нет
   * типа). Caller пишет это в pipeline step для видимости в job detail.
   */
  extractMode?: 'image' | 'text';
  /**
   * Hybrid-routing (SLAI #3): причина выбора пути (low_ocr_conf / scan_engine /
   * forced_image / clean_text / ...). undefined когда hybrid выключен или
   * extract не запускался. Пишется в pipeline step для debug.
   */
  routeReason?: RouteReason;
}> {
  let documentType: DocumentTypeSlug | null = options.hint ?? null;
  let classificationSource: 'hint' | 'keyword' = documentType ? 'hint' : 'keyword';
  let classificationMatch: string | undefined;
  let classification: ClassificationMetadata | undefined;

  if (!documentType) {
    // Production LLM classifier: keyword prior → LLM catalog classify → decision.
    // НИКОГДА не бросает из-за классификатора (fallback на keyword внутри).
    const tClassify = Date.now();
    const validator = await makeCatalogSlugValidator(options.organizationId ?? null);
    const outcome = await llmDocClassifier.classify(
      {
        text: rawText,
        fileName: options.fileName ?? null,
        organizationId: options.organizationId ?? null,
      },
      validator,
      log,
      context,
    );
    const classifyMs = Date.now() - tClassify;
    if (timings) timings.classify_ms = classifyMs;
    documentType = outcome.documentType;
    classification = outcome.metadata;
    // classificationMatch/source оставляем для backwards-compat pipeline step'а.
    classificationMatch = outcome.metadata.llm_said ?? outcome.metadata.keyword_said?.type;
    log.info(
      {
        ...context,
        type: documentType,
        method: outcome.metadata.method,
        llm_said: outcome.metadata.llm_said,
        keyword_said: outcome.metadata.keyword_said?.type ?? null,
        unknown: outcome.metadata.unknown,
        classify_llm_duration_ms: outcome.metadata.duration_ms,
        classify_total_duration_ms: classifyMs,
      },
      'classified',
    );
  } else if (options.hint) {
    // Caller передал hint напрямую (document_hint / reprocess без reclassify) —
    // фиксируем method='hint' в метаданных, чтобы UI видел «тип задан явно».
    classification = {
      type: documentType,
      confidence: 1,
      method: 'hint',
      duration_ms: null,
      llm_said: null,
      keyword_said: null,
      candidates: [],
      unknown: false,
    };
  }

  // §FIX-3: спец со ссылкой «Invoice no.» (без цен) ошибочно уходит в
  // commercial_invoice. Детерминированная коррекция по тексту ДО extract —
  // чтобы дальше использовалась спец-схема. No-op для не-инвойсов и настоящих
  // инвойсов (есть цены/валюта).
  {
    const corrected = correctSpecVsInvoice(documentType, rawText);
    if (corrected !== documentType) {
      log.info({ ...context, from: documentType, to: corrected }, '§FIX-3: спец→contract_specification');
      documentType = corrected;
      if (classification) classification.type = corrected;
    }
  }

  let extracted: Record<string, unknown> = {};
  let parserConfidence: number | undefined;
  let parserMissing: string[] = [];
  let validationIssues: string[] = [];
  let typeConfig: ResolvedTypeConfig | null = null;
  let llmCall: LlmExtractDebug | undefined;
  // Auto-requality: факторы «странности» разбора, доживающие до validationIssues.
  const requalityFactors: QualityFactor[] = [];
  let extractMode: 'image' | 'text' | undefined;
  let routeReason: RouteReason | undefined;

  if (documentType && options.classifyOnly) {
    // Phase 3 (CP7): classify_only — потребителю нужен только тип документа.
    // Резолвим typeConfig (caller использует confidenceThreshold для
    // needs_review-решения), но parser/LLM-extract НЕ запускаем. extracted
    // остаётся {}, validationIssues=[], llmCall=undefined.
    typeConfig = await documentTypeResolver.resolveConfig(documentType);
  } else if (documentType) {
    // Resolve the DB-backed config snapshot ONCE per job. Passed to:
    //   - the parser as `ParserOverride` (regex_fallback_threshold,
    //     expected_fields, llm_schema)
    //   - the validator (already does its own resolver lookup; one more
    //     cache hit is cheap)
    //   - the caller as `typeConfig.confidenceThreshold` for the
    //     needs_review threshold.
    typeConfig = await documentTypeResolver.resolveConfig(documentType);

    // CP1: parser_kind dispatch. Если в БД задано 'llm_extract' — форсируем
    // GenericLlmParser даже для builtin-slug'ов (позволяет переключить тип
    // с regex на чистый LLM через UI без передеплоя кода).
    //
    // Phase B: дополнительный диспатч на MultiPassLlmParser:
    //   - parser_kind='llm_extract_multipass' — явный admin-override
    //   - parser_kind='llm_extract' + размер OCR-текста > MULTIPASS_AUTO_THRESHOLD
    //     (config.thresholds.multipassAutoBytes, default 30_000) — авто-режим
    //
    // Для всех остальных значений (null / builtin:*) — стандартный диспатч
    // фабрики: builtin slug → типизированный regex-парсер, custom → Generic.
    const useMultipass =
      typeConfig?.parserKind === 'llm_extract_multipass' ||
      (typeConfig?.parserKind === 'llm_extract' &&
        rawText.length > config.thresholds.multipassAutoBytes);
    const parser =
      useMultipass
        ? parsersFactory.getMultipass(documentType)
        : typeConfig?.parserKind === 'llm_extract'
          ? parsersFactory.getGeneric(documentType)
          : parsersFactory.get(documentType);

    // ── Extract PATH routing ───────────────────────────────────────────────
    // Два режима резолва картинки/провайдера:
    //
    //   (A) Hybrid-routing (SLAI #3, options.hybrid задан): роутер решает
    //       text/vision по дешёвым сигналам (OCR conf / scan-engine / prefer_vision
    //       / forced). При vision — резолвим designated vision-провайдера и
    //       прогоняем extract через него (withForceProvider ALS) + картинка.
    //       Fail-soft: нет vision-провайдера или нет картинки → откат на text.
    //
    //   (B) Legacy (item A, hybrid не задан / выключен): картинка идёт парсеру
    //       только если есть image-файл И (forceExtractFromImage ИЛИ resolved
    //       LLM-провайдер vision-capable). supportsVision() fail-soft.
    let imagePathForExtract: string | undefined;
    let forceVisionProviderId: string | null = null;

    if (options.hybrid) {
      const decision = decideExtractPath(
        {
          ocrEngine: options.hybrid.ocrEngine,
          ocrConfidence: options.hybrid.ocrConfidence,
          textLength: options.hybrid.textLength,
          pageCount: options.hybrid.pageCount,
          isImageInput: options.hybrid.isImageInput,
          preferVision: typeConfig.preferVision,
          forceImage: options.hybrid.forceImage,
          forceText: options.hybrid.forceText,
        },
        { visionConfThreshold: options.hybrid.visionConfThreshold },
      );
      routeReason = decision.reason;
      if (decision.mode === 'vision') {
        // Нужен vision. Резолвим designated провайдера и проверяем что есть
        // картинка. Любой провал (нет провайдера / нет картинки) → fail-soft
        // откат на text-путь с понятным route_reason.
        const visionId = await resolveVisionProviderId(options.hybrid.visionProviderId, log);
        if (visionId && options.imagePath) {
          forceVisionProviderId = visionId;
          imagePathForExtract = options.imagePath;
        } else {
          log.warn(
            {
              ...context,
              route_reason: decision.reason,
              vision_provider_resolved: !!visionId,
              has_image: !!options.imagePath,
            },
            'hybrid: vision path requested but unavailable — falling back to text',
          );
          // Откат на text: помечаем reason как clean_text-эквивалент по факту
          // (extract пойдёт текстом). Оставляем оригинальный reason недоступным,
          // фиксируем фактический режим в extractMode ниже.
          routeReason = decision.reason; // why we WANTED vision; mode=text fact ниже
        }
      }
    } else if (options.imagePath) {
      let visionCapable = false;
      try {
        visionCapable = await llm.supportsVision();
      } catch {
        visionCapable = false;
      }
      if (options.forceExtractFromImage || visionCapable) {
        imagePathForExtract = options.imagePath;
      }
    }
    extractMode = imagePathForExtract ? 'image' : 'text';

    const runParse = () =>
      parser.parse(rawText, {
        expectedFields: typeConfig!.expectedFields,
        regexFallbackThreshold: typeConfig!.regexFallbackThreshold,
        llmSchema: typeConfig!.llmSchema,
        imagePath: imagePathForExtract,
        // Кастомная инструкция админа (если задана) → пробрасывается
        // парсером в LLM-клиент → попадает как `prompt_override` в
        // inference-service → заменяет builtin prompt для этого типа.
        //
        // F20 (SLAI ТЗ): per-job override через options.promptOverride
        // приоритетнее чем per-type llmPrompt. Use case: оператор хочет
        // переспросить документ с другим промптом для одного конкретного
        // job (через `POST /jobs/:id/reprocess` с metadata.prompt_override).
        llmPrompt: options.promptOverride ?? typeConfig!.llmPrompt ?? undefined,
      });

    const tParser = Date.now();
    // Adaptive-model routing (2026-07-09): per-type preferred_provider_id из
    // document_types.metadata. Порядок приоритета для extract'а:
    //   1. Vision path (hybrid + скан) — highest
    //   2. Per-type preferred provider (например customs_declaration → Ollama
    //      с 32k context для длинных items[]; лёгкие типы → vLLM 8k быстрый)
    //   3. Default provider
    // withForceProvider fail-soft'нет на default если id не резолвится.
    const extractProviderId = forceVisionProviderId ?? typeConfig!.preferredProviderId;
    let result = extractProviderId
      ? await dynamicLlm.withForceProvider(extractProviderId, runParse)
      : await runParse();

    // ── Auto-requality (2026-07-10) ─────────────────────────────────────────
    // Оцениваем разбор детектором «странности». Если сигналы сработали
    // (пустое извлечение / обрыв JSON / reasoning-bleed / мусорный OCR) —
    // переигрываем extract через fallback-провайдер (другая модель ловит
    // другие сбои) и берём лучший результат. classify_only пропускаем —
    // там extract не запускается. Гейтится config.requality.enabled.
    if (config.requality.enabled && !options.classifyOnly) {
      const assessment = assessQuality({
        extracted: result.extracted,
        expectedFields: typeConfig!.expectedFields,
        missing: result.missing,
        confidence: result.confidence,
        rawResponse: result.llmCall?.raw_response ?? null,
        ocrText: rawText,
      });
      const fallbackId = config.requality.fallbackProviderId;
      const canRetry = assessment.shouldRequality && !!fallbackId && fallbackId !== extractProviderId;
      if (assessment.shouldRequality) {
        log.warn(
          {
            ...context,
            type: documentType,
            requality_score: assessment.score,
            requality_factors: assessment.factors.map((f) => f.code),
            will_retry: canRetry,
            fallback_provider: canRetry ? fallbackId : null,
          },
          'quality assessment flagged strange extract',
        );
      }
      if (canRetry) {
        // Вторая попытка через fallback-провайдер. Fail-soft: если она упала
        // или дала ХУЖЕ (меньше полей) — оставляем оригинальный результат.
        // `assessment` уже посчитан для original выше — переиспользуем его как
        // origAssess (тот же `result`), не пересчитываем.
        try {
          const retry = await dynamicLlm.withForceProvider(fallbackId, runParse);
          const retryAssess = assessQuality({
            extracted: retry.extracted,
            expectedFields: typeConfig!.expectedFields,
            missing: retry.missing,
            confidence: retry.confidence,
            rawResponse: retry.llmCall?.raw_response ?? null,
            ocrText: rawText,
          });
          // Берём результат с меньшим score странности (лучше). При равенстве
          // предпочитаем retry только если у него строго больше missing-покрытия.
          const retryBetter =
            retryAssess.score < assessment.score ||
            (retryAssess.score === assessment.score &&
              retry.missing.length < result.missing.length);
          log.info(
            {
              ...context,
              orig_score: assessment.score,
              retry_score: retryAssess.score,
              chosen: retryBetter ? 'retry' : 'original',
              fallback_provider: fallbackId,
            },
            'requality retry completed',
          );
          if (retryBetter) {
            result = retry;
            requalityFactors.push(...retryAssess.factors);
          } else {
            requalityFactors.push(...assessment.factors);
          }
        } catch (err) {
          log.warn(
            { ...context, err: err instanceof Error ? err.message : String(err) },
            'requality retry failed — keeping original extract',
          );
          requalityFactors.push(...assessment.factors);
        }
      } else if (assessment.shouldRequality) {
        // Ретрай невозможен (нет fallback / тот же провайдер) — фиксируем
        // факторы, чтобы job ушёл в needs_review ниже.
        requalityFactors.push(...assessment.factors);
      }
    }

    const parserMs = Date.now() - tParser;
    if (timings) timings.extract_ms = parserMs;
    extracted = result.extracted;
    parserConfidence = result.confidence;
    parserMissing = result.missing;
    llmCall = result.llmCall;

    // Структурный лог: одно `parser result` событие со всей картиной
    // итога парсинга — confidence, поля, fallback. Заменяет старое
    // `parser missing fields` (теперь missing-список — поле в этом
    // событии, не отдельный лог).
    const fieldsTotal = typeConfig.expectedFields.length;
    log.info(
      {
        ...context,
        type: documentType,
        parser: typeConfig.source === 'db' ? typeConfig.slug : `builtin:${typeConfig.slug}`,
        confidence: roundConf(result.confidence),
        fields_extracted: Math.max(0, fieldsTotal - result.missing.length),
        fields_missing: result.missing.length,
        missing: result.missing,
        llm_fallback_triggered: !!result.llmCall,
        duration_ms: parserMs,
      },
      'parser result',
    );

    // Отдельный `llm call` event — детали реального вызова к модели для
    // мониторинга latency/cost. Метрики в Prometheus уже есть; в логах
    // удобнее коррелировать с конкретным job_id.
    if (result.llmCall) {
      log.info(
        {
          ...context,
          endpoint: 'extract',
          provider: result.llmCall.backend,
          model: result.llmCall.model,
          duration_ms: result.llmCall.duration_ms ?? null,
          prompt_chars: result.llmCall.prompt.length,
          response_chars: result.llmCall.raw_response.length,
          prompt_tokens: result.llmCall.prompt_tokens ?? null,
          output_tokens: result.llmCall.output_tokens ?? null,
          status: 'ok',
        },
        'llm call',
      );
    }

    // Pipeline post-extract нормализации — 4 шага в строгом порядке.
    // F1 ИНН/plate → F7 totals → F6 category keyword → F13 SLAI enrichment.
    // Детали порядка и почему — см. normalize/run.ts header.
    const normalized = await runPostExtractNormalization(extracted, log, rawText, documentType);
    if (normalized && normalized !== extracted) {
      extracted = normalized;
    }

    const tValidate = Date.now();
    validationIssues = await validateExtractedWithResolver(extracted, documentType, log);
    if (timings) timings.validate_ms = Date.now() - tValidate;
  }

  // Auto-requality: если разбор остался «странным» (после fallback-ретрая или
  // без него — нет провайдера), добавляем факторы как validation issues. Это
  // (а) переводит job в needs_review, (б) показывает оператору конкретную
  // причину, (в) уходит в webhook как _issues для SLAI-matcher'а.
  if (requalityFactors.length > 0) {
    validationIssues.push(
      ...requalityFactors.map((f) => `requality:${f.code}: ${f.message}`),
    );
  }

  return {
    documentType,
    classificationSource,
    classificationMatch,
    classification,
    extracted,
    parserConfidence,
    parserMissing,
    validationIssues,
    typeConfig,
    llmCall,
    extractMode,
    routeReason,
  };
}
