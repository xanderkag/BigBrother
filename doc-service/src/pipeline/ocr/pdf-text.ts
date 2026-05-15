import { readFile } from 'node:fs/promises';
// Import the implementation file directly: pdf-parse's index.js has a debug
// branch that auto-loads a test PDF from its own package on first require,
// which trips up some module resolvers.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';
import { scorePdfText } from '../quality.js';

/**
 * Кастомная ошибка для PDF-engine с структурным `code`. Orchestrator её
 * перехватывает и финализирует job со статусом failed + понятным error_code
 * для UI (PASSWORD_REQUIRED / CORRUPTED). Без этого падало со stacktrace
 * вида «No password given» прямо в логе оператора.
 */
export class PdfParseError extends Error {
  constructor(
    public readonly code: 'PASSWORD_REQUIRED' | 'CORRUPTED' | 'EMPTY_PDF',
    message: string,
  ) {
    super(message);
    this.name = 'PdfParseError';
  }
}

/**
 * pdf-parse под капотом использует pdfjs-dist, который бросает разные ошибки:
 *   - `PasswordException` или сообщение `No password given` / `Incorrect password`
 *     → encrypted PDF
 *   - `InvalidPDFException` / `Invalid PDF` / `bad XRef` / `Unexpected end` →
 *     повреждённый файл
 * Не используем `instanceof` потому что pdfjs упаковывает классы внутрь
 * (не экспортируются на публичный API); матчим по message + constructor.name.
 */
function classifyPdfError(err: unknown): PdfParseError {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const ctorName = (err as { constructor?: { name?: string } } | null)?.constructor?.name;

  if (
    lower.includes('password') ||
    lower.includes('encrypted') ||
    ctorName === 'PasswordException'
  ) {
    return new PdfParseError(
      'PASSWORD_REQUIRED',
      'PDF защищён паролем. Удалите защиту и загрузите снова.',
    );
  }
  if (
    lower.includes('invalid pdf') ||
    lower.includes('bad xref') ||
    lower.includes('unexpected end') ||
    lower.includes('missing pdf') ||
    lower.includes('formaterror') ||
    ctorName === 'InvalidPDFException' ||
    ctorName === 'FormatError'
  ) {
    return new PdfParseError(
      'CORRUPTED',
      `PDF повреждён или обрезан: ${msg.slice(0, 200)}`,
    );
  }
  // Неизвестная ошибка — лучше CORRUPTED с понятным текстом, чем сырой stacktrace
  return new PdfParseError('CORRUPTED', `Не удалось разобрать PDF: ${msg.slice(0, 200)}`);
}

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
    if (buf.length === 0) {
      throw new PdfParseError('EMPTY_PDF', 'PDF-файл пустой (0 байт)');
    }
    let parsed;
    try {
      parsed = await pdfParse(buf);
    } catch (err) {
      throw classifyPdfError(err);
    }
    const text = (parsed.text ?? '').trim();
    return {
      engine: this.name,
      text,
      confidence: scorePdfText(text),
      durationMs: Date.now() - started,
    };
  }
}
