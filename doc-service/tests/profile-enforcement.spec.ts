/**
 * Phase 3 (CP7) — per-org consumer profile enforcement.
 *
 * Три поведения профиля, добавленные в живой pipeline:
 *   A. classify_only — extract-стадия пропускается (тестируется напрямую
 *      через `runDocumentPipeline`, реальная shared surface).
 *   B. auto_approve_threshold — precedence для needs_review-решения.
 *   C. output routing — webhook vs pull, какой URL/секрет используется.
 *
 * `processJobInner` сильно завязан на БД/очередь/файловую систему, поэтому
 * decision-логика B и C тестируется на уровне чистых выражений (как уже
 * сделано для route-guard'а в organization-settings.spec.ts) — точные
 * выражения скопированы из orchestrator.ts. Маршрутизация доставки (C)
 * дополнительно проверяется на реальном `deliverFinalizedJobWebhook` с
 * замоканным `deliverWebhook`, чтобы убедиться что override URL/секрета
 * прокидываются в подпись.
 *
 * Покрытие vs integration:
 *   - covered (unit): classify_only через runDocumentPipeline; precedence
 *     выражения B/C; проброс override в deliverWebhook.
 *   - left for integration: полный processJobInner (OCR→finalize→webhook)
 *     с реальными БД/Redis — это integration smoke, не unit.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import pino from 'pino';

// LLM в "not configured" режиме (NullLlmClient) — как в pipeline-integration.
process.env.LLM_INFERENCE_URL = '';
process.env.YANDEX_VISION_API_KEY = '';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'global-secret';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const log = pino({ level: 'silent' });

const SAMPLE_TTN = `
  ТРАНСПОРТНАЯ НАКЛАДНАЯ № 555 от 10.04.2026

  Грузоотправитель: ООО "Логистика+", ИНН 7712345678
  Грузополучатель: ИП Иванов И.И., ИНН 771234567890
  Транспортное средство: МАЗ-5440, государственный номер А123БВ77
  Груз: Бытовая техника, 50 мест, брутто 2000 кг.
`;

const SAMPLE_INVOICE = `
  Счёт № 0042 от 15.03.2026 г.

  Поставщик: ООО "Ромашка"
  ИНН 7712345678 КПП 771201001
  Адрес: 125009, г. Москва, ул. Тверская, д. 1

  Покупатель: ООО "Василёк"
  ИНН 7798765432 КПП 779801001

  Наименование товара/услуги:
    1. Бумага А4 — 100 пачек × 250 руб = 25 000 руб
    2. Степлер — 5 шт × 500 руб = 2 500 руб

  Итого без НДС: 22 916,67
  НДС 20%: 4 583,33
  Итого к оплате: 27 500,00 руб.
`;

// ── A. classify_only ──────────────────────────────────────────────────────
describe('A. classify_only — extract stage skipped', () => {
  let runDocumentPipeline: typeof import('../src/pipeline/orchestrator.js').runDocumentPipeline;

  beforeAll(async () => {
    ({ runDocumentPipeline } = await import('../src/pipeline/orchestrator.js'));
  });

  it('returns documentType but empty extracted and no LLM call', async () => {
    const timings = { ocr_ms: 0, classify_ms: 0, extract_ms: 0, validate_ms: 0 };
    const r = await runDocumentPipeline(
      SAMPLE_TTN,
      { classifyOnly: true },
      log,
      {},
      timings,
    );

    expect(r.documentType).toBe('TTN');
    expect(r.classificationSource).toBe('keyword');
    // Extract пропущен: пусто, нет LLM-вызова, нет валидации.
    expect(r.extracted).toEqual({});
    expect(r.llmCall).toBeUndefined();
    expect(r.validationIssues).toEqual([]);
    expect(r.parserConfidence).toBeUndefined();
    // Парсер не гонялся → extract-таймер остался 0 (он выставляется только
    // внутри extract-ветки). Это машинно-различимый признак skip'а.
    expect(timings.extract_ms).toBe(0);
  });

  it('classify_only still honours hint (no classifier call needed)', async () => {
    const r = await runDocumentPipeline(SAMPLE_INVOICE, { hint: 'UPD', classifyOnly: true }, log);
    expect(r.documentType).toBe('UPD');
    expect(r.classificationSource).toBe('hint');
    expect(r.extracted).toEqual({});
    expect(r.llmCall).toBeUndefined();
  });

  it('extract mode (default) DOES run the parser — contrast with classify_only', async () => {
    // Invoice — Phase 1 regex-парсер, работает без LLM. Hint обходит
    // classifier (DB-зависим в unit-окружении), изолируя именно extract-ветку.
    // В обычном режиме extracted заполняется и parserConfidence > 0; в
    // classify_only при том же hint — пусто. Это и есть контраст.
    const r = await runDocumentPipeline(SAMPLE_INVOICE, { hint: 'invoice' }, log);
    expect(r.documentType).toBe('invoice');
    expect(r.extracted.number).toBe('0042');
    expect(r.parserConfidence).toBeGreaterThan(0);

    const rco = await runDocumentPipeline(
      SAMPLE_INVOICE,
      { hint: 'invoice', classifyOnly: true },
      log,
    );
    expect(rco.documentType).toBe('invoice');
    expect(rco.extracted).toEqual({});
    expect(rco.parserConfidence).toBeUndefined();
  });
});

// ── B. auto_approve_threshold precedence ────────────────────────────────────
describe('B. needs_review threshold precedence', () => {
  // Точное выражение из orchestrator.ts (держим в синхроне):
  //   per-type confidence_threshold ?? profile.auto_approve_threshold ?? global
  function resolveThreshold(
    perType: number | undefined,
    profileThreshold: number | null,
    globalDefault: number,
  ): number {
    return perType ?? profileThreshold ?? globalDefault;
  }

  // Статус-решение (validationIssues всегда форсят needs_review).
  function decideStatus(
    overall: number,
    threshold: number,
    issuesCount: number,
  ): 'done' | 'needs_review' {
    const lowConfidence = overall < threshold;
    const hasIssues = issuesCount > 0;
    return lowConfidence || hasIssues ? 'needs_review' : 'done';
  }

  const GLOBAL = 0.7;

  it('profile.auto_approve_threshold used when no per-type override', () => {
    const t = resolveThreshold(undefined, 0.5, GLOBAL);
    expect(t).toBe(0.5);
    expect(decideStatus(0.6, t, 0)).toBe('done'); // 0.6 >= 0.5
    expect(decideStatus(0.4, t, 0)).toBe('needs_review'); // 0.4 < 0.5
  });

  it('per-type override wins over profile threshold', () => {
    const t = resolveThreshold(0.9, 0.5, GLOBAL);
    expect(t).toBe(0.9);
    // confidence 0.6 теперь ниже per-type 0.9 → review (профиль 0.5 проигнорен).
    expect(decideStatus(0.6, t, 0)).toBe('needs_review');
  });

  it('falls back to global when neither set', () => {
    const t = resolveThreshold(undefined, null, GLOBAL);
    expect(t).toBe(GLOBAL);
    expect(decideStatus(0.75, t, 0)).toBe('done');
    expect(decideStatus(0.65, t, 0)).toBe('needs_review');
  });

  it('validation issues force needs_review regardless of threshold', () => {
    const t = resolveThreshold(undefined, 0.1, GLOBAL); // очень мягкий порог
    expect(decideStatus(0.99, t, 1)).toBe('needs_review');
  });

  it('threshold of 0 (profile) is honoured, not treated as unset (?? semantics)', () => {
    // ?? пропускает только null/undefined; 0 — валидное значение.
    const t = resolveThreshold(undefined, 0, GLOBAL);
    expect(t).toBe(0);
    expect(decideStatus(0, t, 0)).toBe('done'); // 0 < 0 == false
  });
});

// ── C. output routing precedence ────────────────────────────────────────────
describe('C. output routing — URL/secret precedence (pure decision)', () => {
  type Job = { webhook_url: string | null };
  type Profile = {
    output: 'webhook' | 'pull';
    webhook_url: string | null;
    has_webhook_secret: boolean;
  };

  // Решение: куда доставлять и каким секретом подписывать. Воспроизводит
  // ветвление в orchestrator.ts. 'global' = config.webhook.hmacSecret.
  function route(
    job: Job,
    profile: Profile,
  ): { deliver: boolean; url?: string; secret?: 'global' | 'profile' } {
    if (job.webhook_url) {
      return { deliver: true, url: job.webhook_url, secret: 'global' };
    }
    if (profile.output === 'webhook' && profile.webhook_url) {
      return {
        deliver: true,
        url: profile.webhook_url,
        secret: profile.has_webhook_secret ? 'profile' : 'global',
      };
    }
    return { deliver: false };
  }

  it('(a) explicit per-job webhook_url → global secret (backwards compat)', () => {
    const r = route(
      { webhook_url: 'https://job/hook' },
      { output: 'webhook', webhook_url: 'https://profile/hook', has_webhook_secret: true },
    );
    expect(r).toEqual({ deliver: true, url: 'https://job/hook', secret: 'global' });
  });

  it('(b) no job url, profile webhook + secret → profile url & profile secret', () => {
    const r = route(
      { webhook_url: null },
      { output: 'webhook', webhook_url: 'https://profile/hook', has_webhook_secret: true },
    );
    expect(r).toEqual({ deliver: true, url: 'https://profile/hook', secret: 'profile' });
  });

  it('(b2) profile webhook without secret → profile url, global secret (soft misconfig)', () => {
    const r = route(
      { webhook_url: null },
      { output: 'webhook', webhook_url: 'https://profile/hook', has_webhook_secret: false },
    );
    expect(r).toEqual({ deliver: true, url: 'https://profile/hook', secret: 'global' });
  });

  it('(c) output=pull → no delivery', () => {
    const r = route(
      { webhook_url: null },
      { output: 'pull', webhook_url: 'https://profile/hook', has_webhook_secret: true },
    );
    expect(r).toEqual({ deliver: false });
  });

  it('(c2) output=webhook but no url anywhere → no delivery', () => {
    const r = route(
      { webhook_url: null },
      { output: 'webhook', webhook_url: null, has_webhook_secret: false },
    );
    expect(r).toEqual({ deliver: false });
  });

  it('backwards compat: default profile (pull, no url) + no job url → no delivery', () => {
    const r = route(
      { webhook_url: null },
      { output: 'pull', webhook_url: null, has_webhook_secret: false },
    );
    expect(r).toEqual({ deliver: false });
  });
});

// ── C (delivery wiring): override URL/secret reach deliverWebhook ───────────
describe('C. deliverFinalizedJobWebhook passes override url/secret to deliverWebhook', () => {
  const deliverWebhookMock = vi.fn(async () => undefined);

  beforeAll(() => {
    vi.doMock('../src/webhooks/deliver.js', () => ({
      deliverWebhook: deliverWebhookMock,
      // webhook-delivery.ts также импортит computeTargetEntityHint (для
      // target_entity_hint в payload). Эти тесты проверяют только аргументы
      // deliverWebhook, поэтому хинт можно занулить — главное чтобы экспорт
      // существовал, иначе ESM-мок падает «No export defined».
      computeTargetEntityHint: vi.fn(() => null),
    }));
  });

  function makeJob(webhookUrl: string | null): import('../src/storage/jobs.js').JobRow {
    // Минимальный JobRow — поля, которые читает deliverFinalizedJobWebhook.
    return {
      id: 'job-1',
      status: 'done',
      document_type: 'invoice',
      confidence: '0.9',
      ocr_engine: 'pdf-text',
      extracted: { number: '0042' },
      metadata: null,
      error: null,
      webhook_url: webhookUrl,
      file_path: null,
    } as unknown as import('../src/storage/jobs.js').JobRow;
  }

  it('no override → uses job.webhook_url and default (global) secret', async () => {
    deliverWebhookMock.mockClear();
    vi.resetModules();
    const { deliverFinalizedJobWebhook } = await import('../src/pipeline/webhook-delivery.js');
    await deliverFinalizedJobWebhook(makeJob('https://job/hook'), 'job-1', log);

    expect(deliverWebhookMock).toHaveBeenCalledTimes(1);
    const args = deliverWebhookMock.mock.calls[0]!;
    expect(args[1]).toBe('https://job/hook'); // url
    expect(args[4]).toBeUndefined(); // hmacSecret override absent → deliverWebhook defaults to global
  });

  it('override → posts to override url with override secret', async () => {
    deliverWebhookMock.mockClear();
    vi.resetModules();
    const { deliverFinalizedJobWebhook } = await import('../src/pipeline/webhook-delivery.js');
    await deliverFinalizedJobWebhook(makeJob(null), 'job-1', log, {
      url: 'https://profile/hook',
      hmacSecret: 'profile-secret',
    });

    expect(deliverWebhookMock).toHaveBeenCalledTimes(1);
    const args = deliverWebhookMock.mock.calls[0]!;
    expect(args[1]).toBe('https://profile/hook');
    expect(args[4]).toBe('profile-secret');
  });
});
