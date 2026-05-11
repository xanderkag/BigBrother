import { describe, it, expect, vi } from 'vitest';
import { InvoiceParser } from '../src/pipeline/parsers/invoice.js';
import { UpdParser } from '../src/pipeline/parsers/upd.js';
import { NullLlmClient } from '../src/pipeline/llm/null-client.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';
import { findDate, findInn, parseAmount } from '../src/pipeline/parsers/common.js';

const offlineLlm = () => new NullLlmClient();

function mockLlm(extracted: Record<string, unknown>, confidence: number, issues: string[] = []): LlmClient {
  return {
    isAvailable: () => true,
    classify: vi.fn(),
    extract: vi.fn().mockResolvedValue({ extracted, confidence, issues }),
    visionOcr: vi.fn(),
    verify: vi.fn(),
  };
}

describe('common parsers', () => {
  it('parses numeric dates', () => {
    expect(findDate('Дата: 15.01.2026')).toBe('2026-01-15');
    expect(findDate('15-01-26')).toBe('2026-01-15');
    expect(findDate('15/01/2026 г.')).toBe('2026-01-15');
  });

  it('parses Russian date phrases', () => {
    expect(findDate('от 15 января 2026 г.')).toBe('2026-01-15');
  });

  it('finds INN', () => {
    expect(findInn('ИНН 7712345678')).toBe('7712345678');
    expect(findInn('ИНН: 123456789012')).toBe('123456789012');
  });

  it('parses amounts with various separators', () => {
    expect(parseAmount('15 000,50')).toBe(15000.5);
    expect(parseAmount('15,000.50')).toBe(15000.5);
    expect(parseAmount('15000.50')).toBe(15000.5);
  });
});

describe('InvoiceParser — regex path', () => {
  it('extracts core invoice fields', async () => {
    const text = `
      Счёт № 123 от 15.01.2026 г.
      Поставщик: ООО "Ромашка", ИНН 7712345678
      Покупатель: ООО "Василёк", ИНН 7798765432
      НДС 20%
      НДС: 2 500,00
      Итого к оплате: 15 000,00
    `;
    const r = await new InvoiceParser(offlineLlm()).parse(text);
    expect(r.extracted.number).toBe('123');
    expect(r.extracted.date).toBe('2026-01-15');
    expect(r.extracted.total).toBe(15000);
    expect(r.extracted.vat).toBe(2500);
    expect(r.extracted.vat_rate).toBe(20);
    expect(r.confidence).toBeGreaterThan(0.6);
  });

  it('reports low confidence on garbled input (and stays on regex when LLM offline)', async () => {
    const r = await new InvoiceParser(offlineLlm()).parse('???');
    expect(r.confidence).toBeLessThan(0.4);
    expect(r.missing.length).toBeGreaterThan(0);
  });
});

describe('UpdParser — regex path', () => {
  it('handles УПД', async () => {
    const text = `
      Универсальный передаточный документ № У-456 от 02.02.2026
      Продавец ИНН 7712345678
      Покупатель ИНН 7798765432
      Всего к оплате 100 000,00
    `;
    const r = await new UpdParser(offlineLlm(), 'UPD').parse(text);
    expect(r.extracted.number).toBe('У-456');
    expect(r.extracted.date).toBe('2026-02-02');
    expect(r.extracted.total).toBe(100000);
  });

  it('factInvoice variant carries the right type', () => {
    const r = new UpdParser(offlineLlm(), 'factInvoice');
    expect(r.type).toBe('factInvoice');
  });
});

