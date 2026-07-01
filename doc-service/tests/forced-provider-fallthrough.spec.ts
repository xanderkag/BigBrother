/**
 * TECH_DEBT M3: observability для silent forced-provider fallthrough.
 *
 * При плохом `metadata._force_provider_id` (несуществующий id / non-llm kind /
 * отсутствует base_url / ошибка lookup'а) роутинг молча падает на default-
 * провайдер. Раньше — ни лога, ни метрики. Теперь orchestrator заранее пробит
 * резолв (dynamicLlm.probeForceProvider) и, если он не проходит, пишет warn +
 * инкрементит counter. Поведение (fallthrough на default) НЕ меняется.
 *
 * Покрытие:
 *   1. probeForceProvider классифицирует каждую ветку отказа + happy-path/stub.
 *   2. Наблюдаемый блок orchestrator'а: warn с {reason, force_provider} + counter
 *      по reason, при этом withForceProvider всё равно выполняется (routing как
 *      раньше — резолвится default).
 *
 * БД/сети нет — providerSettingsRepo замокан на уровне модуля.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Минимум env для транзитивного config.ts.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import type { Logger } from 'pino';

const findByIdMock = vi.fn();

vi.mock('../src/storage/provider-settings.js', () => ({
  providerSettingsRepo: {
    findById: (...a: unknown[]) => findByIdMock(...a),
  },
}));

import { dynamicLlm } from '../src/pipeline/llm/provider-resolver.js';
import { registry, forcedProviderFallthroughTotal } from '../src/metrics.js';

type Row = {
  id: string;
  kind: string;
  base_url: string | null;
};

function row(patch: Partial<Row>): Row {
  return { id: 'p-1', kind: 'llm', base_url: 'http://llm:1', ...patch };
}

async function counterValue(reason: string): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === 'docservice_extractor_forced_provider_fallthrough_total');
  if (!m) return 0;
  const sample = (m.values as Array<{ value: number; labels: Record<string, string> }>).find(
    (v) => v.labels.reason === reason,
  );
  return sample?.value ?? 0;
}

beforeEach(() => {
  findByIdMock.mockReset();
});

describe('probeForceProvider — classifies fallthrough reasons', () => {
  it('not_found: repo returns null', async () => {
    findByIdMock.mockResolvedValue(null);
    expect(await dynamicLlm.probeForceProvider('missing-id')).toBe('not_found');
  });

  it('non_llm_kind: row exists but kind != llm', async () => {
    findByIdMock.mockResolvedValue(row({ kind: 'dadata' }));
    expect(await dynamicLlm.probeForceProvider('p-1')).toBe('non_llm_kind');
  });

  it('missing_base_url: llm row without base_url and no env fallback', async () => {
    findByIdMock.mockResolvedValue(row({ base_url: null }));
    // В тест-env LLM_INFERENCE_URL не задан → config.llm.url пуст → нет fallback.
    expect(await dynamicLlm.probeForceProvider('p-1')).toBe('missing_base_url');
  });

  it('lookup_error: repo throws', async () => {
    findByIdMock.mockRejectedValue(new Error('db down'));
    expect(await dynamicLlm.probeForceProvider('p-1')).toBe('lookup_error');
  });

  it('resolves OK (null): valid llm row with base_url', async () => {
    findByIdMock.mockResolvedValue(row({ base_url: 'http://llm:1' }));
    expect(await dynamicLlm.probeForceProvider('p-1')).toBeNull();
  });

  it("stub row resolves to a working Null client — NOT a fallthrough", async () => {
    findByIdMock.mockResolvedValue(row({ id: 'stub', base_url: null }));
    expect(await dynamicLlm.probeForceProvider('stub')).toBeNull();
  });
});

describe('orchestrator observability block — warn + counter, routing unchanged', () => {
  // Реплицирует наблюдаемый блок processJob'а: пробит id, при отказе — warn +
  // counter, затем ВСЕГДА выполняет withForceProvider (fallthrough на default).
  async function observeForcedProvider(
    log: Logger,
    forceProviderId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const fallthrough = await dynamicLlm.probeForceProvider(forceProviderId);
    if (fallthrough) {
      log.warn(
        { jobId: 'job-1', force_provider: forceProviderId, reason: fallthrough },
        'forced LLM provider did not resolve; falling through to default provider',
      );
      forcedProviderFallthroughTotal.inc({ reason: fallthrough });
    }
    await dynamicLlm.withForceProvider(forceProviderId, fn);
  }

  it('bad id → warn(reason,id) + counter++ while withForceProvider still runs', async () => {
    findByIdMock.mockResolvedValue(null); // not_found
    const warn = vi.fn();
    const log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as unknown as Logger;

    const before = await counterValue('not_found');
    let inner = false;
    await observeForcedProvider(log, 'ghost-id', async () => {
      inner = true; // withForceProvider всё равно выполняет обработку (default)
    });

    expect(inner).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx.reason).toBe('not_found');
    expect(ctx.force_provider).toBe('ghost-id');
    expect(String(msg)).toMatch(/falling through to default/);
    expect(await counterValue('not_found')).toBe(before + 1);
  });

  it('each reason increments the counter with its own label', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

    findByIdMock.mockResolvedValue(row({ kind: 'yandex_maps' }));
    const beforeNonLlm = await counterValue('non_llm_kind');
    await observeForcedProvider(log, 'p-1', async () => {});
    expect(await counterValue('non_llm_kind')).toBe(beforeNonLlm + 1);

    findByIdMock.mockResolvedValue(row({ base_url: null }));
    const beforeMissing = await counterValue('missing_base_url');
    await observeForcedProvider(log, 'p-1', async () => {});
    expect(await counterValue('missing_base_url')).toBe(beforeMissing + 1);
  });

  it('good id → no warn, no counter increment (still runs)', async () => {
    findByIdMock.mockResolvedValue(row({ base_url: 'http://llm:1' }));
    const warn = vi.fn();
    const log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as unknown as Logger;

    const before = await counterValue('not_found');
    let inner = false;
    await observeForcedProvider(log, 'p-1', async () => {
      inner = true;
    });

    expect(inner).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(await counterValue('not_found')).toBe(before);
  });
});
