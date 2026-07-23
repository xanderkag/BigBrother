/**
 * MTI-2 (§2.1): резолв эффективной модели + нормализация pack'а.
 *
 * Чистые функции, без БД/сети:
 *   - resolveEffectiveModel — приоритет job/type override → default_model →
 *     legacy model; alias→name; custom passthrough; backward-compat.
 *   - parseProviderModels — терпимость к мусору в JSONB.
 *
 * db.ts создаёт Pool на импорт, но НЕ коннектится до первого query — поэтому
 * импортировать модули напрямую безопасно (как в других unit-спеках).
 */
import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import {
  parseProviderModels,
  type ProviderSettingRow,
} from '../src/storage/provider-settings.js';
import { resolveEffectiveModel } from '../src/pipeline/llm/provider-resolver.js';

function row(patch: Partial<ProviderSettingRow>): ProviderSettingRow {
  return {
    id: 'p',
    kind: 'llm',
    display_name: 'P',
    description: null,
    base_url: 'http://llm:1',
    api_key: null,
    model: null,
    models: [],
    default_model: null,
    is_active: true,
    is_default: true,
    vision: false,
    extra: null,
    rates: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...patch,
  };
}

const ANTHROPIC_PACK = [
  { name: 'claude-sonnet-4-5', alias: 'sonnet' },
  { name: 'claude-opus-4-7', alias: 'opus' },
  { name: 'claude-haiku-4-5', alias: 'haiku' },
];

describe('resolveEffectiveModel — приоритет и alias (MTI-2 §2.1)', () => {
  it('нет override, есть только legacy model → backward-compat (старые строки)', () => {
    expect(resolveEffectiveModel(row({ model: 'phi4' }), undefined)).toBe('phi4');
  });

  it('default_model приоритетнее legacy model', () => {
    expect(
      resolveEffectiveModel(row({ model: 'phi4', default_model: 'qwen36-vllm' }), undefined),
    ).toBe('qwen36-vllm');
  });

  it('нет ни pack, ни default, ни legacy → undefined (inference берёт env-модель)', () => {
    expect(resolveEffectiveModel(row({}), undefined)).toBeUndefined();
  });

  it('override alias → резолвится в name из pack', () => {
    expect(
      resolveEffectiveModel(row({ models: ANTHROPIC_PACK, default_model: 'claude-sonnet-4-5' }), 'opus'),
    ).toBe('claude-opus-4-7');
  });

  it('override alias регистронезависим', () => {
    expect(resolveEffectiveModel(row({ models: ANTHROPIC_PACK }), 'OPUS')).toBe('claude-opus-4-7');
  });

  it('override точным name → остаётся как есть', () => {
    expect(resolveEffectiveModel(row({ models: ANTHROPIC_PACK }), 'claude-haiku-4-5')).toBe(
      'claude-haiku-4-5',
    );
  });

  it('override не-в-pack (custom) → пробрасывается как есть (§2.3 custom-input)', () => {
    expect(resolveEffectiveModel(row({ models: ANTHROPIC_PACK }), 'gpt-9-turbo')).toBe('gpt-9-turbo');
  });

  it('override приоритетнее default_model', () => {
    expect(
      resolveEffectiveModel(
        row({ models: ANTHROPIC_PACK, default_model: 'claude-sonnet-4-5' }),
        'haiku',
      ),
    ).toBe('claude-haiku-4-5');
  });

  it('пустая строка override трактуется как «нет override» → default_model', () => {
    expect(resolveEffectiveModel(row({ default_model: 'sonnet-x' }), '')).toBe('sonnet-x');
  });
});

describe('parseProviderModels — терпимость к мусору в JSONB', () => {
  it('не-массив → []', () => {
    expect(parseProviderModels(null)).toEqual([]);
    expect(parseProviderModels(undefined)).toEqual([]);
    expect(parseProviderModels({ name: 'x' })).toEqual([]);
    expect(parseProviderModels('phi4')).toEqual([]);
  });

  it('элементы без name отбрасываются', () => {
    expect(parseProviderModels([{ alias: 'a' }, { name: '' }, null, 42, { name: 'ok' }])).toEqual([
      { name: 'ok', alias: null, vision: false, cost_tier: null },
    ]);
  });

  it('нормализует alias/vision/cost_tier', () => {
    expect(
      parseProviderModels([
        { name: 'm1', alias: 'a1', vision: true, cost_tier: 'high' },
        { name: 'm2', alias: '', vision: 'yes', cost_tier: 'bogus' },
      ]),
    ).toEqual([
      { name: 'm1', alias: 'a1', vision: true, cost_tier: 'high' },
      { name: 'm2', alias: null, vision: false, cost_tier: null },
    ]);
  });
});