describe('Phase 1 parsers — LLM fallback', () => {
  const garbledText = 'random ??? garbage with no recognizable invoice fields';

  it('skips LLM when regex confidence is high', async () => {
    const goodText = `
      Счёт № 100 от 01.05.2026 г.
      ИНН 7712345678
      Итого к оплате: 50 000,00
    `;
    const llm = mockLlm({}, 0.99);
    await new InvoiceParser(llm).parse(goodText);
    // Regex hit all required fields → LLM should NOT be invoked.
    expect(llm.extract).not.toHaveBeenCalled();
  });

  it('falls back to LLM when regex confidence is low', async () => {
    const llm = mockLlm(
      {
        number: 'A-9000',
        date: '2026-05-01',
        seller: { name: 'ООО "Глянцевая Бумага"', inn: '7712345678' },
        buyer: { name: 'ООО "Покупатель"', inn: '7798765432' },
        total: 250000,
        vat: 41666.67,
        vat_rate: 20,
        positions: [{ name: 'Бумага глянцевая А4', qty: 1000, price: 250, total: 250000 }],
      },
      0.92,
    );

    const r = await new InvoiceParser(llm).parse(garbledText);

    expect(llm.extract).toHaveBeenCalledTimes(1);
    expect((r.extracted as { number?: string }).number).toBe('A-9000');
    expect((r.extracted as { positions?: unknown[] }).positions).toHaveLength(1);
    expect(r.confidence).toBeGreaterThan(0.8);

    const callArg = (llm.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.hint).toBe('invoice');
    expect(callArg.schema).toMatchObject({ type: 'object' });
  });

  it('keeps regex result if LLM confidence is lower', async () => {
    const halfGoodText = `Счёт № 5 от 01.05.2026 г.\nИНН 7712345678\nИтого: 100`;
    const llm = mockLlm({ number: 'WRONG' }, 0.3);

    const r = await new InvoiceParser(llm).parse(halfGoodText);
    // Regex got number=5 with conf around 0.66, LLM at 0.3 — regex wins.
    expect(r.extracted.number).toBe('5');
  });

  it('returns regex result when LLM throws', async () => {
    const failing: LlmClient = {
      isAvailable: () => true,
      classify: vi.fn(),
      extract: vi.fn().mockRejectedValue(new Error('inference-service down')),
      visionOcr: vi.fn(),
      verify: vi.fn(),
    };
    const r = await new InvoiceParser(failing).parse(garbledText);
    // LLM blew up — orchestrator gets the regex result, will mark needs_review.
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('respects threshold=0 (LLM-fallback disabled)', async () => {
    const llm = mockLlm({ number: 'should-not-see-this' }, 0.99);
    const parser = new InvoiceParser(llm, 0); // threshold=0 means "regex always wins"
    await parser.parse('Счёт ??? totally broken');
    expect(llm.extract).not.toHaveBeenCalled();
  });

  it('UpdParser falls back too, with the right schema for factInvoice', async () => {
    const llm = mockLlm({ number: 'F-1', date: '2026-05-01', total: 1000 }, 0.85);
    await new UpdParser(llm, 'factInvoice').parse('garbled');
    expect(llm.extract).toHaveBeenCalledTimes(1);
    const callArg = (llm.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.hint).toBe('factInvoice');
  });
});

describe('ParserOverride — CP1 runtime config injection', () => {
  it('regexFallbackThreshold=0 from override disables LLM even on weak regex', async () => {
    // Constructor default would normally trigger LLM (default=0.7).
    // Override forces fallback off ⇒ regex result returned untouched,
    // LLM never called.
    const llm = mockLlm({ number: 'override-leaked' }, 0.99);
    const parser = new InvoiceParser(llm /* default 0.7 */);
    await parser.parse('Счёт ??? broken', { regexFallbackThreshold: 0 });
    expect(llm.extract).not.toHaveBeenCalled();
  });

  it('regexFallbackThreshold=1 from override forces LLM even on perfect regex', async () => {
    // Default threshold 0.7 would let a high-confidence regex skip LLM.
    // Override raises the bar to 1 ⇒ regex is "never good enough" ⇒
    // parser must consult LLM.
    const llm = mockLlm({ number: '999', date: '2026-05-01', total: 100 }, 0.95);
    const parser = new InvoiceParser(llm);
    const goodText = `Счёт № 100 от 01.05.2026\nИНН 7712345678\nИтого: 50000`;
    await parser.parse(goodText, { regexFallbackThreshold: 1.0 });
    expect(llm.extract).toHaveBeenCalledTimes(1);
  });

  it('expectedFields override changes the missing[] accounting', async () => {
    const llm = new NullLlmClient();
    const parser = new InvoiceParser(llm);
    const goodText = `Счёт № 100 от 01.05.2026 г.`;
    // Override demands more fields than the parser would normally check.
    const r = await parser.parse(goodText, {
      expectedFields: ['number', 'date', 'total', 'extra_required_field'],
    });
    expect(r.missing).toContain('extra_required_field');
  });

  it('llmSchema override is forwarded to LLM /extract', async () => {
    const llm = mockLlm({ number: 'x' }, 0.5);
    const parser = new InvoiceParser(llm);
    const customSchema = { type: 'object', properties: { custom_field: { type: 'string' } } };
    await parser.parse('Счёт ??? garbled', {
      llmSchema: customSchema,
      regexFallbackThreshold: 1.0, // force LLM call
    });
    const callArg = (llm.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.schema).toEqual(customSchema);
  });

  it('Phase 2 parser (TtnParser) honours llmSchema override', async () => {
    // We can verify TtnParser uses override by checking what gets passed
    // to llm.extract. Re-using the mockLlm pattern.
    const { TtnParser } = await import('../src/pipeline/parsers/ttn.js');
    const llm = mockLlm({ number: 'T-1' }, 0.8);
    const customSchema = { type: 'object', properties: { route_code: { type: 'string' } } };
    await new TtnParser(llm).parse('any text', {
      llmSchema: customSchema,
      expectedFields: ['number', 'route_code'],
    });
    const callArg = (llm.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.schema).toEqual(customSchema);
    expect(callArg.hint).toBe('TTN');
  });
});
