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

/**
 * §FIX-1 (ПЕРЕДЕЛКА после приёмки на asha 2026-07-14).
 *
 * Регрессия: на боевом прогоне SICHEL хвостовая СТС (стр.15) осталась склеена с
 * паспортом — отдельного `vehicle_registration` не появилось. Причина: выбор
 * vlm/llm решался ТОЛЬКО длиной текста. Эстонская/литовская СТС (Transpordiamet /
 * Registracijos liudijimas) даёт >vlmMinText символов РАСПОЗНАННОЙ КАШИ → scant=false
 * → страница уходила в текст-LLM (который на ней уже был проверен и не помог), а
 * при MULTIDOC_LLM_CLASSIFY=false (дефолт asha) не срабатывало вообще ничего.
 * classifyPageImage не звался НИКОГДА → страница молча липла к предыдущему сегменту.
 *
 * Фикс: картинка — последний рычаг, если текстовый путь типа не дал.
 */
describe('tryMultiDoc — §FIX-1 переделка: VLM как последний рычаг', () => {
  // Не-первая страница: текста МНОГО (>vlmMinText=120), но keyword типа не даёт —
  // ровно профиль мусорного OCR прибалтийской СТС.
  const garbledCts = 'Registreerimistunnistus Transpordiamet '.padEnd(220, 'q');
  const pages = ['CMR International накладная '.padEnd(200, 'x'), garbledCts];

  it('НЕ-скудная слабая страница + VLM, без текст-LLM (дефолт asha) → VLM зовётся → сегмент СТС', async () => {
    const classifyPageImage = vi.fn().mockResolvedValue('vehicle_registration');
    const docs = await tryMultiDoc(ocrOf(pages), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      log,
    });
    // Было: не scant + нет classifyPageLlm → не вызывалось НИЧЕГО, страница склеивалась.
    expect(classifyPageImage).toHaveBeenCalledWith(2);
    expect(docs?.map((d) => d.document_type)).toContain('vehicle_registration');
  });

  it('текст-LLM вернул null → откат на картинку → сегмент СТС', async () => {
    const classifyPageLlm = vi.fn().mockResolvedValue(null);
    const classifyPageImage = vi.fn().mockResolvedValue('vehicle_registration');
    const docs = await tryMultiDoc(ocrOf(pages), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      classifyPageLlm,
      log,
    });
    expect(classifyPageLlm).toHaveBeenCalledTimes(1); // текст пробуем первым
    expect(classifyPageImage).toHaveBeenCalledWith(2); // не дал типа → картинка
    expect(docs?.map((d) => d.document_type)).toContain('vehicle_registration');
  });

  it('текст-LLM дал тип → картинку НЕ зовём (цена ограничена)', async () => {
    const classifyPageLlm = vi.fn().mockResolvedValue('packing_list');
    const classifyPageImage = vi.fn().mockResolvedValue('vehicle_registration');
    await tryMultiDoc(ocrOf(pages), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      classifyPageLlm,
      log,
    });
    expect(classifyPageLlm).toHaveBeenCalledTimes(1);
    expect(classifyPageImage).not.toHaveBeenCalled();
  });

  it('скудная страница: VLM зовётся РОВНО один раз (откат не дублирует вызов)', async () => {
    const classifyPageImage = vi.fn().mockResolvedValue(null); // null → соблазн позвать повторно
    await tryMultiDoc(ocrOf(['CMR '.padEnd(200, 'x'), 'скудно']), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      log,
    });
    expect(classifyPageImage).toHaveBeenCalledTimes(1);
  });

  it('сильный keyword → ни текст-LLM, ни картинка не зовутся', async () => {
    const classifyPageLlm = vi.fn().mockResolvedValue('packing_list');
    const classifyPageImage = vi.fn().mockResolvedValue('vehicle_registration');
    await tryMultiDoc(ocrOf(['CMR '.padEnd(200, 'x'), 'Invoice No INV-1 '.padEnd(200, 'x')]), {
      classifier,
      organizationId: null,
      extractSegment: noopExtract,
      classifyPageImage,
      classifyPageLlm,
      log,
    });
    expect(classifyPageLlm).not.toHaveBeenCalled();
    expect(classifyPageImage).not.toHaveBeenCalled();
  });
});
