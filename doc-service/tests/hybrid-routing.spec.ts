/**
 * Hybrid extraction routing (SLAI backlog Sequencing #3).
 *
 * Покрывает:
 *   1. decideExtractPath() — чистая decision-логика: clean text → text;
 *      scan/low-conf/short-text/prefer_vision → vision; force-флаги в обе
 *      стороны; приоритеты.
 *   2. resolveVisionProviderId() — явный id, автоподбор, fail-soft → null.
 *   3. runDocumentPipeline() с hybrid:
 *        - clean text-PDF → text-путь, без картинки, default-провайдер;
 *        - scan (vision-llm engine) → vision-путь: withForceProvider(visionId)
 *          + imagePath отправлен;
 *        - vision-провайдер недоступен → fail-soft на text (без падения);
 *        - hybrid выключен (option отсутствует) → поведение как раньше.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Минимум env для транзитивного config.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import type { Logger } from 'pino';

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

// ── Mocks: provider_settings repo + document-type-resolver + dynamicLlm ──────
//
// Эти три singleton'а — единственные внешние зависимости hybrid-пути в
// runDocumentPipeline. Мокаем на уровне модулей, чтобы прогнать pipeline без
// БД и без сети.

// SLAI-category enrichment в normalize/run делает DB-lookup (best-effort).
// Мокаем, чтобы pipeline не пытался коннектиться к БД в unit-тесте.
vi.mock('../src/storage/slai-categories.js', () => ({
  slaiCategoriesRepo: { loadHintToIdMap: async () => new Map() },
}));

const findById = vi.fn();
const findActiveVision = vi.fn();
vi.mock('../src/storage/provider-settings.js', () => ({
  providerSettingsRepo: {
    findById: (...a: unknown[]) => findById(...a),
    findActiveVision: (...a: unknown[]) => findActiveVision(...a),
  },
}));

// extract-spy: записывает каждый вызов llm.extract (через парсер) с imagePath.
const extractCalls: Array<{ imagePath?: string; forcedProviderId: string | null }> = [];
let currentForcedProvider: string | null = null;

vi.mock('../src/pipeline/llm/provider-resolver.js', () => {
  const client = {
    isAvailable: () => true,
    // По умолчанию default-провайдер НЕ vision (phi4). Hybrid не зависит от
    // этого — он сам форсит vision-провайдера.
    supportsVision: async () => false,
    classify: vi.fn(),
    classifyWithCatalog: vi.fn(),
    extract: vi.fn(async (input: { imagePath?: string }) => {
      extractCalls.push({ imagePath: input.imagePath, forcedProviderId: currentForcedProvider });
      return { extracted: { ok: true }, confidence: 0.9, issues: [] };
    }),
    visionOcr: vi.fn(),
    verify: vi.fn(),
    withForceProvider: <T>(providerId: string, fn: () => Promise<T>): Promise<T> => {
      const prev = currentForcedProvider;
      currentForcedProvider = providerId;
      return fn().finally(() => {
        currentForcedProvider = prev;
      });
    },
    withInlineCredentials: <T>(_c: unknown, fn: () => Promise<T>) => fn(),
    invalidate: () => {},
  };
  return { dynamicLlm: client };
});

// resolveConfig: возвращаем минимальный конфиг кастомного типа (llm_extract),
// с управляемым preferVision.
let preferVisionFlag = false;
vi.mock('../src/pipeline/document-type-resolver.js', () => ({
  documentTypeResolver: {
    // validateExtractedWithResolver зовёт .get(); для custom slug'а null →
    // пустой список issues (нечего проверять без DB-записи).
    get: async () => null,
    resolveConfig: async (slug: string) => ({
      slug,
      confidenceThreshold: 0.6,
      regexFallbackThreshold: 0.7,
      expectedFields: [],
      validators: [],
      llmSchema: { type: 'object' },
      llmPrompt: null,
      parserKind: 'llm_extract',
      resolutionConfig: null,
      tier: 'experimental',
      preferVision: preferVisionFlag,
      source: 'db',
    }),
  },
}));

import { decideExtractPath, resolveVisionProviderId } from '../src/pipeline/hybrid-router.js';
import { runDocumentPipeline } from '../src/pipeline/orchestrator.js';

const baseHybrid = {
  ocrEngine: 'pdf-text' as const,
  ocrConfidence: 0.95,
  textLength: 5000,
  pageCount: 2,
  isImageInput: false,
  forceImage: false,
  forceText: false,
  visionConfThreshold: 0.7,
  visionProviderId: undefined as string | undefined,
};

describe('decideExtractPath — pure routing decision', () => {
  const cfg = { visionConfThreshold: 0.7 };
  const base = {
    ocrEngine: 'pdf-text' as const,
    ocrConfidence: 0.95,
    textLength: 5000,
    pageCount: 2,
    isImageInput: false,
    preferVision: false,
    forceImage: false,
    forceText: false,
  };

  it('clean text-PDF → text / clean_text', () => {
    expect(decideExtractPath(base, cfg)).toEqual({ mode: 'text', reason: 'clean_text' });
  });

  it('scan engine (tesseract) → vision / scan_engine', () => {
    expect(decideExtractPath({ ...base, ocrEngine: 'tesseract' }, cfg)).toEqual({
      mode: 'vision',
      reason: 'scan_engine',
    });
  });

  it('vision-llm engine → vision / scan_engine', () => {
    expect(decideExtractPath({ ...base, ocrEngine: 'vision-llm' }, cfg)).toEqual({
      mode: 'vision',
      reason: 'scan_engine',
    });
  });

  it('image input → vision / scan_engine', () => {
    expect(decideExtractPath({ ...base, isImageInput: true }, cfg)).toEqual({
      mode: 'vision',
      reason: 'scan_engine',
    });
  });

  it('low OCR confidence → vision / low_ocr_conf', () => {
    expect(decideExtractPath({ ...base, ocrConfidence: 0.5 }, cfg)).toEqual({
      mode: 'vision',
      reason: 'low_ocr_conf',
    });
  });

  it('suspiciously short text for page count → vision / short_text', () => {
    // 2 страницы × 80 = 160 порог; 50 символов — мало.
    expect(decideExtractPath({ ...base, textLength: 50 }, cfg)).toEqual({
      mode: 'vision',
      reason: 'short_text',
    });
  });

  it('prefer_vision (per-type) overrides clean text → vision / prefer_vision', () => {
    expect(decideExtractPath({ ...base, preferVision: true }, cfg)).toEqual({
      mode: 'vision',
      reason: 'prefer_vision',
    });
  });

  it('forceImage on clean text → vision / forced_image', () => {
    expect(decideExtractPath({ ...base, forceImage: true }, cfg)).toEqual({
      mode: 'vision',
      reason: 'forced_image',
    });
  });

  it('forceText on a scan → text / forced_text (override beats everything)', () => {
    expect(
      decideExtractPath(
        { ...base, ocrEngine: 'tesseract', ocrConfidence: 0.2, forceText: true, forceImage: true },
        cfg,
      ),
    ).toEqual({ mode: 'text', reason: 'forced_text' });
  });

  it('prefer_vision beats scan_engine/low_conf in reason precedence', () => {
    expect(
      decideExtractPath({ ...base, preferVision: true, ocrEngine: 'tesseract' }, cfg),
    ).toEqual({ mode: 'vision', reason: 'prefer_vision' });
  });
});

describe('resolveVisionProviderId', () => {
  beforeEach(() => {
    findById.mockReset();
    findActiveVision.mockReset();
  });

  it('returns explicit id when row is active llm vision', async () => {
    findById.mockResolvedValue({ id: 'qwen-vl', kind: 'llm', is_active: true, vision: true });
    expect(await resolveVisionProviderId('qwen-vl', silentLog)).toBe('qwen-vl');
    expect(findActiveVision).not.toHaveBeenCalled();
  });

  it('falls back to auto-pick when explicit id is not vision', async () => {
    findById.mockResolvedValue({ id: 'phi4', kind: 'llm', is_active: true, vision: false });
    findActiveVision.mockResolvedValue({ id: 'auto-vl' });
    expect(await resolveVisionProviderId('phi4', silentLog)).toBe('auto-vl');
  });

  it('auto-picks when no explicit id given', async () => {
    findActiveVision.mockResolvedValue({ id: 'auto-vl' });
    expect(await resolveVisionProviderId(undefined, silentLog)).toBe('auto-vl');
    expect(findById).not.toHaveBeenCalled();
  });

  it('returns null when no vision provider exists (fail-soft)', async () => {
    findActiveVision.mockResolvedValue(null);
    expect(await resolveVisionProviderId(undefined, silentLog)).toBeNull();
  });

  it('returns null on repo error (fail-soft, no throw)', async () => {
    findActiveVision.mockRejectedValue(new Error('db down'));
    expect(await resolveVisionProviderId(undefined, silentLog)).toBeNull();
  });
});

describe('runDocumentPipeline — hybrid routing wiring', () => {
  beforeEach(() => {
    extractCalls.length = 0;
    currentForcedProvider = null;
    preferVisionFlag = false;
    findById.mockReset();
    findActiveVision.mockReset();
    findActiveVision.mockResolvedValue({ id: 'qwen-vl' });
  });

  it('clean text-PDF → text path, no image, default provider (not forced)', async () => {
    const post = await runDocumentPipeline(
      'long clean text body',
      { hint: 'commercial_invoice', imagePath: '/tmp/page.png', hybrid: { ...baseHybrid } },
      silentLog,
    );
    expect(post.extractMode).toBe('text');
    expect(post.routeReason).toBe('clean_text');
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0]!.imagePath).toBeUndefined();
    expect(extractCalls[0]!.forcedProviderId).toBeNull();
    expect(findActiveVision).not.toHaveBeenCalled();
  });

  it('scan (vision-llm engine) → vision path: forces vision provider + sends image', async () => {
    const post = await runDocumentPipeline(
      'noisy scan ocr text',
      {
        hint: 'commercial_invoice',
        imagePath: '/tmp/page.png',
        hybrid: { ...baseHybrid, ocrEngine: 'vision-llm', ocrConfidence: 0.4 },
      },
      silentLog,
    );
    expect(post.extractMode).toBe('image');
    expect(post.routeReason).toBe('scan_engine');
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0]!.imagePath).toBe('/tmp/page.png');
    expect(extractCalls[0]!.forcedProviderId).toBe('qwen-vl');
  });

  it('prefer_vision type on clean text → vision path', async () => {
    preferVisionFlag = true;
    const post = await runDocumentPipeline(
      'clean text',
      { hint: 'tax_invoice', imagePath: '/tmp/page.png', hybrid: { ...baseHybrid } },
      silentLog,
    );
    expect(post.extractMode).toBe('image');
    expect(post.routeReason).toBe('prefer_vision');
    expect(extractCalls[0]!.forcedProviderId).toBe('qwen-vl');
  });

  it('forceText overrides a scan → text path, no force provider', async () => {
    const post = await runDocumentPipeline(
      'scan',
      {
        hint: 'commercial_invoice',
        imagePath: '/tmp/page.png',
        hybrid: { ...baseHybrid, ocrEngine: 'tesseract', ocrConfidence: 0.2, forceText: true },
      },
      silentLog,
    );
    expect(post.extractMode).toBe('text');
    expect(post.routeReason).toBe('forced_text');
    expect(extractCalls[0]!.imagePath).toBeUndefined();
    expect(extractCalls[0]!.forcedProviderId).toBeNull();
  });

  it('vision wanted but provider unavailable → fail-soft to text (no throw, no image)', async () => {
    findActiveVision.mockResolvedValue(null); // no vision provider
    const post = await runDocumentPipeline(
      'scan',
      {
        hint: 'commercial_invoice',
        imagePath: '/tmp/page.png',
        hybrid: { ...baseHybrid, ocrEngine: 'tesseract', ocrConfidence: 0.3 },
      },
      silentLog,
    );
    // route_reason остаётся «почему хотели vision», но фактический режим — text.
    expect(post.routeReason).toBe('scan_engine');
    expect(post.extractMode).toBe('text');
    expect(extractCalls[0]!.imagePath).toBeUndefined();
    expect(extractCalls[0]!.forcedProviderId).toBeNull();
  });

  it('hybrid disabled (option absent) → legacy behavior: non-vision default → no image', async () => {
    const post = await runDocumentPipeline(
      'scan',
      { hint: 'commercial_invoice', imagePath: '/tmp/page.png' },
      silentLog,
    );
    // default provider supportsVision()=false, no force flag → text-only.
    expect(post.extractMode).toBe('text');
    expect(post.routeReason).toBeUndefined();
    expect(extractCalls[0]!.imagePath).toBeUndefined();
    expect(extractCalls[0]!.forcedProviderId).toBeNull();
    expect(findActiveVision).not.toHaveBeenCalled();
  });
});
