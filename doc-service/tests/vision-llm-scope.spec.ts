import { describe, expect, it, vi } from 'vitest';
import { VisionLlmEngine } from '../src/pipeline/ocr/vision-llm.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';
import type { OcrInput } from '../src/pipeline/ocr/types.js';

function fakeLlm(text = 'hello'): LlmClient {
  return {
    isAvailable: () => true,
    supportsVision: async () => true,
    classify: vi.fn(),
    classifyWithCatalog: vi.fn(),
    extract: vi.fn(),
    verify: vi.fn(),
    visionOcr: vi.fn(async () => ({ text, confidence: 0.75 })),
  } as unknown as LlmClient;
}

const imageInput: OcrInput = { filePath: 'page.png', mimeType: 'image/png' };

describe('VisionLlmEngine vision-scope routing', () => {
  it('wraps the OCR call in visionScope so OCR runs on the vision provider', async () => {
    const llm = fakeLlm('OCR TEXT');
    const calls: string[] = [];
    // scope simulates dynamicLlm.withVisionProvider — records ordering and
    // forwards through. The real impl swaps the resolved provider (qwen3-vl).
    const scope = async <T>(fn: () => Promise<T>): Promise<T> => {
      calls.push('scope-enter');
      const r = await fn();
      calls.push('scope-exit');
      return r;
    };

    const engine = new VisionLlmEngine(0.5, llm, scope);
    const result = await engine.run(imageInput);

    expect(result.text).toBe('OCR TEXT');
    expect(llm.visionOcr).toHaveBeenCalledTimes(1);
    // The visionOcr call happened INSIDE the scope (between enter and exit).
    expect(calls).toEqual(['scope-enter', 'scope-exit']);
  });

  it('falls back to a direct call when no visionScope is provided (back-compat)', async () => {
    const llm = fakeLlm('PLAIN');
    const engine = new VisionLlmEngine(0.5, llm);
    const result = await engine.run(imageInput);

    expect(result.text).toBe('PLAIN');
    expect(llm.visionOcr).toHaveBeenCalledTimes(1);
  });
});
