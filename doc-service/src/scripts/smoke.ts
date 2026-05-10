/**
 * In-process smoke runner. Bypasses Fastify, BullMQ, and the database —
 * runs the OCR chain and the post-OCR pipeline directly against a file
 * on disk and prints a JSON report to stdout.
 *
 * Usage:
 *   tsx src/scripts/smoke.ts <path> [--hint invoice|TTN|CMR|UPD|AKT|factInvoice]
 *
 * Or after build:
 *   node dist/scripts/smoke.js <path>
 *
 * The script honours the same .env config as the server: tesseract is
 * called via the system binary, the LLM client is built from
 * LLM_INFERENCE_URL, Yandex from YANDEX_VISION_API_KEY. So this is a
 * faithful end-to-end test of everything except the queue and DB layers.
 *
 * Doesn't need Postgres or Redis to be running.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lookup as lookupMime } from 'mime-types';
import pino from 'pino';
import { runDocumentPipeline, runOcrChain } from '../pipeline/orchestrator.js';
import { combineConfidence } from '../pipeline/quality.js';
import { DOCUMENT_TYPES, type DocumentType } from '../types/documents.js';

type Args = {
  filePath: string;
  hint?: DocumentType;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let hint: DocumentType | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hint') {
      const v = argv[++i];
      if (!v || !DOCUMENT_TYPES.includes(v as DocumentType)) {
        throw new Error(`--hint must be one of ${DOCUMENT_TYPES.join(', ')}`);
      }
      hint = v as DocumentType;
    } else if (a && !a.startsWith('--')) {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    throw new Error('Usage: smoke <file> [--hint <type>]');
  }
  return { filePath: positional[0]!, hint };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const filePath = resolve(args.filePath);
  await stat(filePath); // throws ENOENT with a useful message if missing

  const mimeType = lookupMime(filePath) || 'application/octet-stream';
  const log = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'smoke',
  });

  log.info({ filePath, mimeType, hint: args.hint }, 'starting smoke run');
  const t0 = Date.now();

  const ocr = await runOcrChain({ filePath, mimeType }, log);
  const post = await runDocumentPipeline(ocr.text, { hint: args.hint }, log);
  const overall = combineConfidence(ocr.confidence, post.parserConfidence);

  const totalMs = Date.now() - t0;
  log.info({ totalMs }, 'smoke complete');

  const report = {
    file: filePath,
    mime_type: mimeType,
    duration_ms: totalMs,
    ocr: {
      engine: ocr.engine,
      confidence: round3(ocr.confidence),
      duration_ms: ocr.durationMs,
      text_length: ocr.text.length,
      text_preview: ocr.text.slice(0, 500),
    },
    classification: {
      document_type: post.documentType,
      source: post.classificationSource,
      matched: post.classificationMatch,
    },
    extraction: {
      parser_confidence: round3(post.parserConfidence ?? 0),
      missing_fields: post.parserMissing,
      extracted: post.extracted,
    },
    overall_confidence: round3(overall),
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke] failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
