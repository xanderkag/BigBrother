/**
 * MTI-2 (§2.2): per-request override модели через AsyncLocalStorage реально
 * доходит до `body.model` inference-запроса.
 *
 * Покрытие (сеть/БД замоканы — undici.request + providerSettingsRepo):
 *   1. forced-provider + withModelOverride(alias) → body.model = резолвнутый name.
 *   2. forced-provider без override → default_model провайдера.
 *   3. forced-provider + custom (не в pack) → пробрасывается как есть.
 *   4. DEFAULT-провайдер (findDefault) + override → модель-агностичный TTL-кэш
 *      обходится, body.model = override (delegate cache-bypass).
 *   5. backward-compat: строка только с legacy model → body.model = legacy.
 *   6. hasModelOverride() + precedence: type-level применяется ТОЛЬКО когда
 *      job-level override НЕ активен.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

// undici замокан — перехватываем body без сети.
const requestMock = vi.fn(async () => ({
  statusCode: 200,
  body: {
    json: async () => ({ type: 'invoice', confidence: 0.9 }),
    text: async () => '',
  },
}));
vi.mock('undici', () => ({ request: (...a: unknown[]) => requestMock(...a) }));

const findByIdMock = vi.fn();
const findDefaultMock = vi.fn();
vi.mock('../src/storage/provider-settings.js', () => ({
  providerSettingsRepo: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    findDefault: (...a: unknown[]) => findDefaultMock(...a),
  },
}));

import { dynamicLlm } from '../src/pipeline/llm/provider-resolver.js';

type Row = Record<string, unknown>;

const ANTHROPIC: Row = {
  id: 'anthropic',
  kind: 'llm',
  base_url: 'http://inf:8000',
  api_key: 'k',
  vision: false,
  model: null,
  default_model: 'claude-sonnet-4-5',
  extra: null,
  models: [
    { name: 'claude-sonnet-4-5', alias: 'sonnet' },
    { name: 'claude-opus-4-7', alias: 'opus' },
    { name: 'claude-haiku-4-5', alias: 'haiku' },
  ],
};

/** Модель, реально ушедшая в последнем inference-запросе. */
function sentModel(): unknown {
  const call = requestMock.mock.calls.at(-1);
  const body = JSON.parse((call![1] as { body: string }).body);
  return body.model;
}

beforeEach(() => {
  requestMock.mockClear();
  findByIdMock.mockReset();
  findDefaultMock.mockReset();
  dynamicLlm.invalidate(); // сбросить TTL-кэш default-провайдера между тестами
});

describe('MTI-2: override модели доходит до body.model', () => {
  it('forced-provider + alias override → резолвнутый name', async () => {
    findByIdMock.mockResolvedValue(ANTHROPIC);
    await dynamicLlm.withForceProvider('anthropic', () =>
      dynamicLlm.withModelOverride('opus', () => dynamicLlm.classify('x')),
    );
    expect(sentModel()).toBe('claude-opus-4-7');
  });

  it('forced-provider без override → default_model провайдера', async () => {
    findByIdMock.mockResolvedValue(ANTHROPIC);
    await dynamicLlm.withForceProvider('anthropic', () => dynamicLlm.classify('x'));
    expect(sentModel()).toBe('claude-sonnet-4-5');
  });

  it('forced-provider + custom (не в pack) → как есть', async () => {
    findByIdMock.mockResolvedValue(ANTHROPIC);
    await dynamicLlm.withForceProvider('anthropic', () =>
      dynamicLlm.withModelOverride('claude-experimental-9', () => dynamicLlm.classify('x')),
    );
    expect(sentModel()).toBe('claude-experimental-9');
  });

  it('DEFAULT-провайдер + override → TTL-кэш обходится, уходит override', async () => {
    findDefaultMock.mockResolvedValue(ANTHROPIC);
    await dynamicLlm.withModelOverride('haiku', () => dynamicLlm.classify('x'));
    expect(sentModel()).toBe('claude-haiku-4-5');
  });

  it('backward-compat: строка только с legacy model → legacy уходит', async () => {
    findByIdMock.mockResolvedValue({
      id: 'local-phi4',
      kind: 'llm',
      base_url: 'http://inf:8000',
      api_key: null,
      vision: false,
      model: 'phi4',
      default_model: null,
      models: [],
      extra: null,
    });
    await dynamicLlm.withForceProvider('local-phi4', () => dynamicLlm.classify('x'));
    expect(sentModel()).toBe('phi4');
  });
});

describe('MTI-2: hasModelOverride + precedence (job > type)', () => {
  it('false вне scope, true внутри withModelOverride', async () => {
    expect(dynamicLlm.hasModelOverride()).toBe(false);
    await dynamicLlm.withModelOverride('opus', async () => {
      expect(dynamicLlm.hasModelOverride()).toBe(true);
    });
    expect(dynamicLlm.hasModelOverride()).toBe(false);
  });

  it('type-level применяется только когда job-level НЕ активен', async () => {
    // Реплика логики runDocumentPipeline: applyType = !!preferred && !hasOverride.
    const typePreferred = 'opus';
    // Вне job-override → type применяется.
    expect(!!typePreferred && !dynamicLlm.hasModelOverride()).toBe(true);
    // Внутри job-override → type НЕ применяется (job приоритетнее).
    await dynamicLlm.withModelOverride('haiku', async () => {
      expect(!!typePreferred && !dynamicLlm.hasModelOverride()).toBe(false);
    });
  });
});
