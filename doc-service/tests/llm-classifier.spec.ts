import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';

// Минимум env для config.ts (classifier тянет resolver → db → config).
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { LlmDocClassifier } from '../src/pipeline/classifier/llm-classifier.js';
import { documentTypeResolver } from '../src/pipeline/document-type-resolver.js';
import { invalidateCatalogCache } from '../src/pipeline/classifier/catalog.js';
import { documentTypesRepo, type DocumentTypeRow } from '../src/storage/document-types.js';
import type { Classifier, ClassificationResult } from '../src/pipeline/classifier/types.js';
import type {
  LlmClient,
  LlmCatalogClassifyInput,
  LlmCatalogClassifyResult,
} from '../src/pipeline/llm/types.js';

const log = pino({ level: 'silent' });

function typeRow(overrides: Partial<DocumentTypeRow> = {}): DocumentTypeRow {
  return {
    slug: 'commercial_invoice',
    display_name: 'Commercial Invoice',
    description: 'коммерческий инвойс ВЭД',
    is_active: true,
    is_builtin: false,
    tier: 'beta',
    parser_kind: 'llm_extract',
    llm_prompt: null,
    llm_schema: null,
    expected_fields: [],
    validators: [],
    confidence_threshold: null,
    regex_fallback_threshold: null,
    classification_keywords: [],
    classification_keyword_weights: null,
    metadata: null,
    resolution_config: null,
    organization_id: null,
    prefer_vision: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Fake keyword prior — возвращает заданный результат. */
function priorStub(result: ClassificationResult): Classifier {
  return { classify: vi.fn().mockResolvedValue(result) };
}

/** Fake LLM — classifyWithCatalog возвращает заданный slug (или бросает). */
function llmStub(
  behavior:
    | { slug: string | null; confidence?: number }
    | { throw: Error }
    | { hang: true },
  available = true,
): LlmClient {
  const classifyWithCatalog = vi.fn(
    async (_input: LlmCatalogClassifyInput): Promise<LlmCatalogClassifyResult> => {
      if ('throw' in behavior) throw behavior.throw;
      if ('hang' in behavior) return new Promise<never>(() => {}); // никогда не резолвится
      return { slug: behavior.slug, confidence: behavior.confidence ?? 1 };
    },
  );
  return {
    isAvailable: () => available,
    supportsVision: async () => false,
    classify: vi.fn(),
    classifyWithCatalog,
    extract: vi.fn(),
    visionOcr: vi.fn(),
    verify: vi.fn(),
  } as unknown as LlmClient;
}

/** Валидатор каталога: slug в наборе. */
function validatorFor(slugs: string[]): (slug: string) => Promise<boolean> {
  const set = new Set(slugs);
  return async (slug: string) => set.has(slug);
}

const CATALOG_SLUGS = ['commercial_invoice', 'invoice', 'UPD', 'AKT'];

describe('LlmDocClassifier — production LLM classifier', () => {
  beforeEach(() => {
    documentTypeResolver.invalidate();
    invalidateCatalogCache();
    vi.restoreAllMocks();
    // Каталог: 4 активных типа (getCatalogForOrg → resolver → repo).
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue(
      CATALOG_SLUGS.map((slug) => typeRow({ slug })),
    );
  });

  it('LLM pick validated → final type = llm slug, method=llm, metadata recorded', async () => {
    const prior = priorStub({ type: 'invoice', confidence: 0.6, source: 'keyword' });
    const llm = llmStub({ slug: 'commercial_invoice' });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'COMMERCIAL INVOICE No. CI-1', fileName: 'ci.pdf', organizationId: null },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBe('commercial_invoice');
    expect(out.metadata.method).toBe('llm');
    expect(out.metadata.type).toBe('commercial_invoice');
    expect(out.metadata.llm_said).toBe('commercial_invoice');
    expect(out.metadata.keyword_said).toEqual({ type: 'invoice', score: 0.6 });
    expect(out.metadata.candidates).toEqual([{ type: 'invoice', score: 0.6 }]);
    expect(out.metadata.unknown).toBe(false);
    expect(out.metadata.duration_ms).not.toBeNull();
    expect((llm.classifyWithCatalog as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  // Уверенность как СОГЛАСИЕ двух источников (keyword-prior + LLM). Раньше любой
  // LLM-выбор давал 0.9 — расхождение маскировалось; теперь низкое число доходит
  // до needs_review-гейта в оркестраторе.
  it('уверенность: keyword и LLM согласны → высокая (≥0.9)', async () => {
    const prior = priorStub({ type: 'commercial_invoice', confidence: 0.7, source: 'keyword' });
    const llm = llmStub({ slug: 'commercial_invoice' });
    const out = await new LlmDocClassifier(prior, llm).classify(
      { text: 'COMMERCIAL INVOICE', organizationId: null },
      validatorFor(CATALOG_SLUGS),
      log,
    );
    expect(out.metadata.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('уверенность: keyword молчит, LLM выбрал → средняя (0.7, единственный источник)', async () => {
    const prior = priorStub({ type: null, confidence: 0, source: 'keyword' });
    const llm = llmStub({ slug: 'commercial_invoice' });
    const out = await new LlmDocClassifier(prior, llm).classify(
      { text: 'какой-то незнакомый keyword-у текст', organizationId: null },
      validatorFor(CATALOG_SLUGS),
      log,
    );
    expect(out.metadata.confidence).toBe(0.7);
  });

  it('уверенность: keyword и LLM РАСХОДЯТСЯ → низкая (0.5), а не 0.9', async () => {
    const prior = priorStub({ type: 'invoice', confidence: 0.6, source: 'keyword' });
    const llm = llmStub({ slug: 'commercial_invoice' });
    const out = await new LlmDocClassifier(prior, llm).classify(
      { text: 'COMMERCIAL INVOICE No. CI-1', organizationId: null },
      validatorFor(CATALOG_SLUGS),
      log,
    );
    expect(out.documentType).toBe('commercial_invoice'); // тип берём от LLM
    expect(out.metadata.confidence).toBe(0.5); // но уверенность честно низкая (конфликт)
  });

  it('candidates[] carries real top-N runners-up from prior ranked score-map', async () => {
    // prior возвращает ranked score-map (winner + 2 runners-up). candidates[]
    // должен отразить top-3 c их score'ами, а не единственного победителя.
    const prior = priorStub({
      type: 'factInvoice',
      confidence: 1,
      source: 'keyword',
      ranked: [
        { type: 'factInvoice', score: 1 },
        { type: 'invoice', score: 0.9 },
        { type: 'AKT', score: 0.95 * 1.5 > 1 ? 1 : 0.95 },
      ],
    });
    const llm = llmStub({ slug: 'factInvoice' });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'Счёт-фактура № 7. Счёт на оплату № 100. АКТ выполненных.', organizationId: null },
      validatorFor([...CATALOG_SLUGS, 'factInvoice']),
      log,
    );

    // decision unchanged — llm подтвердил factInvoice.
    expect(out.documentType).toBe('factInvoice');
    // candidates[] — реальные runners-up, ≥2 записи со score.
    expect(out.metadata.candidates.length).toBeGreaterThanOrEqual(2);
    expect(out.metadata.candidates[0]!.type).toBe('factInvoice');
    const types = out.metadata.candidates.map((x) => x.type);
    expect(types).toContain('invoice');
    for (const cand of out.metadata.candidates) {
      expect(typeof cand.score).toBe('number');
    }
    // keyword_said остаётся best prior'а (не список).
    expect(out.metadata.keyword_said).toEqual({ type: 'factInvoice', score: 1 });
  });

  it('candidates[] falls back to single entry when prior has no ranked map', async () => {
    // Обратная совместимость: prior без ranked → candidates = [keyword_said].
    const prior = priorStub({ type: 'invoice', confidence: 0.6, source: 'keyword' });
    const llm = llmStub({ slug: 'commercial_invoice' });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'COMMERCIAL INVOICE No. CI-1', organizationId: null },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.metadata.candidates).toEqual([{ type: 'invoice', score: 0.6 }]);
  });

  it('unknown + prior not confident → flagged not-recognized (type null, unknown=true)', async () => {
    const prior = priorStub({ type: null, confidence: 0, source: 'keyword' });
    const llm = llmStub({ slug: 'unknown' });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'страховой полис КАСКО (нет такого типа)', fileName: 'policy.pdf' },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBeNull();
    expect(out.metadata.unknown).toBe(true);
    expect(out.metadata.type).toBeNull();
    expect(out.metadata.llm_said).toBe('unknown');
    expect(out.metadata.method).toBe('llm');
  });

  it('unknown + prior CONFIDENT → fallback to prior type (method=fallback), llm_said kept', async () => {
    const prior = priorStub({ type: 'AKT', confidence: 0.95, source: 'keyword', matched: 'акт' });
    const llm = llmStub({ slug: 'unknown' });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'АКТ оказанных услуг', fileName: 'akt.pdf' },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBe('AKT');
    expect(out.metadata.method).toBe('fallback');
    expect(out.metadata.unknown).toBe(false);
    expect(out.metadata.llm_said).toBe('unknown');
  });

  it('fallback on LLM error → keyword prior, method=keyword, never throws', async () => {
    const prior = priorStub({ type: 'invoice', confidence: 0.7, source: 'keyword' });
    const llm = llmStub({ throw: new Error('backend 500') });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'Счёт на оплату № 1', fileName: 'schet.pdf' },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBe('invoice');
    expect(out.metadata.method).toBe('keyword');
    expect(out.metadata.llm_said).toBeNull();
  });

  it('fallback on timeout → keyword prior (timeout guard fires)', async () => {
    const prior = priorStub({ type: 'invoice', confidence: 0.7, source: 'keyword' });
    const llm = llmStub({ hang: true });
    // Короткий таймаут — тест не ждёт 18с.
    const c = new LlmDocClassifier(prior, llm, { timeoutMs: 30 });

    const out = await c.classify(
      { text: 'Счёт на оплату № 1' },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBe('invoice');
    expect(out.metadata.method).toBe('keyword');
  });

  it('invalid slug (hallucinated, not in catalog) → fallback to prior', async () => {
    const prior = priorStub({ type: 'invoice', confidence: 0.65, source: 'keyword' });
    const llm = llmStub({ slug: 'made_up_type' });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'Счёт № 1' },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBe('invoice');
    expect(out.metadata.method).toBe('keyword');
    expect(out.metadata.llm_said).toBe('made_up_type');
  });

  it('empty catalog → keyword-only (LLM not called)', async () => {
    vi.spyOn(documentTypesRepo, 'listActiveForOrg').mockResolvedValue([]);
    invalidateCatalogCache();
    const prior = priorStub({ type: 'UPD', confidence: 0.9, source: 'keyword' });
    const llm = llmStub({ slug: 'commercial_invoice' });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'УПД № 1' },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBe('UPD');
    expect(out.metadata.method).toBe('keyword');
    expect((llm.classifyWithCatalog as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('LLM unavailable → keyword-only (LLM not called)', async () => {
    const prior = priorStub({ type: 'UPD', confidence: 0.9, source: 'keyword' });
    const llm = llmStub({ slug: 'commercial_invoice' }, /* available */ false);
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'УПД № 1' },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBe('UPD');
    expect(out.metadata.method).toBe('keyword');
    expect((llm.classifyWithCatalog as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('filename-driven prior → method=filename in fallback path', async () => {
    // prior победил по имени файла (matched начинается с filename:).
    const prior = priorStub({
      type: 'AKT',
      confidence: 0.5,
      source: 'keyword',
      matched: 'filename:AKT',
    });
    const llm = llmStub({ throw: new Error('down') });
    const c = new LlmDocClassifier(prior, llm);

    const out = await c.classify(
      { text: 'нераспознаваемый текст', fileName: 'Act_2026.pdf' },
      validatorFor(CATALOG_SLUGS),
      log,
    );

    expect(out.documentType).toBe('AKT');
    expect(out.metadata.method).toBe('filename');
  });
});

describe('catalog builder', () => {
  beforeEach(() => {
    documentTypeResolver.invalidate();
    invalidateCatalogCache();
    vi.restoreAllMocks();
  });

  it('builds `slug — description`, falls back to llm_prompt head when description empty', async () => {
    const { buildCatalogText } = await import('../src/pipeline/classifier/catalog.js');
    const text = buildCatalogText([
      typeRow({ slug: 'invoice', description: 'счёт на оплату' }),
      typeRow({ slug: 'x_type', description: '', llm_prompt: 'Извлеки поля из документа X подробно и точно' }),
      typeRow({ slug: 'bare', description: null, llm_prompt: null }),
    ]);
    expect(text).toContain('invoice — счёт на оплату');
    expect(text).toContain('x_type — Извлеки поля');
    // bare без description/prompt → просто slug.
    expect(text.split('\n')).toContain('bare');
  });
});
