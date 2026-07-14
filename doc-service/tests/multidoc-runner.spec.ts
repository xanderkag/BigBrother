/**
 * §FIX-1 (CLASSIFIER-PACKET-V2): VLM-классификация скудной хвостовой страницы
 * (бледная СТС) в мультидок-раннере.
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { tryMultiDoc } from '../src/pipeline/multidoc/runner.js';
import type { OcrResult } from '../src/pipeline/ocr/types.js';
import type { Classifier } from '../src/pipeline/classifier/types.js';

const log = pino({ level: 'silent' });

const classifier: Classifier = {
  classify: async (text: string) => {
    if (/CMR/i.test(text)) return { type: 'cmr', confidence: 0.9, source: 'keyword' };
    if (/invoice/i.test(text)) return { type: 'commercial_invoice', confidence: 0.9, source: 'keyword' };
    return { type: null, confidence: 0.1, source: 'keyword' };
  },
};

function ocrOf(pageTexts: string[]): OcrResult {
  return {
    engine: 'tesseract',
    text: pageTexts.join('\n\n'),
    confidence: 0.8,
    durationMs: 1,
    pages: pageTexts.map((t) => ({ text: t, confidence: /скудно|СТС/.test(t) ? 0.2 : 0.9 })),
  };
}

const noopExtract = async () => ({ extracted: {}, fieldConfidence: {} });

describe('tryMultiDoc — §FIX-1 VLM хвостовой СТС', () => {
  const pages = [
    'CMR International накладная '.padEnd(200, 'x'),
    'Invoice No INV-1 price amount '.padEnd(200, 'x'),
    'скудно', // бледная СТС: текст скуден, keyword null
  ];

  it('скудная не-первая страница → classifyPageImage(3) → сегмент vehicle_registration', async () => {
    const classifyPageImage = vi.fn().mockResolvedValue('vehicle_registration');
    const docs = await tryMultiDoc(ocrOf(pages), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      log,
    });
    expect(classifyPageImage).toHaveBeenCalledWith(3);
    expect(classifyPageImage).toHaveBeenCalledTimes(1); // только скудная page 3
    expect(docs?.map((d) => d.document_type)).toContain('vehicle_registration');
  });

  it('без classifyPageImage (VLM off) → СТС-страница НЕ выделяется отдельно', async () => {
    const docs = await tryMultiDoc(ocrOf(pages), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      log,
    });
    // page 3 приклеится к соседу (continuation) — vehicle_registration нет
    expect(docs?.map((d) => d.document_type)).not.toContain('vehicle_registration');
  });

  it('VLM вернул null → страница не переопределяется', async () => {
    const classifyPageImage = vi.fn().mockResolvedValue(null);
    const docs = await tryMultiDoc(ocrOf(pages), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      log,
    });
    expect(classifyPageImage).toHaveBeenCalledWith(3);
    expect(docs?.map((d) => d.document_type)).not.toContain('vehicle_registration');
  });

  it('§FIX-2: страница с текстом но слабым keyword → classifyPageLlm → сегмент packing_list', async () => {
    const classifyPageLlm = vi.fn().mockResolvedValue('packing_list');
    const withText = [
      'CMR International накладная '.padEnd(200, 'x'),
      'Weight net gross packages pallets '.padEnd(200, 'y'), // текст есть, keyword null
    ];
    const docs = await tryMultiDoc(ocrOf(withText), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageLlm,
      log,
    });
    expect(classifyPageLlm).toHaveBeenCalledTimes(1); // только слабая page 2 (keyword-prior gate)
    expect(docs?.map((d) => d.document_type)).toContain('packing_list');
  });

  it('оба хука: скудная страница → картинка (VLM), не текст-LLM', async () => {
    const classifyPageImage = vi.fn().mockResolvedValue('vehicle_registration');
    const classifyPageLlm = vi.fn().mockResolvedValue('packing_list');
    await tryMultiDoc(ocrOf(['CMR '.padEnd(200, 'x'), 'скудно']), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      classifyPageLlm,
      log,
    });
    expect(classifyPageImage).toHaveBeenCalledWith(2); // скудная → картинка
    expect(classifyPageLlm).not.toHaveBeenCalled(); // текст-LLM не зовём для скудной
  });

  it('первую страницу VLM не трогает даже если скудная', async () => {
    const classifyPageImage = vi.fn().mockResolvedValue('vehicle_registration');
    await tryMultiDoc(ocrOf(['скудно', 'CMR '.padEnd(200, 'x')]), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      log,
    });
    // page 1 (i=0) исключена из VLM-триггера
    expect(classifyPageImage).not.toHaveBeenCalledWith(1);
  });
});
