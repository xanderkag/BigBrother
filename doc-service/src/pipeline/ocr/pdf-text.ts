import { readFile } from 'node:fs/promises';
// Import the implementation file directly: pdf-parse's index.js has a debug
// branch that auto-loads a test PDF from its own package on first require,
// which trips up some module resolvers.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';
import { scorePdfText } from '../quality.js';

export class PdfTextEngine implements OcrEngine {
  readonly name = 'pdf-text' as const;

  constructor(public readonly acceptanceThreshold: number) {}

  supports(input: OcrInput): boolean {
    return input.mimeType === 'application/pdf' || input.filePath.toLowerCase().endsWith('.pdf');
  }

  isAvailable(): boolean {
    return true; // pure JS, no external dependency
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const started = Date.now();
    const buf = await readFile(input.filePath);
    const parsed = await pdfParse(buf);
    const text = (parsed.text ?? '').trim();
    return {
      engine: this.name,
      text,
      confidence: scorePdfText(text),
      durationMs: Date.now() - started,
    };
  }
}
