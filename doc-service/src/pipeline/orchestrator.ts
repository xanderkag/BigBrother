import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { config } from '../config.js';
import { jobsRepo } from '../storage/jobs.js';
import { deliverWebhook } from '../webhooks/deliver.js';
import type { OcrEngine, OcrInput, OcrResult } from './ocr/types.js';

const execP = promisify(exec);
import { PdfTextEngine } from './ocr/pdf-text.js';
import { TesseractEngine } from './ocr/tesseract.js';
import { VisionLlmEngine } from './ocr/vision-llm.js';
import { YandexVisionEngine } from './ocr/yandex.js';
import { selectOcrChain } from './router.js';
import { KeywordClassifier } from './classifier/keywords.js';
import { combineConfidence } from './quality.js';
import { ParsersFactory } from './parsers/index.js';
import { dynamicLlm } from './llm/provider-resolver.js';
import type { LlmClient, LlmExtractDebug } from './llm/types.js';
import type { DocumentTypeSlug } from '../types/documents.js';
import { validateExtractedWithResolver } from './validation/index.js';
import { documentTypeResolver, type ResolvedTypeConfig } from './document-type-resolver.js';
import { jobsDurationSeconds, jobsTotal, ocrEngineDurationSeconds } from '../metrics.js';
import { runResolutionPipeline } from '../resolution/pipeline.js';

// --- Wire dependencies once at module load. The pipeline is stateless beyond this.
//
// LLM-клиент берём через resolver, который читает provider_settings из БД
// (с env-fallback). Это позволяет админу менять ключ/URL через UI без
// рестарта; resolver инкапсулирует TTL-кэш и lazy-инициализацию.
const llm: LlmClient = dynamicLlm;

const engines: readonly OcrEngine[] = [
  new PdfTextEngine(config.thresholds.pdfText),
  new TesseractEngine(config.thresholds.tesseract, config.tesseractLangs),
  new VisionLlmEngine(config.thresholds.visionLlm, llm),
  new YandexVisionEngine(config.yandex),
];

