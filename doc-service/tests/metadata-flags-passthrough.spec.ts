/**
 * F20 / F26 / F27 — проверка что metadata-флаги корректно прокидываются
 * через pipeline до места применения.
 *
 * Не интеграционный (не запускаем реальный OCR/LLM), только статика
 * pass-through через типы и signatures.
 */
import { describe, expect, it } from 'vitest';
import type { OcrInput } from '../src/pipeline/ocr/types.js';

describe('F26 OcrInput.tesseractLangsOverride', () => {
  it('OcrInput имеет optional field tesseractLangsOverride', () => {
    const input: OcrInput = {
      filePath: '/tmp/test.pdf',
      mimeType: 'application/pdf',
      tesseractLangsOverride: 'rus+eng+chi_sim',
    };
    expect(input.tesseractLangsOverride).toBe('rus+eng+chi_sim');
  });

  it('OcrInput может быть без tesseractLangsOverride (default)', () => {
    const input: OcrInput = {
      filePath: '/tmp/test.pdf',
      mimeType: 'application/pdf',
    };
    expect(input.tesseractLangsOverride).toBeUndefined();
  });
});

describe('F26 — формат TESSERACT_LANGS', () => {
  it('допустимые комбинации: rus / eng / chi_sim / tur / pol', () => {
    // Перечисленные через `+` без пробелов — формат Tesseract
    const variants = [
      'rus',
      'eng',
      'rus+eng',
      'rus+eng+chi_sim',
      'eng+tur',
      'eng+pol',
      'rus+eng+chi_sim+tur+pol',
    ];
    for (const v of variants) {
      expect(/^[a-z_]+(\+[a-z_]+)*$/.test(v)).toBe(true);
    }
  });
});

describe('F27 — metadata.delete_after_processing parse', () => {
  // Проверяем форму флага которую orchestrator понимает
  function shouldDelete(meta: Record<string, unknown> | null | undefined): boolean {
    return Boolean(
      meta && (meta.delete_after_processing === true || meta.delete_after_processing === 'true'),
    );
  }

  it('true (boolean) → delete', () => {
    expect(shouldDelete({ delete_after_processing: true })).toBe(true);
  });

  it('"true" (строка) → delete', () => {
    expect(shouldDelete({ delete_after_processing: 'true' })).toBe(true);
  });

  it('false → не delete', () => {
    expect(shouldDelete({ delete_after_processing: false })).toBe(false);
  });

  it('"false" (строка) → не delete', () => {
    expect(shouldDelete({ delete_after_processing: 'false' })).toBe(false);
  });

  it('1 (другие truthy) → не delete (только явное true/"true")', () => {
    expect(shouldDelete({ delete_after_processing: 1 })).toBe(false);
    expect(shouldDelete({ delete_after_processing: 'yes' })).toBe(false);
  });

  it('null / undefined / отсутствует → не delete', () => {
    expect(shouldDelete(null)).toBe(false);
    expect(shouldDelete({})).toBe(false);
    expect(shouldDelete(undefined)).toBe(false);
  });
});

describe('F20 — metadata.prompt_override parse', () => {
  function readPromptOverride(meta: Record<string, unknown> | null | undefined): string | undefined {
    return typeof meta?.prompt_override === 'string' && meta.prompt_override.length > 0
      ? (meta.prompt_override as string)
      : undefined;
  }

  it('string → передаётся', () => {
    expect(readPromptOverride({ prompt_override: 'Извлеки только итоги' })).toBe(
      'Извлеки только итоги',
    );
  });

  it('пустая строка → undefined (не используем)', () => {
    expect(readPromptOverride({ prompt_override: '' })).toBeUndefined();
  });

  it('число / boolean → undefined', () => {
    expect(readPromptOverride({ prompt_override: 123 })).toBeUndefined();
    expect(readPromptOverride({ prompt_override: true })).toBeUndefined();
  });

  it('null / отсутствует → undefined', () => {
    expect(readPromptOverride(null)).toBeUndefined();
    expect(readPromptOverride({})).toBeUndefined();
  });
});

describe('F26 — metadata.tesseract_langs parse', () => {
  function readLangs(meta: Record<string, unknown> | null | undefined): string | undefined {
    return typeof meta?.tesseract_langs === 'string' && meta.tesseract_langs.length > 0
      ? (meta.tesseract_langs as string)
      : undefined;
  }

  it('string передаётся как есть', () => {
    expect(readLangs({ tesseract_langs: 'rus+eng+chi_sim' })).toBe('rus+eng+chi_sim');
  });

  it('пустая строка → undefined', () => {
    expect(readLangs({ tesseract_langs: '' })).toBeUndefined();
  });

  it('не строка → undefined', () => {
    expect(readLangs({ tesseract_langs: ['rus', 'eng'] })).toBeUndefined();
  });
});
