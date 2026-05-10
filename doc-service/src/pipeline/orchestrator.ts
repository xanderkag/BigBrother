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
import { buildParsers } from './parsers/index.js';
import { HttpLlmClient } from './llm/http-client.js';
import { NullLlmClient } from './llm/null-client.js';
import type { LlmClient } from './llm/types.js';
import type { DocumentType } from '../types/documents.js';
import { validateExtracted } from './validation/index.js';

// --- Wire dependencies once at module load. The pipeline is stateless beyond this.

const llm: LlmClient = config.llm.url
  ? new HttpLlmClient({
      baseUrl: config.llm.url,
      apiKey: config.llm.apiKey,
      timeoutMs: config.llm.timeoutMs,
    })
  : new NullLlmClient();

const engines: readonly OcrEngine[] = [
  new PdfTextEngine(config.thresholds.pdfText),
  new TesseractEngine(config.thresholds.tesseract, config.tesseractLangs),
  new VisionLlmEngine(config.thresholds.visionLlm, llm),
  new YandexVisionEngine(config.yandex),
];

const classifier = new KeywordClassifier();
const parsers = buildParsers(llm, {
  regexFallbackThreshold: config.thresholds.regexFallback,
});

/** Combined output of the full file → structured data run. */
export type PipelineRunResult = {
  ocr: OcrResult;
  documentType: DocumentType | null;
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
  let documentType: DocumentType | null = (job.document_hint as DocumentType | null) ?? null;

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

    // A document with hard validation failures (e.g., INN checksum mismatch)
    // should always be reviewed by a human, regardless of OCR confidence.
    const lowConfidence = overall < config.thresholds.needsReview;
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
      extracted: extractedToStore,
      error: null,
    });

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
      if (!best || r.confidence > best.confidence) best = r;
      if (r.confidence >= engine.acceptanceThreshold) return r;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ engine: engine.name, err: errMsg }, 'ocr engine failed');
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
  options: { hint?: DocumentType },
  log: Logger,
  context: Record<string, unknown> = {},
): Promise<{
  documentType: DocumentType | null;
  classificationSource: 'hint' | 'keyword';
  classificationMatch?: string;
  extracted: Record<string, unknown>;
  parserConfidence?: number;
  parserMissing: string[];
  validationIssues: string[];
}> {
  let documentType: DocumentType | null = options.hint ?? null;
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

  if (documentType) {
    const parser = parsers[documentType];
    const result = await parser.parse(rawText);
    extracted = result.extracted;
    parserConfidence = result.confidence;
    parserMissing = result.missing;
    if (result.missing.length > 0) {
      log.info({ ...context, type: documentType, missing: result.missing }, 'parser missing fields');
    }
    validationIssues = validateExtracted(extracted, documentType);
  }

  return {
    documentType,
    classificationSource,
    classificationMatch,
    extracted,
    parserConfidence,
    parserMissing,
    validationIssues,
  };
}
