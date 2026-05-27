import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';

const execP = promisify(exec);

type YandexConfig = {
  apiKey?: string;
  folderId?: string;
  timeoutMs: number;
  /**
   * OCR-модель Yandex recognizeText. `page` — обычный текст страницы (default).
   * Альтернативы: `table` (распознавание таблиц), `page-column-sort`,
   * `handwritten`. Конфигурируется через YANDEX_OCR_MODEL.
   */
  model: string;
  /**
   * Модель для табличных типов (счёт-фактура/УПД скан). Применяется когда
   * documentType входит в `tableModelTypes`. По умолчанию `table`.
   */
  tableModel?: string;
  /** Slug'и типов, для которых OCR идёт через `tableModel` (UPPER-case). */
  tableModelTypes?: string[];
};

const OCR_ENDPOINT = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText';

/**
 * Yandex Cloud OCR — last-resort engine. Only used when other engines fall
 * through their thresholds, and only if API key + folder are configured.
 *
 * Targets the current synchronous OCR API (`ocr/v1/recognizeText`), not the
 * deprecated `vision/v1/batchAnalyze` (TECH_DEBT I6). Folder is passed as the
 * `x-folder-id` header; the body is flat (`content`/`mimeType`/`languageCodes`/
 * `model`). Auth stays Api-Key.
 *
 * NOTE: the synchronous endpoint recognizes at most ONE PDF page per call. For
 * multi-page input we send page-by-page using the orchestrator's pre-rasterized
 * PNGs (`input.rasterizedPages`); the same `processPages` pattern as tesseract.
 *
 * NOTE on PII: this engine uploads document images to a third-party cloud. We
 * always set `x-data-logging-enabled: false` so Yandex does not retain our
 * document data. For documents that may contain personal data (TTN with driver
 * passport, CMR with sender contacts), the orchestrator additionally skips
 * yandex via the `YANDEX_DISABLE_FOR_PII` env flag (I8) or the per-job
 * `metadata._disable_external_ocr=true` opt-out — both wired through
 * orchestrator → router → engine chain.
 */
export class YandexVisionEngine implements OcrEngine {
  readonly name = 'yandex' as const;

  // Yandex is the final fallback — accept whatever it returns. The orchestrator
  // ranks results by confidence regardless.
  readonly acceptanceThreshold = 0;

  constructor(private readonly cfg: YandexConfig) {}

  supports(input: OcrInput): boolean {
    return (
      input.mimeType === 'application/pdf' ||
      input.mimeType.startsWith('image/')
    );
  }

  isAvailable(): boolean {
    return !!this.cfg.apiKey && !!this.cfg.folderId;
  }

  /**
   * Выбор OCR-модели для конкретного входа. Приоритет (от старшего):
   *   1. per-job `metadata._yandex_ocr_model` (input.yandexModelOverride);
   *   2. per-type `tableModel`, если documentType ∈ tableModelTypes;
   *   3. дефолтная `model` (YANDEX_OCR_MODEL).
   * Чисто конфиг-driven — ничего не хардкодим.
   */
  private resolveModel(input: OcrInput): string {
    const override = input.yandexModelOverride?.trim();
    if (override) return override;
    const docType = input.documentType?.trim().toUpperCase();
    if (
      docType &&
      this.cfg.tableModelTypes &&
      this.cfg.tableModelTypes.includes(docType)
    ) {
      return this.cfg.tableModel ?? 'table';
    }
    return this.cfg.model;
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const started = Date.now();
    const model = this.resolveModel(input);

    // Multi-page path: orchestrator pre-rasterized the PDF into page PNGs.
    // recognizeText accepts only one page per call, so loop. (A5/F5 parity
    // with tesseract — populates `pages[]` so multi-doc splitting works.)
    if (input.rasterizedPages && input.rasterizedPages.length > 0) {
      return this.processPages(input.rasterizedPages, started, model);
    }

    // Standalone PDF (no orchestrator pre-rasterization, e.g. tests/smoke):
    // the sync API only reads page 1, so rasterize ourselves like tesseract.
    if (input.mimeType === 'application/pdf') {
      return this.runOnPdf(input, started, model);
    }

    // Single image — one call.
    const buf = await readFile(input.filePath);
    const page = await this.recognize(buf, input.mimeType, model);
    return {
      engine: this.name,
      text: page.text,
      confidence: page.confidence,
      durationMs: Date.now() - started,
    };
  }

