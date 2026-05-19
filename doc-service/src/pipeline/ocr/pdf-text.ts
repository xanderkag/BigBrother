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
    // F5: capture per-page text alongside the concatenated blob. pdf-parse
    // invokes our `pagerender` once per page; we wrap its default text
    // assembly and tee a copy into `pageTexts` so the multi-doc splitter
    // can classify each page independently.
    const pageTexts: string[] = [];
    let parsed;
    try {
      parsed = await pdfParse(buf, { pagerender: renderPageAndCapture(pageTexts) });
    } catch (err) {
      throw classifyPdfError(err);
    }
    const text = (parsed.text ?? '').trim();
    const pages =
      pageTexts.length > 0
        ? pageTexts.map((t) => {
            const trimmed = t.trim();
            return { text: trimmed, confidence: scorePdfText(trimmed) };
          })
        : undefined;
    return {
      engine: this.name,
      text,
      confidence: scorePdfText(text),
      pages,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * pdf-parse default `pagerender` reconstructs page text from
 * pdfjs TextContent. We re-implement it verbatim, then push the
 * result into the closure-captured `out` array before returning —
 * keeps the concatenated `parsed.text` identical to the library
 * default while exposing per-page text for F5 multi-doc detection.
 */
function renderPageAndCapture(out: string[]) {
  return async function pagerender(pageData: {
    getTextContent: (opts: {
      normalizeWhitespace: boolean;
      disableCombineTextItems: boolean;
    }) => Promise<{ items: Array<{ str: string; transform: number[] }> }>;
  }): Promise<string> {
    const textContent = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    let lastY: number | undefined;
    let text = '';
    for (const item of textContent.items) {
      const y = item.transform[5];
      if (lastY === y || lastY === undefined) {
        text += item.str;
      } else {
        text += '\n' + item.str;
      }
      lastY = y;
    }
    out.push(text);
    return text;
  };
}
