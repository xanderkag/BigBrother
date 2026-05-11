import type { Logger } from 'pino';
import { config } from '../config.js';
import { jobsRepo } from '../storage/jobs.js';
import { deliverWebhook } from '../webhooks/deliver.js';
import type { OcrEngine, OcrResult } from './ocr/types.js';
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
 * Process a job end-to-end. Called from the BullMQ worker.
 *
 * Thin wrapper around the pure pipeline functions: pulls input from DB,
 * runs OCR + post-OCR pipeline, persists result, fires webhook. The two
 * pure functions (`runOcrChain`, `runDocumentPipeline`) are exported so
 * the smoke CLI and integration tests can reuse them without DB plumbing.
 */
export async function processJob(jobId: string, log: Logger): Promise<void> {
  const job = await jobsRepo.findById(jobId);
  if (!job) {
    log.error({ jobId }, 'job not found');
    return;
  }

  await jobsRepo.markProcessing(jobId);

  let ocr: OcrResult | null = null;
  let documentType: DocumentTypeSlug | null = job.document_hint ?? null;

  // Metrics: end-to-end timer. `started` is "worker pickup" — close enough
  // to user-perceived latency for a fire-and-forget API. Label values are
  // resolved at finalize time (we don't know status/type up front).
  const startedAt = Date.now();

  try {
    ocr = await runOcrChain({ filePath: job.file_path, mimeType: job.mime_type }, log);

    const post = await runDocumentPipeline(
      ocr.text,
      { hint: documentType ?? undefined },
      log,
      { jobId },
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
    jobsTotal.inc({ status, document_type: dtLabel });
    jobsDurationSeconds.observe(
      { document_type: dtLabel, outcome: status },
      (Date.now() - startedAt) / 1000,
    );

    log.info({ jobId, status, engine: ocr.engine, confidence: overall }, 'job finalized');

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
    log.error({ jobId, err: errMsg }, 'job failed');
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
      (Date.now() - startedAt) / 1000,
    );
    throw err; // let BullMQ apply its retry policy
  }
}

/**
 * Run engines in declared order, returning early when one clears its threshold.
 * If no engine clears, return the highest-confidence result. Errors from one
 * engine never abort the chain — they are logged and the next engine is tried.
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

  let best: OcrResult | null = null;
  for (const engine of chain) {
    try {
      const r = await engine.run(input);
      log.info(
        { engine: engine.name, confidence: r.confidence, durationMs: r.durationMs },
        'ocr engine result',
      );
      // Engine reports its own internal duration; record per-engine + outcome.
      // outcome=accepted when this engine's result is "good enough" to stop;
      // rejected when we fall through to the next.
      const accepted = r.confidence >= engine.acceptanceThreshold;
      ocrEngineDurationSeconds.observe(
        { engine: engine.name, outcome: accepted ? 'accepted' : 'rejected' },
        r.durationMs / 1000,
      );
      if (!best || r.confidence > best.confidence) best = r;
      if (accepted) return r;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ engine: engine.name, err: errMsg }, 'ocr engine failed');
      // Engine threw — no duration available, but the failure itself is
      // worth counting. Observe 0 to bump the count without skewing the
      // histogram much; alternatively could be a separate counter.
      ocrEngineDurationSeconds.observe({ engine: engine.name, outcome: 'error' }, 0);
    }
  }
  if (!best) throw new Error('all OCR engines failed');
  return best;
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
    const cls = await classifier.classify(rawText);
    documentType = cls.type;
    classificationMatch = cls.matched;
    log.info({ ...context, type: cls.type, source: cls.source, matched: cls.matched }, 'classified');
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

    // Factory диспатчит: builtin slug → типизированный парсер,
    // custom slug → GenericLlmParser (всё извлечение через LLM с
    // DB-резолвленной схемой/полями).
    const parser = parsersFactory.get(documentType);
    const result = await parser.parse(rawText, {
      expectedFields: typeConfig.expectedFields,
      regexFallbackThreshold: typeConfig.regexFallbackThreshold,
      llmSchema: typeConfig.llmSchema,
      // Кастомная инструкция админа (если задана) → пробрасывается
      // парсером в LLM-клиент → попадает как `prompt_override` в
      // inference-service → заменяет builtin prompt для этого типа.
      llmPrompt: typeConfig.llmPrompt ?? undefined,
    });
    extracted = result.extracted;
    parserConfidence = result.confidence;
    parserMissing = result.missing;
    llmCall = result.llmCall;
    if (result.missing.length > 0) {
      log.info({ ...context, type: documentType, missing: result.missing }, 'parser missing fields');
    }
    validationIssues = await validateExtractedWithResolver(extracted, documentType, log);
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
