/**
 * HeicHandler — unit-тесты на detect(). Реальное конвертирование
 * heif-convert тестируется в integration-suite (он требует бинарь
 * libheif-examples в системе и реальный HEIC-файл).
 */

import { describe, expect, it } from 'vitest';
import { HeicHandler } from '../src/pipeline/preprocess/heic.js';

describe('HeicHandler.detect', () => {
  const handler = new HeicHandler();

  it('подхватывает по MIME image/heic', () => {
    expect(
      handler.detect({
        filePath: '/tmp/x',
        fileName: 'photo.heic',
        detectedMime: 'image/heic',
        sizeBytes: 100,
      }),
    ).toBe(true);
  });

  it('подхватывает по MIME image/heif', () => {
    expect(
      handler.detect({
        filePath: '/tmp/x',
        fileName: 'photo.heif',
        detectedMime: 'image/heif',
        sizeBytes: 100,
      }),
    ).toBe(true);
  });

  it('подхватывает по расширению .heic даже без MIME', () => {
    expect(
      handler.detect({
        filePath: '/tmp/x',
        fileName: 'IMG_1234.HEIC',
        detectedMime: undefined,
        sizeBytes: 100,
      }),
    ).toBe(true);
  });

  it('игнорирует JPG / PNG / PDF', () => {
    for (const mime of ['image/jpeg', 'image/png', 'application/pdf']) {
      expect(
        handler.detect({
          filePath: '/tmp/x',
          fileName: 'doc.pdf',
          detectedMime: mime,
          sizeBytes: 100,
        }),
      ).toBe(false);
    }
  });

  it('имя без расширения и без MIME — не наш', () => {
    expect(
      handler.detect({
        filePath: '/tmp/x',
        fileName: 'unknown',
        detectedMime: undefined,
        sizeBytes: 100,
      }),
    ).toBe(false);
  });
});
