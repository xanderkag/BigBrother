import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tesseract from 'node-tesseract-ocr';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';
import { normalizeTesseractConfidence } from '../quality.js';

const execP = promisify(exec);

const PDF_MIMES = new Set(['application/pdf']);
const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/bmp',
  'image/tiff',
  'image/webp',
]);

/**
 * Local OCR via the system `tesseract` binary (with poppler-utils' `pdftoppm`
 * for rasterizing PDFs page-by-page). Both binaries are installed in the
 * Docker image. Confidence is heuristic: tesseract.js exposes per-word
 * confidence, but node-tesseract-ocr returns plain text — so we approximate
 * via output length + recognized-character density. Replace with a finer
 * signal when we move off this wrapper.
 *
 * A5: if the orchestrator pre-rasterized the PDF (`input.rasterizedPages`),
 * we skip our own pdftoppm call and use those pages directly.
 */
export class TesseractEngine implements OcrEngine {
  readonly name = 'tesseract' as const;

  constructor(
    public readonly acceptanceThreshold: number,
    private readonly languages: string,
  ) {}

  supports(input: OcrInput): boolean {
    return PDF_MIMES.has(input.mimeType) || IMAGE_MIMES.has(input.mimeType);
  }

  isAvailable(): boolean {
    return true; // assumed installed in the Docker image
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const started = Date.now();

    if (PDF_MIMES.has(input.mimeType)) {
      return this.runOnPdf(input, started);
    }
    return this.runOnImage(input.filePath, started);
  }

  private async runOnImage(filePath: string, started: number): Promise<OcrResult> {
    const text = (
      await tesseract.recognize(filePath, {
        lang: this.languages,
        oem: 1,
        psm: 3,
      })
    ).trim();
    return {
      engine: this.name,
      text,
      confidence: this.scoreText(text),
      durationMs: Date.now() - started,
    };
  }

  private async runOnPdf(input: OcrInput, started: number): Promise<OcrResult> {
    // A5: use orchestrator-provided pages when available — avoids a second
    // pdftoppm call on the same file if vision-llm is tried afterwards.
    if (input.rasterizedPages && input.rasterizedPages.length > 0) {
      return this.processPages(input.rasterizedPages, started);
    }

    // Fallback: rasterize independently (e.g., called standalone in tests
    // or smoke scripts without the orchestrator pre-rasterization).
    const workDir = await mkdtemp(join(tmpdir(), 'docsvc-tess-'));
    try {
      // Rasterize at 200 DPI; balance between OCR accuracy and speed.
      // pdftoppm writes <prefix>-NNN.png for each page.
      const prefix = join(workDir, 'page');
      await execP(`pdftoppm -png -r 200 "${input.filePath}" "${prefix}"`, { timeout: 120_000 });

      const pageFiles = (await readdir(workDir))
        .filter((f) => f.startsWith('page') && f.endsWith('.png'))
        .sort()
        .map((f) => join(workDir, f));

      return this.processPages(pageFiles, started);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Run tesseract on an already-rasterized list of page PNG paths. */
  private async processPages(pageFiles: string[], started: number): Promise<OcrResult> {
    const pages: Array<{ text: string; confidence: number }> = [];
    for (const pf of pageFiles) {
      const pageText = (
        await tesseract.recognize(pf, {
          lang: this.languages,
          oem: 1,
          psm: 3,
        })
      ).trim();
      pages.push({ text: pageText, confidence: this.scoreText(pageText) });
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

  /**
   * Heuristic confidence for tesseract output. Replace with per-word
   * confidence (TSV mode) once we wrap the binary directly.
   */
  private scoreText(text: string): number {
    if (text.length < 20) return 0;
    const letters = (text.match(/[\p{L}]/gu) ?? []).length;
    const density = letters / Math.max(1, text.length);
    let raw = 0;
    if (letters > 200) raw += 0.5;
    else if (letters > 50) raw += 0.3;
    if (density > 0.5) raw += 0.3;
    else if (density > 0.3) raw += 0.15;
    if (/\d{2}[./-]\d{2}[./-]\d{2,4}/.test(text)) raw += 0.05;
    if (/(ИНН|КПП|НДС|Итого|Сумма)/i.test(text)) raw += 0.1;
    return normalizeTesseractConfidence(raw);
  }
}
