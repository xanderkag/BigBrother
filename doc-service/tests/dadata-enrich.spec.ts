/**
 * DaData enrich-стадия (party-by-INN).
 *
 * DadataClient замокан — сети не касаемся. Покрываем:
 *   - attach _enrichment.parties[inn] для seller + buyer
 *   - mismatch при расхождении названия
 *   - mismatch при статусе != ACTIVE (ликвидирован)
 *   - cache hit: второй вызов по тому же ИНН не ходит в клиент
 *   - fail-soft: client throws → extracted без изменений + ok=false, без throw
 *   - toggle off — гейт в orchestrator (здесь проверяем что enrichWithDadata
 *     при пустом extracted без party не плодит блок)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { enrichWithDadata, __resetEnrichCache } from '../src/pipeline/enrich/index.js';
import type { DadataClient, DadataParty } from '../src/pipeline/enrich/dadata.js';

const log = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const TTL = 60_000;

function party(overrides: Partial<DadataParty>): DadataParty {
  return {
    inn: null,
    kpp: null,
    ogrn: null,
    name_full: null,
    name_short: null,
    address: null,
    management_name: null,
    management_post: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

function makeClient(impl: (inn: string) => Promise<DadataParty | null>): {
  client: DadataClient;
  findByInn: ReturnType<typeof vi.fn>;
} {
  const findByInn = vi.fn(impl);
  const client = { isAvailable: () => true, findByInn } as unknown as DadataClient;
  return { client, findByInn };
}

beforeEach(() => {
  __resetEnrichCache();
  vi.clearAllMocks();
});

describe('enrichWithDadata', () => {
  it('attaches _enrichment.parties for seller + buyer', async () => {
    const { client, findByInn } = makeClient(async (inn) =>
      party({
        inn,
        name_short: inn === '7707083893' ? 'ООО Ромашка' : 'ООО Лютик',
        ogrn: '1027700132195',
        status: 'ACTIVE',
      }),
    );

    const extracted = {
      seller: { inn: '7707083893', name: 'ООО «Ромашка»' },
      buyer: { inn: '7728168971', name: 'ООО «Лютик»' },
    };

    const res = await enrichWithDadata(extracted, client, TTL, log);

    expect(res.ok).toBe(true);
    expect(findByInn).toHaveBeenCalledTimes(2);
    const block = res.extracted._enrichment as {
      parties: Record<string, DadataParty>;
      _meta: { provider: string; mismatches: string[] };
    };
    expect(block._meta.provider).toBe('dadata');
    expect(block.parties['7707083893']!.name_short).toBe('ООО Ромашка');
    expect(block.parties['7728168971']!.name_short).toBe('ООО Лютик');
    expect(block._meta.mismatches).toEqual([]);
    // Не перезаписали исходные поля.
    expect((res.extracted.seller as { name: string }).name).toBe('ООО «Ромашка»');
  });

  it('flags name mismatch against ЕГРЮЛ', async () => {
    const { client } = makeClient(async (inn) =>
      party({ inn, name_short: 'ООО Другое Имя', status: 'ACTIVE' }),
    );

    const res = await enrichWithDadata(
      { seller: { inn: '7707083893', name: 'ООО Совсем Не То' } },
      client,
      TTL,
      log,
    );

    const block = res.extracted._enrichment as { _meta: { mismatches: string[] } };
    expect(block._meta.mismatches.some((m) => m.includes('не совпадает'))).toBe(true);
  });

  it('flags non-ACTIVE status (liquidated)', async () => {
    const { client } = makeClient(async (inn) =>
      party({ inn, name_short: 'ООО Ромашка', status: 'LIQUIDATED' }),
    );

    const res = await enrichWithDadata(
      { seller: { inn: '7707083893', name: 'ООО Ромашка' } },
      client,
      TTL,
      log,
    );

    const block = res.extracted._enrichment as { _meta: { mismatches: string[] } };
    expect(block._meta.mismatches.some((m) => m.includes('ликвидирован'))).toBe(true);
  });

  it('cache hit: same INN across two calls fetches once', async () => {
    const { client, findByInn } = makeClient(async (inn) =>
      party({ inn, name_short: 'ООО Ромашка', status: 'ACTIVE' }),
    );

    const first = await enrichWithDadata(
      { seller: { inn: '7707083893', name: 'ООО Ромашка' } },
      client,
      TTL,
      log,
    );
    expect(first.lookups).toBe(1);

    const second = await enrichWithDadata(
      { buyer: { inn: '7707083893', name: 'ООО Ромашка' } },
      client,
      TTL,
      log,
    );
    expect(second.lookups).toBe(0);
    expect(findByInn).toHaveBeenCalledTimes(1);
    // Кэш всё равно отдал карточку во второй раз.
    const block = second.extracted._enrichment as { parties: Record<string, DadataParty> };
    expect(block.parties['7707083893']).toBeDefined();
  });

  it('fail-soft: client throws → extracted unchanged, ok=false, no throw', async () => {
    const { client } = makeClient(async () => {
      throw new Error('DaData 500: boom');
    });

    const extracted = { seller: { inn: '7707083893', name: 'ООО Ромашка' } };
    const res = await enrichWithDadata(extracted, client, TTL, log);

    expect(res.ok).toBe(false);
    expect(res.extracted).toBe(extracted); // тот же объект, без _enrichment
    expect(res.extracted._enrichment).toBeUndefined();
  });

  it('no parties → no _enrichment block, no lookups', async () => {
    const { client, findByInn } = makeClient(async () => party({}));
    const extracted = { number: 'INV-1', date: '2026-05-21' };

    const res = await enrichWithDadata(extracted, client, TTL, log);

    expect(res.ok).toBe(true);
    expect(res.lookups).toBe(0);
    expect(findByInn).not.toHaveBeenCalled();
    expect(res.extracted._enrichment).toBeUndefined();
  });

  it('flags INN not found in ЕГРЮЛ', async () => {
    const { client } = makeClient(async () => null);

    const res = await enrichWithDadata(
      { seller: { inn: '7707083893', name: 'ООО Ромашка' } },
      client,
      TTL,
      log,
    );

    const block = res.extracted._enrichment as {
      parties: Record<string, DadataParty>;
      _meta: { mismatches: string[] };
    };
    expect(block.parties['7707083893']).toBeUndefined();
    expect(block._meta.mismatches.some((m) => m.includes('не найден'))).toBe(true);
  });
});
