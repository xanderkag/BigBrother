import { describe, expect, it } from 'vitest';
import { selectOcrChain } from '../src/pipeline/router.js';
import type { OcrEngine, OcrInput, OcrResult } from '../src/pipeline/ocr/types.js';
import type { OcrEngineName } from '../src/types/documents.js';

function fakeEngine(
  name: OcrEngineName,
  opts: { available?: boolean; supports?: boolean } = {},
): OcrEngine {
  return {
    name,
    acceptanceThreshold: 0,
    supports: () => opts.supports ?? true,
    isAvailable: () => opts.available ?? true,
    run: async (): Promise<OcrResult> => ({ engine: name, text: '', confidence: 0, durationMs: 0 }),
  };
}

// C.f. orchestrator wiring order: text engines first, yandex last.
function defaultChain(): OcrEngine[] {
  return [
    fakeEngine('pdf-text'),
    fakeEngine('tesseract'),
    fakeEngine('vision-llm'),
    fakeEngine('yandex'),
  ];
}

const scanInput: OcrInput = { filePath: 'x.png', mimeType: 'image/png' };
const names = (chain: OcrEngine[]) => chain.map((e) => e.name);

describe('selectOcrChain — ordering + PII guard', () => {
  it('default order keeps yandex last', () => {
    expect(names(selectOcrChain(defaultChain(), scanInput))).toEqual([
      'pdf-text',
      'tesseract',
      'vision-llm',
      'yandex',
    ]);
  });

  it('preferYandexForScans moves yandex ahead of local scan engines, behind native text', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, { preferYandexForScans: true });
    expect(names(chain)).toEqual(['pdf-text', 'yandex', 'tesseract', 'vision-llm']);
  });

  it('preferYandexForScans is a no-op when yandex is unavailable (no key)', () => {
    const chain = [
      fakeEngine('pdf-text'),
      fakeEngine('tesseract'),
      fakeEngine('vision-llm'),
      fakeEngine('yandex', { available: false }),
    ];
    expect(names(selectOcrChain(chain, scanInput, { preferYandexForScans: true }))).toEqual([
      'pdf-text',
      'tesseract',
      'vision-llm',
    ]);
  });

  it('PII opt-out (per-job) drops yandex even with preferYandexForScans', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, {
      preferYandexForScans: true,
      disableExternalOcr: true,
    });
    expect(names(chain)).toEqual(['pdf-text', 'tesseract', 'vision-llm']);
  });

  it('global PII guard drops yandex for PII document types', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, {
      preferYandexForScans: true,
      disableYandexForPii: true,
      documentType: 'TTN',
    });
    expect(names(chain)).toEqual(['pdf-text', 'tesseract', 'vision-llm']);
  });

  it('global PII guard leaves yandex for non-PII document types', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, {
      preferYandexForScans: true,
      disableYandexForPii: true,
      documentType: 'invoice',
    });
    expect(names(chain)).toEqual(['pdf-text', 'yandex', 'tesseract', 'vision-llm']);
  });
});

// Рубильник коннектора `yandex_vision` из «Интеграций» (см. ocr/yandex-gate.ts).
describe('selectOcrChain — рубильник yandex_vision', () => {
  it('yandexVisionAllowed=false выкидывает yandex из цепочки', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, { yandexVisionAllowed: false });
    expect(names(chain)).toEqual(['pdf-text', 'tesseract', 'vision-llm']);
  });

  it('yandexVisionAllowed=true оставляет yandex (как и раньше)', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, { yandexVisionAllowed: true });
    expect(names(chain)).toEqual(['pdf-text', 'tesseract', 'vision-llm', 'yandex']);
  });

  it('undefined = «не спрашивали» → yandex остаётся (обратная совместимость)', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, {});
    expect(names(chain)).toContain('yandex');
  });

  it('рубильник бьёт даже при preferYandexForScans', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, {
      preferYandexForScans: true,
      yandexVisionAllowed: false,
    });
    expect(names(chain)).toEqual(['pdf-text', 'tesseract', 'vision-llm']);
  });

  // ── Ключевой инвариант безопасности ────────────────────────────────
  it('PII-гард СИЛЬНЕЕ рубильника: allowed=true не возвращает yandex для ТТН', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, {
      yandexVisionAllowed: true, // «интеграция включена»
      disableYandexForPii: true,
      documentType: 'TTN',
    });
    expect(names(chain)).not.toContain('yandex');
  });

  it('PII-гард СИЛЬНЕЕ рубильника: allowed=true не возвращает yandex при per-job opt-out', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, {
      yandexVisionAllowed: true,
      disableExternalOcr: true,
    });
    expect(names(chain)).not.toContain('yandex');
  });

  it('оба запрета сразу — yandex всё равно отсутствует ровно один раз', () => {
    const chain = selectOcrChain(defaultChain(), scanInput, {
      yandexVisionAllowed: false,
      disableYandexForPii: true,
      documentType: 'CMR',
    });
    expect(names(chain)).toEqual(['pdf-text', 'tesseract', 'vision-llm']);
  });
});
