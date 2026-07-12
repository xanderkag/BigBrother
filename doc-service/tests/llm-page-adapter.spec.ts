/**
 * §P0-1 (CLASSIFIER-PACKET-V2): адаптер LlmDocClassifier → Classifier.
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { LlmPageClassifierAdapter } from '../src/pipeline/classifier/llm-page-adapter.js';
import type { LlmDocClassifier, LlmClassificationOutcome } from '../src/pipeline/classifier/llm-classifier.js';

const log = pino({ level: 'silent' });

function outcome(
  documentType: string | null,
  method: 'llm' | 'keyword' | 'filename' | 'fallback' | 'hint',
  confidence = 1,
): LlmClassificationOutcome {
  return {
    documentType: documentType as LlmClassificationOutcome['documentType'],
    metadata: {
      type: documentType as LlmClassificationOutcome['documentType'],
      confidence,
      method,
      duration_ms: null,
      llm_said: documentType,
      keyword_said: null,
      candidates: [],
      unknown: documentType === null,
    },
  };
}

function fakeLlmDoc(out: LlmClassificationOutcome) {
  const classify = vi.fn().mockResolvedValue(out);
  return { classify } as unknown as LlmDocClassifier & { classify: typeof classify };
}

const isCatalogSlug = async () => true;

describe('LlmPageClassifierAdapter', () => {
  it('маппит LLM-outcome → ClassificationResult (source=llm)', async () => {
    const doc = fakeLlmDoc(outcome('cmr', 'llm', 0.95));
    const adapter = new LlmPageClassifierAdapter(doc, isCatalogSlug, log);
    const r = await adapter.classify('CMR text', 'org-1', 'file.pdf');
    expect(r).toEqual({ type: 'cmr', confidence: 0.95, source: 'llm' });
  });

  it('fallback-метод → source=keyword', async () => {
    const doc = fakeLlmDoc(outcome('invoice', 'fallback', 0.6));
    const adapter = new LlmPageClassifierAdapter(doc, isCatalogSlug, log);
    const r = await adapter.classify('t');
    expect(r.source).toBe('keyword');
    expect(r.type).toBe('invoice');
  });

  it('unknown (documentType=null) → type=null', async () => {
    const doc = fakeLlmDoc(outcome(null, 'llm', 0));
    const adapter = new LlmPageClassifierAdapter(doc, isCatalogSlug, log);
    const r = await adapter.classify('шум');
    expect(r.type).toBeNull();
  });

  it('§P2-3: wrapProvider оборачивает classify (forceProvider A/B)', async () => {
    const doc = fakeLlmDoc(outcome('cmr', 'llm'));
    const calls: string[] = [];
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
      calls.push('start');
      const r = await fn();
      calls.push('end');
      return r;
    };
    const adapter = new LlmPageClassifierAdapter(doc, isCatalogSlug, log, wrap);
    const r = await adapter.classify('t');
    expect(r.type).toBe('cmr');
    expect(calls).toEqual(['start', 'end']); // classify выполнен ВНУТРИ обёртки
    expect(doc.classify).toHaveBeenCalledOnce();
  });

  it('пробрасывает text/fileName/orgId в LlmDocClassifier', async () => {
    const doc = fakeLlmDoc(outcome('ttn', 'llm'));
    const adapter = new LlmPageClassifierAdapter(doc, isCatalogSlug, log);
    await adapter.classify('page text', 'org-9', 'scan.pdf');
    expect(doc.classify).toHaveBeenCalledWith(
      { text: 'page text', fileName: 'scan.pdf', organizationId: 'org-9' },
      isCatalogSlug,
      log,
      { source: 'multidoc-page' },
    );
  });
});
