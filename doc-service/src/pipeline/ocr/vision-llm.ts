import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';
import type { LlmClient } from '../llm/types.js';

const execP = promisify(exec);

const PDF_MIMES = new Set(['application/pdf']);
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/bmp', 'image/tiff', 'image/webp']);

/**
 * OCR via the external LLM inference-service (e.g., Qwen-VL). Wraps the
 * `LlmClient.visionOcr` call in the OcrEngine interface so the orchestrator
 * doesn't know it's talking to an LLM.
 *
 * For PDFs, the engine rasterizes pages with pdftoppm and runs vision-OCR per
 * page, then concatenates. Multi-page PDFs are expensive here — keep this
 * engine as a fallback after tesseract.
 */
export class VisionLlmEngine implements OcrEngine {
  readonly name = 'vision-llm' as const;

  constructor(
    public readonly acceptanceThreshold: number,
    private readonly llm: LlmClient,
  ) {}

  supports(input: OcrInput): boolean {
    return PDF_MIMES.has(input.mimeType) || IMAGE_MIMES.has(input.mimeType);
  }

  isAvailable(): boolean {
    return this.llm.isAvailable();
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const started = Date.now();

    if (IMAGE_MIMES.has(input.mimeType)) {
      const r = await this.llm.visionOcr({ imagePath: input.filePath });
      return {
        engine: this.name,
        text: r.text.trim(),
        confidence: r.confidence,
        durationMs: Date.now() - started,
      };
    }

    // PDF: rasterize, OCR each page via LLM, average.
    const workDir = await mkdtemp(join(tmpdir(), 'docsvc-vlm-'));
    try {
      const prefix = join(workDir, 'page');
      await execP(`pdftoppm -png -r 200 "${input.filePath}" "${prefix}"`, { timeout: 120_000 });

      const pageFiles = (await readdir(workDir))
        .filter((f) => f.startsWith('page') && f.endsWith('.png'))
        .sort();

      const pages: Array<{ text: string; confidence: number }> = [];
      for (const pf of pageFiles) {
        const r = await this.llm.visionOcr({ imagePath: join(workDir, pf) });
        pages.push({ text: r.text.trim(), confidence: r.confidence });
      }

      const text = pages.map((p) => p.text).join('\n\n');
      const confidence =
        pages.length === 0 ? 0 : pages.reduce((a, p) => a + p.confidence, 0) / pages.length;

      return { engine: this.name, text, confidence, pages, durationMs: Date.now() - started };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