  private async runOnPdf(input: OcrInput, started: number, model: string): Promise<OcrResult> {
    const workDir = await mkdtemp(join(tmpdir(), 'docsvc-yandex-'));
    try {
      const prefix = join(workDir, 'page');
      await execP(`pdftoppm -png -r 200 "${input.filePath}" "${prefix}"`, { timeout: 120_000 });
      const pageFiles = (await readdir(workDir))
        .filter((f) => f.startsWith('page') && f.endsWith('.png'))
        .sort()
        .map((f) => join(workDir, f));
      return this.processPages(pageFiles, started, model);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Recognize an already-rasterized list of page PNG paths, one call each. */
  private async processPages(
    pageFiles: string[],
    started: number,
    model: string,
  ): Promise<OcrResult> {
    const pages: Array<{ text: string; confidence: number }> = [];
    for (const pf of pageFiles) {
      const buf = await readFile(pf);
      pages.push(await this.recognize(buf, 'image/png', model));
    }

    const fullText = pages.map((p) => p.text).join('\n\n');
    const avgConfidence =
      pages.length === 0 ? 0 : pages.reduce((a, p) => a + p.confidence, 0) / pages.length;

    return {
      engine: this.name,
      text: fullText,
      confidence: avgConfidence,
      pages,
      durationMs: Date.now() - started,
    };
  }

  /** Single recognizeText call for one image/page. */
  private async recognize(
    buf: Buffer,
    mimeType: string,
    model: string,
  ): Promise<{ text: string; confidence: number }> {
    const body = {
      content: buf.toString('base64'),
      mimeType,
      languageCodes: ['ru', 'en'],
      model,
    };

    const res = await request(OCR_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Api-Key ${this.cfg.apiKey}`,
        'x-folder-id': this.cfg.folderId ?? '',
        // PII-safety: opt out of Yandex retaining our document data.
        'x-data-logging-enabled': 'false',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      headersTimeout: this.cfg.timeoutMs,
      bodyTimeout: this.cfg.timeoutMs,
    });

    if (res.statusCode >= 400) {
      const errText = await res.body.text();
      throw new Error(`Yandex OCR ${res.statusCode}: ${errText.slice(0, 500)}`);
    }

    const data = (await res.body.json()) as YandexOcrResponse;
    return { text: extractText(data), confidence: estimateConfidence(data) };
  }
}

// --- Yandex recognizeText response shape (minimal — only fields we read) ---
type YandexWord = { text?: string; confidence?: number };
type YandexLine = { text?: string; words?: YandexWord[] };
type YandexBlock = { lines?: YandexLine[] };
type YandexOcrResponse = {
  result?: {
    textAnnotation?: {
      fullText?: string;
      blocks?: YandexBlock[];
    };
  };
};

function extractText(data: YandexOcrResponse): string {
  const ann = data.result?.textAnnotation;
  if (!ann) return '';
  // Prefer the whole-text field; fall back to walking blocks → lines.
  if (typeof ann.fullText === 'string' && ann.fullText.length > 0) {
    return ann.fullText.trim();
  }
  const lines: string[] = [];
  for (const block of ann.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const lineText =
        line.text ??
        (line.words ?? [])
          .map((w) => w.text ?? '')
          .filter(Boolean)
          .join(' ');
      if (lineText) lines.push(lineText);
    }
  }
  return lines.join('\n');
}

function estimateConfidence(data: YandexOcrResponse): number {
  const confs: number[] = [];
  for (const block of data.result?.textAnnotation?.blocks ?? []) {
    for (const line of block.lines ?? []) {
      for (const word of line.words ?? []) {
        if (typeof word.confidence === 'number') confs.push(word.confidence);
      }
    }
  }
  if (confs.length === 0) return 0.7; // Yandex often omits confidence; assume "good enough"
  return confs.reduce((a, b) => a + b, 0) / confs.length;
}
