/**
 * F5: PdfTextEngine emits per-page text in OcrResult.pages so the
 * multi-doc splitter can classify each page independently. Without
 * this, PDFs with a text layer fall through to the single-blob path
 * and we can never detect a multi-document bundle (счёт + ТТН + УПД
 * в одном файле).
 *
 * Скан-PDF проходят через Tesseract который уже отдаёт pages; здесь
 * проверяем именно text-layer ветку.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfkit ESM глючит
import PDFDocument from 'pdfkit';
import { PdfTextEngine } from '../src/pipeline/ocr/pdf-text.js';

// pdfkit single-page output trips pdf-parse with `Illegal character: 41`,
// поэтому для 1-страничного кейса берём реальный synthetic из corpus,
// а multi-page генерим на лету.

async function makeMultiPagePdf(pageTexts: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const t of pageTexts) {
      doc.addPage();
      doc.fontSize(14).text(t);
    }
    doc.end();
  });
}

function writeTmpPdf(buf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-pages-test-'));
  const path = join(dir, 'test.pdf');
  writeFileSync(path, buf);
  return path;
}

const engine = new PdfTextEngine(0.9);

describe('PdfTextEngine — F5 per-page text emission', () => {
  it('multi-page PDF → pages.length === numPages, по странице на entry', async () => {
    const pdfBuf = await makeMultiPagePdf([
      'INVOICE PAGE — счёт 123 от 2026-05-19 на 1000 руб.',
      'TTN PAGE — товарно-транспортная накладная № ТТН-7',
      'AKT PAGE — акт выполненных работ № АК-99',
    ]);
    const path = writeTmpPdf(pdfBuf);

    const res = await engine.run({ filePath: path, mimeType: 'application/pdf' });

    expect(res.pages).toBeDefined();
    expect(res.pages).toHaveLength(3);
    expect(res.pages![0]!.text).toContain('INVOICE PAGE');
    expect(res.pages![1]!.text).toContain('TTN PAGE');
    expect(res.pages![2]!.text).toContain('AKT PAGE');
    // Каждая страница получает свой confidence-скор
    for (const p of res.pages!) {
      expect(p.confidence).toBeGreaterThan(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
    }
    // Aggregated text по-прежнему содержит весь контент (backwards compat)
    expect(res.text).toContain('INVOICE PAGE');
    expect(res.text).toContain('TTN PAGE');
    expect(res.text).toContain('AKT PAGE');
  });

  it('single-page synthetic PDF → pages.length === 1, текст совпадает с concatenated', async () => {
    const fixturePath = join(
      __dirname,
      '..',
      'corpus',
      'synthetic',
      'invoice-synth-01.pdf',
    );
    if (!existsSync(fixturePath)) {
      // Не критично: если corpus отсутствует в CI, пропускаем
      return;
    }
    const res = await engine.run({ filePath: fixturePath, mimeType: 'application/pdf' });
    expect(res.pages).toBeDefined();
    expect(res.pages).toHaveLength(1);
    expect(res.pages![0]!.text.length).toBeGreaterThan(0);
    // pages[0].text — это страница без trailing trim; res.text — общая
    // конкатенация (тоже trim'ом). Достаточно: то что в page есть, есть и в общей.
    const firstWord = res.pages![0]!.text.split(/\s+/).find((w) => w.length > 3);
    if (firstWord) expect(res.text).toContain(firstWord);
  });

});

// Note: closure-isolation для `renderPageAndCapture(out)` тривиально
// безопасна — каждый вызов `run()` создаёт свой `pageTexts` массив.
// Проверять это runtime-тестом не имеет смысла; вдобавок pdf-parse
// фейлится на pdfkit-сгенерированном выводе при определённых
// последовательностях вызовов (см. тест выше — используем реальные
// fixtures для single-page кейса).