const classifier = new KeywordClassifier();
const parsersFactory = new ParsersFactory(llm, {
  regexFallbackThreshold: config.thresholds.regexFallback,
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
export async function processJob(
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

  let ocr: OcrResult | null = null;
  let documentType: DocumentTypeSlug | null = job.document_hint ?? null;

  // Per-step timings — для bottleneck-определения и сводного `job completed`.
  const timings: StepTimings = { ocr_ms: 0, classify_ms: 0, extract_ms: 0, validate_ms: 0 };

  // Metrics: end-to-end timer. `started` is "worker pickup" — close enough
  // to user-perceived latency for a fire-and-forget API. Label values are
  // resolved at finalize time (we don't know status/type up front).
  const startedAt = Date.now();

  try {
    const ocrStart = Date.now();
    ocr = await runOcrChain({ filePath: job.file_path, mimeType: job.mime_type }, log);
    timings.ocr_ms = Date.now() - ocrStart;

    const post = await runDocumentPipeline(
      ocr.text,
      { hint: documentType ?? undefined },
      log,
      { jobId },
      timings,
    );
    documentType = post.documentType;

    const overall = combineConfidence(ocr.confidence, post.parserConfidence);

    // Per-type confidence threshold: when the type's row in document_types
    // has `confidence_threshold` set, that value overrides the global env
    // default. Lets admins tighten (or loosen) review for specific types
    // — e.g. contracts always reviewed, low-stakes invoices auto-pass.
    const confidenceThreshold =
      post.typeConfig?.confidenceThreshold ?? config.thresholds.needsReview;

    // A document with hard validation failures (e.g., INN checksum mismatch)
    // should always be reviewed by a human, regardless of OCR confidence.
    const lowConfidence = overall < confidenceThreshold;
    const hasIssues = post.validationIssues.length > 0;
    const status: 'done' | 'needs_review' = lowConfidence || hasIssues ? 'needs_review' : 'done';

    if (hasIssues) {
      log.info({ jobId, issues: post.validationIssues }, 'validation issues detected');
    }

    // Persist issues alongside the structured data. `_issues` is a reserved
    // key inside extracted; `toApi` lifts it back into a top-level field.
    // Strip any pre-existing `_issues` (e.g., if an LLM accidentally emitted
    // one in /extract output) — domain validation here is authoritative.
    const { _issues: _ignore, ...extractedClean } = post.extracted as {
      _issues?: unknown;
    } & Record<string, unknown>;
    const extractedToStore: Record<string, unknown> = { ...extractedClean };
    if (post.validationIssues.length > 0) {
      extractedToStore._issues = post.validationIssues;
    }

    const updated = await jobsRepo.finalize(jobId, {
      status,
      documentType,
      ocrEngine: ocr.engine,
      rawText: ocr.text,
      confidence: overall,
      llmCall: post.llmCall ?? null,
      extracted: extractedToStore,
      error: null,
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
      void runResolutionPipeline({
        jobId,
        organizationId: orgId,
        extracted: extractedToStore,
        resolutionConfig: post.typeConfig.resolutionConfig,
        log,
      }).catch((err) => {
        log.warn({ jobId, err }, 'resolution pipeline error (job finalized, continuing)');
      });
    }

    if (updated && updated.webhook_url) {
      await deliverWebhook(
        jobId,
        updated.webhook_url,
        {
          job_id: updated.id,
          status: updated.status,
          document_type: updated.document_type,
          confidence: updated.confidence === null ? null : Number(updated.confidence),
          ocr_engine: updated.ocr_engine,
          extracted: updated.extracted,
          metadata: updated.metadata,
          error: updated.error,
        },
        log,
      );
    }
  } catch (err) {
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
      error: errMsg,
      ocrEngine: ocr?.engine ?? null,
      rawText: ocr?.text ?? null,
      confidence: ocr?.confidence ?? null,
      documentType,
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
  input: { filePath: string; mimeType: string },
  log: Logger,
): Promise<OcrResult> {
  const chain = selectOcrChain(engines, input);
  if (chain.length === 0) {
    throw new Error(`no OCR engine available for mime type ${input.mimeType}`);
  }

  // Pre-rasterize PDF once when the chain has multiple engines — avoids a
  // second pdftoppm call if the first rasterizing engine (tesseract) doesn't
  // clear its threshold and vision-llm is tried next.
  let rasterDir: string | undefined;
  let ocrInput: OcrInput = input;
  if (input.mimeType === 'application/pdf' && chain.length > 1) {
    try {
      rasterDir = await mkdtemp(join(tmpdir(), 'docsvc-raster-'));
      const prefix = join(rasterDir, 'page');
      await execP(`pdftoppm -png -r 200 "${input.filePath}" "${prefix}"`, { timeout: 120_000 });
      const rasterizedPages = (await readdir(rasterDir))
        .filter((f) => f.startsWith('page') && f.endsWith('.png'))
        .sort()
        .map((f) => join(rasterDir!, f));
      ocrInput = { ...input, rasterizedPages };
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
      try {
        const r = await engine.run(ocrInput);
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
 * Pure post-OCR pipeline: classify (or honour caller-supplied hint), then
 * dispatch to the parser registered for that document type.
 *
 * No DB writes, no I/O beyond the classifier and parser dependencies (which
 * may call the LLM client). Safe to use from tests, smoke scripts, and
 * future scenarios where text comes from somewhere other than a job row.
 */
export async function runDocumentPipeline(
  rawText: string,
  options: { hint?: DocumentTypeSlug },
  log: Logger,
  context: Record<string, unknown> = {},
  /** Опц. mutable timings — заполняются по ходу выполнения шагов. */
  timings?: StepTimings,
): Promise<{
  documentType: DocumentTypeSlug | null;
  classificationSource: 'hint' | 'keyword';
  classificationMatch?: string;
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
}> {
  let documentType: DocumentTypeSlug | null = options.hint ?? null;
  let classificationSource: 'hint' | 'keyword' = documentType ? 'hint' : 'keyword';
  let classificationMatch: string | undefined;

  if (!documentType) {
    const tClassify = Date.now();
    const cls = await classifier.classify(rawText);
    const classifyMs = Date.now() - tClassify;
    if (timings) timings.classify_ms = classifyMs;
    documentType = cls.type;
    classificationMatch = cls.matched;
    log.info(
      {
        ...context,
        type: cls.type,
        source: cls.source,
        matched: cls.matched,
        classify_duration_ms: classifyMs,
        candidates_count: cls.candidatesCount ?? null,
        llm_classify_used: false, // KeywordClassifier пока не использует LLM
      },
      'classified',
    );
  }

  let extracted: Record<string, unknown> = {};
  let parserConfidence: number | undefined;
  let parserMissing: string[] = [];
  let validationIssues: string[] = [];
  let typeConfig: ResolvedTypeConfig | null = null;
  let llmCall: LlmExtractDebug | undefined;

  if (documentType) {
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
    // Для всех остальных значений (null / builtin:*) — стандартный диспатч
    // фабрики: builtin slug → типизированный regex-парсер, custom → Generic.
    const parser =
      typeConfig?.parserKind === 'llm_extract'
        ? parsersFactory.getGeneric(documentType)
        : parsersFactory.get(documentType);
    const tParser = Date.now();
    const result = await parser.parse(rawText, {
      expectedFields: typeConfig.expectedFields,
      regexFallbackThreshold: typeConfig.regexFallbackThreshold,
      llmSchema: typeConfig.llmSchema,
      // Кастомная инструкция админа (если задана) → пробрасывается
      // парсером в LLM-клиент → попадает как `prompt_override` в
      // inference-service → заменяет builtin prompt для этого типа.
      llmPrompt: typeConfig.llmPrompt ?? undefined,
    });
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

    const tValidate = Date.now();
    validationIssues = await validateExtractedWithResolver(extracted, documentType, log);
    if (timings) timings.validate_ms = Date.now() - tValidate;
  }

  return {
    documentType,
    classificationSource,
    classificationMatch,
    extracted,
    parserConfidence,
    parserMissing,
    validationIssues,
    typeConfig,
    llmCall,
  };
}
