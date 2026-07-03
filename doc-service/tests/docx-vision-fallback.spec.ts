/**
 * P1-B (OFFICE_FILES_V2 §3): vision-fallback для картиночных docx.
 *
 * Юнит-тестим рискованную ЧИСТУЮ логику отбора картинок (selectImagesForVision:
 * порог/сортировка/кап). Сам run() через mammoth не гоняем — реальный .docx-
 * фикстуры нет, а фабриковать zip-OOXML хрупко. Проверяем ещё, что DocxEngine
 * без visionOcr конструируется и его routing (supports/name) не сломан.
 */
import { describe, it, expect } from 'vitest';
import { DocxEngine, selectImagesForVision } from '../src/pipeline/ocr/docx.js';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const img = (bytes: number): { buffer: Buffer } => ({ buffer: Buffer.alloc(bytes) });

describe('selectImagesForVision', () => {
  it('отбрасывает картинки мельче порога', () => {
    const out = selectImagesForVision([img(10), img(100), img(49)], 50, 8);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(100);
  });

  it('картинка ровно на пороге проходит (>=)', () => {
    const out = selectImagesForVision([img(50)], 50, 8);
    expect(out).toHaveLength(1);
  });

  it('сортирует крупнейшие первыми', () => {
    const out = selectImagesForVision([img(60), img(300), img(120)], 50, 8);
    expect(out.map((b) => b.length)).toEqual([300, 120, 60]);
  });

  it('капит до max штук (крупнейшие)', () => {
    const out = selectImagesForVision([img(100), img(500), img(300), img(200)], 50, 2);
    expect(out.map((b) => b.length)).toEqual([500, 300]);
  });

  it('пусто когда ни одна не проходит порог', () => {
    expect(selectImagesForVision([img(10), img(20)], 50, 8)).toEqual([]);
  });

  it('пусто на пустом входе', () => {
    expect(selectImagesForVision([], 50, 8)).toEqual([]);
  });

  it('max=0 → пусто', () => {
    expect(selectImagesForVision([img(100), img(200)], 50, 0)).toEqual([]);
  });
});

describe('DocxEngine — конструктор и routing', () => {
  it('new DocxEngine() без visionOcr не бросает', () => {
    expect(() => new DocxEngine()).not.toThrow();
  });

  it('new DocxEngine(fn) с visionOcr не бросает', () => {
    expect(
      () => new DocxEngine(() => Promise.resolve({ text: '', confidence: 0 })),
    ).not.toThrow();
  });

  it('supports() и name не изменились', () => {
    const engine = new DocxEngine();
    expect(engine.name).toBe('docx');
    expect(engine.supports({ filePath: 'u/x.docx', mimeType: DOCX_MIME })).toBe(true);
    expect(engine.supports({ filePath: 'u/x.pdf', mimeType: 'application/pdf' })).toBe(false);
    expect(engine.isAvailable()).toBe(true);
  });
});
