/**
 * PdfTextEngine error classification — encrypted, corrupted, empty.
 * Реальные PDF-файлы не нужны: тестируем что engine ругается понятным
 * error_code на разные классы ошибок от pdf-parse.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PdfTextEngine, PdfParseError } from '../src/pipeline/ocr/pdf-text.js';

function writeTmpFile(content: Buffer | string, ext = '.pdf'): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-test-'));
  const path = join(dir, `test${ext}`);
  writeFileSync(path, content);
  return path;
}

const engine = new PdfTextEngine(0.9);

describe('PdfTextEngine error handling', () => {
  it('EMPTY_PDF на 0-байтовом файле', async () => {
    const path = writeTmpFile(Buffer.alloc(0));
    try {
      await engine.run({ filePath: path, mimeType: 'application/pdf' });
      expect.fail('должно было бросить PdfParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(PdfParseError);
      expect((err as PdfParseError).code).toBe('EMPTY_PDF');
    }
  });

  it('CORRUPTED на не-PDF контенте', async () => {
    const path = writeTmpFile('not a pdf, just text');
    try {
      await engine.run({ filePath: path, mimeType: 'application/pdf' });
      expect.fail('должно было бросить PdfParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(PdfParseError);
      expect((err as PdfParseError).code).toBe('CORRUPTED');
    }
  });

  it('CORRUPTED на обрезанном PDF (хедер есть, тело нет)', async () => {
    // %PDF-1.4 + случайный мусор — pdfjs не сможет XRef прочитать
    const path = writeTmpFile(Buffer.from('%PDF-1.4\n\n\xff\xff\xff\xff'));
    try {
      await engine.run({ filePath: path, mimeType: 'application/pdf' });
      expect.fail('должно было бросить PdfParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(PdfParseError);
      expect((err as PdfParseError).code).toBe('CORRUPTED');
    }
  });
});
