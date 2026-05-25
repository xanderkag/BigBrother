import { describe, it, expect, vi } from 'vitest';
import { TtnParser } from '../src/pipeline/parsers/ttn.js';
import { CmrParser } from '../src/pipeline/parsers/cmr.js';
import { AktParser } from '../src/pipeline/parsers/akt.js';
import { NullLlmClient } from '../src/pipeline/llm/null-client.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';

/**
 * Mock LlmClient that returns a configurable extract response. We're
 * testing the parser plumbing — schema selection, expected-fields
 * computation, graceful degradation when the client is unavailable.
 */
function mockLlm(extractResponse: {
  extracted: Record<string, unknown>;
  confidence: number;
  issues?: string[];
}): LlmClient {
  return {
    isAvailable: () => true,
    supportsVision: async () => false,
    classify: vi.fn(),
    extract: vi.fn().mockResolvedValue({
      extracted: extractResponse.extracted,
      confidence: extractResponse.confidence,
      issues: extractResponse.issues ?? [],
    }),
    visionOcr: vi.fn(),
    verify: vi.fn(),
  };
}

describe('LLM-backed parsers — graceful degradation', () => {
  it('TtnParser returns empty + missing fields when LLM unavailable', async () => {
    const r = await new TtnParser(new NullLlmClient()).parse('any text');
    expect(r.extracted).toEqual({});
    expect(r.confidence).toBe(0);
    expect(r.missing).toContain('number');
    expect(r.missing).toContain('cargo');
  });

  it('CmrParser same', async () => {
    const r = await new CmrParser(new NullLlmClient()).parse('any text');
    expect(r.extracted).toEqual({});
    expect(r.confidence).toBe(0);
  });

  it('AktParser same', async () => {
    const r = await new AktParser(new NullLlmClient()).parse('any text');
    expect(r.extracted).toEqual({});
    expect(r.confidence).toBe(0);
  });
});

describe('LLM-backed parsers — happy path with mock', () => {
  it('TtnParser passes TTN schema and hint to LLM', async () => {
    const llm = mockLlm({
      extracted: {
        number: '123',
        date: '2026-05-01',
        shipper: { name: 'ООО Ромашка', inn: '7712345678' },
        consignee: { name: 'ООО Василёк', inn: '7798765432' },
        cargo: { name: 'Кирпичи', quantity: 100, weight_gross: 5000 },
        vehicle: { plate: 'А123БВ77', driver: 'Иванов И.И.' },
        // Phase A v2: items[] — канонический массив строк (раньше parser
        // не требовал его, теперь EXPECTED_FIELDS.TTN включает 'items').
        items: [{ name: 'Кирпичи', quantity: 100 }],
      },
      confidence: 0.88,
    });

    const r = await new TtnParser(llm).parse('ТРАНСПОРТНАЯ НАКЛАДНАЯ ...');

    expect(r.extracted.number).toBe('123');
    expect(r.confidence).toBe(0.88);
    expect(r.missing).toEqual([]);

    // Verify the call to llm.extract used the right hint and a non-empty schema.
    expect(llm.extract).toHaveBeenCalledTimes(1);
    const callArg = (llm.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.hint).toBe('TTN');
    expect(callArg.schema).toMatchObject({ type: 'object' });
    expect(callArg.text).toContain('ТРАНСПОРТНАЯ');
  });

  it('reports partial extraction in `missing`', async () => {
    const llm = mockLlm({
      extracted: { number: '999', date: '2026-05-01' }, // shipper/consignee/cargo absent
      confidence: 0.4,
    });
    const r = await new TtnParser(llm).parse('text');
    expect(r.missing).toContain('shipper');
    expect(r.missing).toContain('consignee');
    expect(r.missing).toContain('cargo');
    expect(r.missing).not.toContain('number');
  });

  it('treats empty objects as missing', async () => {
    const llm = mockLlm({
      extracted: {
        number: '1',
        date: '2026-05-01',
        shipper: {}, // returned but empty — count as missing
        consignee: { name: 'X', inn: '7712345678' },
        cargo: { name: 'Y', quantity: 1 },
        vehicle: { plate: 'А1АА77' },
      },
      confidence: 0.7,
    });
    const r = await new TtnParser(llm).parse('text');
    expect(r.missing).toContain('shipper');
    expect(r.missing).not.toContain('consignee');
  });

  it('clamps invalid confidence to [0..1]', async () => {
    const llm = mockLlm({ extracted: { number: '1' }, confidence: 1.5 });
    const r = await new AktParser(llm).parse('text');
    expect(r.confidence).toBe(1);

    const llm2 = mockLlm({ extracted: { number: '1' }, confidence: -0.3 });
    const r2 = await new AktParser(llm2).parse('text');
    expect(r2.confidence).toBe(0);
  });

  it('propagates LLM errors so BullMQ can retry', async () => {
    const failing: LlmClient = {
      isAvailable: () => true,
      supportsVision: async () => false,
      classify: vi.fn(),
      extract: vi.fn().mockRejectedValue(new Error('inference-service 503')),
      visionOcr: vi.fn(),
      verify: vi.fn(),
    };
    await expect(new CmrParser(failing).parse('text')).rejects.toThrow('inference-service 503');
  });
});
