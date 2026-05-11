/**
 * In-process smoke runner. Bypasses Fastify, BullMQ, and the database —
 * runs the OCR chain and the post-OCR pipeline directly against a file
 * on disk and prints a structured report to stdout.
 *
 * Usage:
 *   tsx src/scripts/smoke.ts <path> [--hint invoice|TTN|CMR|UPD|AKT|factInvoice]
 *                                   [--ping-inference]   # pre-flight check
 *                                   [--out report.json]  # сохранить отчёт
 *
 * The script honours the same .env config as the server: tesseract via
 * system binary, LLM-client из LLM_INFERENCE_URL, Yandex из YANDEX_VISION_API_KEY.
 * Это E2E smoke всего, кроме очереди и БД.
 *
 * Зачем (важно): когда мы тестируем парсер на локальной модели через
 * Ollama / vLLM — единственный способ быстро убедиться, что цепочка
 * жива end-to-end. OCR-движок, prompt, formatter ответа, JSON-mode
 * совместимость, image_url через data URL — всё это проверяется
 * именно здесь. Прокатанный smoke = «разворот у клиента сработает».
 */

import { stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lookup as lookupMime } from 'mime-types';
import { request } from 'undici';
import pino from 'pino';
import { config } from '../config.js';
import { runDocumentPipeline, runOcrChain } from '../pipeline/orchestrator.js';
import { combineConfidence } from '../pipeline/quality.js';

type Args = {
  filePath: string;
  hint?: string;
  pingInference: boolean;
  outPath?: string;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let hint: string | undefined;
  let pingInference = false;
  let outPath: string | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hint') {
      const v = argv[++i];
      if (!v) throw new Error('--hint requires a value');
      // Любой непустой slug допустим — кастомные типы тоже валидны.
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)) {
        throw new Error('--hint must match [A-Za-z0-9_-]{1,64}');
      }
      hint = v;
    } else if (a === '--ping-inference') {
      pingInference = true;
    } else if (a === '--out') {
      outPath = argv[++i];
      if (!outPath) throw new Error('--out requires a path');
    } else if (a && !a.startsWith('--')) {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    throw new Error(
      'Usage: smoke <file> [--hint <type>] [--ping-inference] [--out <report.json>]',
    );
  }
  return { filePath: positional[0]!, hint, pingInference, outPath };
}

/**
 * Pre-flight: проверяем что inference-service отвечает и backend ready.
 * Без этого smoke на локальной модели иногда «зависал» на 60s timeout
 * первой extract-call'а, пока Ollama грузила weights — гораздо лучше
 * упасть с понятным сообщением сразу.
 */
async function pingInference(log: pino.Logger): Promise<void> {
  if (!config.llm.url) {
    log.warn('LLM_INFERENCE_URL не задан — пропускаю пинг inference-service');
    return;
  }
  const url = new URL('/ready', config.llm.url).toString();
  log.info({ url }, 'pinging inference-service');
  try {
    const res = await request(url, { method: 'GET', headersTimeout: 5000, bodyTimeout: 5000 });
    const body = (await res.body.json()) as { status?: string; backend?: string; reason?: string };
    if (body.status !== 'ready') {
      throw new Error(
        `inference-service не готов: status=${body.status} backend=${body.backend ?? '?'} reason=${
          body.reason ?? 'unknown'
        }`,
      );
    }
    log.info({ backend: body.backend }, 'inference-service ready');
  } catch (err) {
    throw new Error(
      `pre-flight ping failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Проверьте что inference-service запущен и модель загружена.',
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const filePath = resolve(args.filePath);
  await stat(filePath); // throws ENOENT с понятным сообщением

  const mimeType = lookupMime(filePath) || 'application/octet-stream';
  const log = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'smoke',
  });

  if (args.pingInference) {
    await pingInference(log);
  }

  log.info(
    { filePath, mimeType, hint: args.hint, llm_url: config.llm.url || '(none)' },
    'starting smoke run',
  );
  const t0 = Date.now();

  // --- OCR ---
  const tOcrStart = Date.now();
  const ocr = await runOcrChain({ filePath, mimeType }, log);
  const tOcr = Date.now() - tOcrStart;

  // --- Classify + Extract + Validate (объединено в runDocumentPipeline) ---
  const tPostStart = Date.now();
  const post = await runDocumentPipeline(ocr.text, { hint: args.hint }, log);
  const tPost = Date.now() - tPostStart;

  const overall = combineConfidence(ocr.confidence, post.parserConfidence);
  const totalMs = Date.now() - t0;
  log.info({ totalMs, t_ocr_ms: tOcr, t_post_ms: tPost }, 'smoke complete');

  const report = {
    file: filePath,
    mime_type: mimeType,
    duration: {
      total_ms: totalMs,
      ocr_ms: tOcr,
      // post = classification + extraction + validation; LLM-extract обычно
      // доминирует на нагруженных типах документов.
      post_ocr_ms: tPost,
    },
    inference_service: {
      url: config.llm.url || null,
    },
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
    validation: {
      issues: post.validationIssues,
      type_config_source: post.typeConfig?.source ?? null,
    },
    overall_confidence: round3(overall),
  };

  const json = JSON.stringify(report, null, 2);
  process.stdout.write(json + '\n');
  if (args.outPath) {
    await writeFile(resolve(args.outPath), json + '\n', 'utf8');
    log.info({ out: args.outPath }, 'report written');
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke] failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
