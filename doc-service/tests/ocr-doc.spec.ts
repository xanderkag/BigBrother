/**
 * DocEngine — legacy .doc (Word 97-2003, x-cfb) routing.
 *
 * Юнит-тесты проверяют только маршрутизацию по MIME + extension (supports),
 * без запуска catdoc — бинарь есть только в Docker-образе.
 */
import { describe, it, expect } from 'vitest';
import { DocEngine } from '../src/pipeline/ocr/doc.js';

const engine = new DocEngine();

describe('DocEngine — routing', () => {
  it('supports x-cfb только с .doc extension (не .xls)', () => {
    expect(engine.supports({ filePath: 'u/Заявка_ИСТ-ВЕСТ.doc', mimeType: 'application/x-cfb' })).toBe(true);
    expect(engine.supports({ filePath: 'u/988726MBL.xls', mimeType: 'application/x-cfb' })).toBe(false);
  });

  it('supports native application/msword', () => {
    expect(engine.supports({ filePath: 'u/report.doc', mimeType: 'application/msword' })).toBe(true);
  });

  it('rejects docx / pdf / image', () => {
    expect(
      engine.supports({
        filePath: 'u/x.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe(false);
    expect(engine.supports({ filePath: 'u/x.pdf', mimeType: 'application/pdf' })).toBe(false);
    expect(engine.supports({ filePath: 'u/x.png', mimeType: 'image/png' })).toBe(false);
  });

  it('engine name = doc', () => {
    expect(engine.name).toBe('doc');
  });
});
