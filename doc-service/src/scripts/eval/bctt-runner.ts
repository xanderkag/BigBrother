/**
 * §9 (CLASSIFIER-PACKET-V2): прогон корпуса БКТ → results.json для eval-bctt.
 *
 * In-process (как smoke.ts): OCR → [P0-0] → мультидок(границы+splitter) или
 * single-doc classify → набор типов сегментов по файлу. Пишет results.json в
 * формате, который читает eval-bctt.ts.
 *
 * Запуск (на asha, где корпус + БД + OCR):
 *   tsx src/scripts/eval/bctt-runner.ts <corpus-dir> [--out bctt-results.json] [--full]
 *
 * По умолчанию — classify-only (без LLM-extract): быстро и детерминированно
 * меряет НАБОР ТИПОВ (M1/M2). Паспорт/ID-сегменты извлекаются allowlist'ом
 * {doc_kind,country,present} (без ПДн) — piiClean честно true. `--full`
 * добавляет реальный extract сегментов (нужен inference-service).
 *
 * ПДн: паспортный текст в classify/границах не покидает контур (regex/keyword,
 * не облако); в --full ID-сегменты всё равно идут через §8.5b buildIdSegmentExtract.
 */
import { readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { lookup as lookupMime } from 'mime-types';
import type { Logger } from 'pino';
import pino from 'pino';
import { config } from '../../config.js';
import { runOcrChain, runDocumentPipeline } from '../../pipeline/orchestrator.js';
import { tryMultiDoc } from '../../pipeline/multidoc/runner.js';
import { KeywordClassifier } from '../../pipeline/classifier/keywords.js';
import { splitCollapsedText } from '../../pipeline/multidoc/collapsed-pages.js';
import { isIdDocument, buildIdSegmentExtract } from '../../pipeline/normalize/id-allowlist.js';
import { normalizeSlugForApi } from '../../types/slug-normalize.js';
import type { DocumentTypeSlug } from '../../types/documents.js';

/** Поля-признаки ПДн: если хоть одно с непустым значением — extract «грязный». */
const PII_KEYS = new Set([
  'full_name', 'surname', 'given_names', 'name_individual', 'passport_number',
  'passport_no', 'personal_number', 'personal_code', 'mrz', 'date_of_birth', 'dob',
]);

function hasPii(extracted: Record<string, unknown> | null | undefined): boolean {
  if (!extracted || typeof extracted !== 'object') return false;
  for (const [k, v] of Object.entries(extracted)) {
    if (PII_KEYS.has(k) && v != null && v !== '') return true;
  }
  return false;
}

interface FileResult {
  file: string;
  types: string[];
  piiClean: boolean;
}

async function classifyFile(
  filePath: string,
  full: boolean,
  log: Logger,
): Promise<FileResult> {
  const mimeType = lookupMime(filePath) || 'application/octet-stream';
  const ocr = await runOcrChain({ filePath, mimeType }, log);

  // §P0-0: восстановить постраничность склеенного скана (если флаг включён).
  let mdOcr = ocr;
  if (config.classifier.segmentForcePageSplit && (!ocr.pages || ocr.pages.length <= 1)) {
    const pseudo = splitCollapsedText(ocr.text);
    if (pseudo.length >= 2) {
      const conf = ocr.confidence;
      mdOcr = { ...ocr, pages: pseudo.map((t) => ({ text: t, confidence: conf })) };
    }
  }

  // Мультидок-путь (композит).
  if (mdOcr.pages && mdOcr.pages.length > 1) {
    const classifier = new KeywordClassifier();
    const docs = await tryMultiDoc(mdOcr, {
      classifier,
      organizationId: null,
      extractSegment: async (text, type) => {
        // §8.5b: ID/паспорт-сегмент — allowlist из MRZ, без LLM.
        if (isIdDocument(type, null)) {
          return { extracted: buildIdSegmentExtract(text), fieldConfidence: {} };
        }
        if (!full) return { extracted: {}, fieldConfidence: {} };
        const seg = await runDocumentPipeline(text, { hint: type }, log);
        return { extracted: (seg.extracted ?? {}) as Record<string, unknown>, fieldConfidence: {} };
      },
      log,
    });
    if (docs && docs.length > 0) {
      const types = docs
        .map((d) => normalizeSlugForApi(d.document_type))
        .filter((t): t is DocumentTypeSlug => !!t);
      const piiClean = docs.every((d) => !hasPii(d.extracted));
      return { file: basename(filePath), types, piiClean };
    }
  }

  // Single-doc: classify-only (без extract) — тип из классификатора.
  const post = await runDocumentPipeline(
    ocr.text,
    { fileName: basename(filePath), classifyOnly: !full },
    log,
  );
  const slug = normalizeSlugForApi(post.documentType);
  return {
    file: basename(filePath),
    types: slug ? [slug] : [],
    piiClean: !hasPii(post.extracted as Record<string, unknown> | null),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const full = argv.includes('--full');
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : 'bctt-results.json';
  const dir = argv.find((a) => !a.startsWith('--') && a !== outPath);
  if (!dir) {
    console.error('Usage: bctt-runner <corpus-dir> [--out results.json] [--full]');
    process.exit(2);
  }
  const corpusDir = resolve(dir);
  const log = pino({ level: process.env.LOG_LEVEL ?? 'warn', name: 'bctt-runner' });

  const entries = await readdir(corpusDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => join(corpusDir, e.name));

  console.error(`bctt-runner: ${files.length} файлов, режим=${full ? 'full' : 'classify-only'}`);
  const results: FileResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    try {
      const r = await classifyFile(f, full, log);
      results.push(r);
      console.error(`  [${i + 1}/${files.length}] ${r.file} → ${r.types.join(', ') || '(none)'}`);
    } catch (err) {
      console.error(`  [${i + 1}/${files.length}] ${basename(f)} → ОШИБКА: ${err instanceof Error ? err.message : String(err)}`);
      results.push({ file: basename(f), types: [], piiClean: true });
    }
  }

  await writeFile(resolve(outPath!), JSON.stringify({ results }, null, 2) + '\n', 'utf8');
  console.error(`bctt-runner: результат → ${outPath}. Дальше: tsx src/scripts/eval-bctt.ts ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[bctt-runner] failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
